"""Durable, integrity-checked evaluation ledger (DR-04).

An evaluation run is only trustworthy if its raw Agent answer survives before
a judge sees it and if a partial run cannot look complete. This module owns
the on-disk contract:

  <runs-root>/<run-id>/            unique per invocation, never reused
    manifest.json                  frozen plan (case/sample IDs) + run config
    environment.json               interpreter, packages, budgets, versions
    run_status.json                running / complete / incomplete + error
    samples/<sample-id>.json       one atomic, read-back-verified record
    summary.json                   single-writer projection of sample records
    summary.lock                   real portalocker lock for the summary

Guarantees:
  * every write is temp-file + fsync + ``os.replace`` followed by a read-back
    equality check, so a half-written JSON file is never published
  * the manifest is written once from an exclusive plan and is never rewritten
  * the summary is derived only from per-sample records; maintainers can
    rebuild it and a missing/truncated/corrupt row makes the run incomplete
  * only one writer builds the summary (lock + coordinator design); workers
    never touch ``summary.json``
  * no token, cookie, key or Authorization header is persisted
"""

from __future__ import annotations

import hashlib
import importlib.metadata as metadata
import json
import os
import platform
import re
import secrets
import subprocess
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence
from urllib.parse import urlsplit, urlunsplit

import portalocker

SCHEMA_VERSION = 1
TICKET = "DR-04"
SUMMARY_LOCK_TIMEOUT_S = 0

SAMPLE_STATUSES = frozenset(
    {"pending_judge", "scored", "judge_error", "agent_error", "skipped"}
)
JUDGE_STATUSES = frozenset({"pending", "scored", "error", "not_attempted", "skipped"})

SENSITIVE_ENV_NAME = re.compile(
    r"(API_?KEY|ACCESS_?TOKEN|AUTH_?TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE)",
    re.IGNORECASE,
)

# Headers and key/value pairs that must never reach an artifact. Applied to
# every error/diagnostic string before it is persisted.
_REDACTION_PATTERNS = (
    (re.compile(r"(?i)\b(bearer)\s+[A-Za-z0-9._~+/=-]{6,}"), r"\1 [REDACTED]"),
    (
        re.compile(r"(?i)\b(proxy-authorization|authorization)\s*:\s*[^\r\n]+"),
        r"\1: [REDACTED]",
    ),
    (re.compile(r"(?i)\b(set-cookie|cookie)\s*:\s*[^\r\n]+"), r"\1: [REDACTED]"),
    (
        re.compile(
            r"(?i)\b(api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|"
            r"client[_-]?secret|secret|password)\b\s*[:=]\s*"
            r"(\"[^\"]*\"|'[^']*'|[^\s,;]+)"
        ),
        r"\1=[REDACTED]",
    ),
)


class LedgerError(RuntimeError):
    """Base class for ledger contract violations."""


class LedgerSetupError(LedgerError):
    """The run directory or its frozen manifest could not be created."""


class SampleReadError(LedgerError):
    """A sample record is absent, truncated, corrupt or mis-identified."""


class SampleWriteError(LedgerError):
    """A sample record could not be persisted and read back intact."""


class SummaryError(LedgerError):
    """The single-writer summary could not be written and verified."""


class SummaryBusy(SummaryError):
    """Another writer currently owns the summary lock."""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def safe_url(url: Any) -> str:
    """Provenance-safe URL: drop userinfo, query and fragment (possible tokens)."""
    try:
        parts = urlsplit(str(url))
    except ValueError:
        return "[invalid-url]"
    host = parts.hostname or ""
    try:
        port = f":{parts.port}" if parts.port else ""
    except ValueError:
        port = ""
    netloc = f"{host}{port}"
    path = parts.path.rstrip("/")
    return urlunsplit((parts.scheme, netloc, path, "", ""))


def redact_text(text: Any, extra_values: Iterable[str] = ()) -> str:
    """Strip bearer tokens, cookies, keys and known secret values."""
    if text is None:
        return ""
    output = str(text)
    for value in extra_values:
        if value and len(value) >= 4:
            output = output.replace(value, "[REDACTED]")
    for pattern, replacement in _REDACTION_PATTERNS:
        output = pattern.sub(replacement, output)
    return output


class SecretScrubber:
    """Redactor seeded with credential-like environment values (never logged)."""

    def __init__(self, values: Iterable[str] = ()) -> None:
        self._values = tuple(sorted({v for v in values if v and len(v) >= 4}, key=len, reverse=True))

    @classmethod
    def from_environment(cls) -> "SecretScrubber":
        return cls(
            value
            for name, value in os.environ.items()
            if SENSITIVE_ENV_NAME.search(name)
        )

    def scrub(self, text: Any) -> str:
        return redact_text(text, self._values)


def _fsync_directory(path: Path) -> None:
    """Persist the rename itself where the platform supports it."""
    if os.name == "nt":  # opening a directory is not supported on Windows
        return
    try:
        handle = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(handle)
    except OSError:
        pass
    finally:
        os.close(handle)


def _atomic_write(path: Path, payload: Any) -> str:
    """Write JSON via temp + fsync + os.replace; return the file digest."""
    tmp = path.with_name(
        f".{path.name}.{os.getpid()}.{threading.get_ident()}.{secrets.token_hex(4)}.tmp"
    )
    try:
        with open(tmp, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
        _fsync_directory(path.parent)
        return sha256_file(path)
    finally:
        try:
            if tmp.exists():
                tmp.unlink()
        except OSError:
            pass


def _read_json(path: Path) -> Any:
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def _new_run_id() -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    return f"{stamp}-{secrets.token_hex(3)}"


def _dist_version(name: str) -> str | None:
    try:
        return metadata.version(name)
    except metadata.PackageNotFoundError:
        return None


def _git_versions(repo_root: Path | None) -> dict:
    root = repo_root or Path(__file__).resolve().parent.parent.parent
    result: dict[str, Any] = {"repo": str(root)}
    for key, args in (
        ("commit", ["rev-parse", "HEAD"]),
        ("branch", ["rev-parse", "--abbrev-ref", "HEAD"]),
    ):
        try:
            proc = subprocess.run(
                ["git", "-C", str(root), *args],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=10,
            )
            result[key] = proc.stdout.strip() if proc.returncode == 0 else "unavailable"
        except (OSError, subprocess.SubprocessError):
            result[key] = "unavailable"
    try:
        proc = subprocess.run(
            ["git", "-C", str(root), "status", "--porcelain"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=15,
        )
        result["dirty"] = bool(proc.stdout.strip()) if proc.returncode == 0 else None
    except (OSError, subprocess.SubprocessError):
        result["dirty"] = None
    return result


def build_environment_snapshot(
    *,
    suite_version: str,
    base_url: str,
    budgets: Mapping[str, Any],
    configuration: Mapping[str, Any] | None = None,
    repo_root: Path | None = None,
    env_allowlist: Sequence[str] = (),
) -> dict:
    """Dependency/budget/version snapshot with credential *names* only."""
    packages = {}
    for distribution in (
        "deepeval",
        "typesafe-sdk",
        "portalocker",
        "pywin32",
        "requests",
        "pytest",
    ):
        version = _dist_version(distribution)
        if version is not None:
            packages[distribution] = version

    requirements = Path(__file__).resolve().parent / "requirements.txt"
    lock = None
    if requirements.exists():
        lock = {
            "path": str(requirements),
            "sha256": sha256_file(requirements),
        }

    credential_names = sorted(
        name for name in os.environ if SENSITIVE_ENV_NAME.search(name)
    )
    relative_env = sorted(
        {
            "DEMO_OIDC_PASSWORD",
            "NEXUSRAG_BASE_URL",
            "NEXUSRAG_CHAT_TIMEOUT_S",
            "NEXUSRAG_EVAL_RUNS_DIR",
            "DEEPEVAL_TELEMETRY_OPT_OUT",
            "DEEPEVAL_NO_INSPECT_PROMPT",
            *env_allowlist,
        }
    )
    return {
        "schema_version": SCHEMA_VERSION,
        "ticket": TICKET,
        "captured_at": utc_now(),
        "suite_version": suite_version,
        "interpreter": {
            "version": sys.version.split()[0],
            "implementation": platform.python_implementation(),
            "executable": sys.executable,
            "prefix": sys.prefix,
            "in_venv": sys.prefix != sys.base_prefix,
        },
        "platform": {
            "system": platform.system(),
            "release": platform.release(),
            "machine": platform.machine(),
        },
        "packages": packages,
        "requirements_lock": lock,
        "run_version": _git_versions(repo_root),
        "configuration": {
            "base_url": safe_url(base_url),
            "budgets": dict(budgets),
            **dict(configuration or {}),
        },
        "environment": {
            "names_present": [
                name for name in relative_env if name in os.environ
            ],
            "credential_names_present": credential_names,
            "values_recorded": False,
        },
    }


class RunLedger:
    """One run directory: frozen manifest, per-sample records, summary."""

    def __init__(self, run_dir: Path, manifest: dict, manifest_digest: str) -> None:
        self.run_dir = run_dir
        self.manifest = manifest
        self.manifest_digest = manifest_digest
        self.run_id = manifest["run_id"]
        self._planned = {item["sample_id"]: item for item in manifest["planned"]}

    # -- construction ---------------------------------------------------
    @classmethod
    def create(
        cls,
        runs_root: str | Path,
        *,
        planned: Sequence[Mapping[str, Any]],
        manifest: Mapping[str, Any],
        environment: Mapping[str, Any],
    ) -> "RunLedger":
        root = Path(runs_root).resolve()
        try:
            root.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise LedgerSetupError(
                f"run root is not writable: {root}: {type(exc).__name__}: {exc}"
            ) from exc

        run_dir: Path | None = None
        for _attempt in range(8):
            candidate = root / _new_run_id()
            try:
                candidate.mkdir(parents=False, exist_ok=False)
            except FileExistsError:
                continue
            except OSError as exc:
                raise LedgerSetupError(
                    f"cannot create a unique run directory under {root}: "
                    f"{type(exc).__name__}: {exc}"
                ) from exc
            run_dir = candidate
            break
        if run_dir is None:
            raise LedgerSetupError(f"could not allocate a unique run directory under {root}")

        normalized_planned = []
        seen: set[str] = set()
        for item in planned:
            sample_id = str(item.get("sample_id") or "")
            case_id = str(item.get("case_id") or "")
            if not sample_id or not case_id:
                raise LedgerSetupError("planned items need sample_id and case_id")
            if sample_id in seen:
                raise LedgerSetupError(f"duplicate planned sample_id {sample_id!r}")
            seen.add(sample_id)
            normalized_planned.append(dict(item))
        if not normalized_planned:
            raise LedgerSetupError("refusing to start a run with an empty plan")

        manifest_payload = {
            "schema_version": SCHEMA_VERSION,
            "ticket": TICKET,
            "run_id": run_dir.name,
            "created_at": utc_now(),
            "frozen": True,
            "planned": normalized_planned,
            **{k: v for k, v in manifest.items() if k not in {"run_id", "planned"}},
        }

        try:
            (run_dir / "samples").mkdir()
            environment_path = run_dir / "environment.json"
            environment_digest = _atomic_write(environment_path, environment)
            reread_environment = _read_json(environment_path)
            if reread_environment != dict(environment):
                raise LedgerSetupError("environment snapshot did not read back intact")

            probe = run_dir / ".write-probe"
            nonce = secrets.token_hex(16)
            with open(probe, "w", encoding="utf-8") as handle:
                handle.write(nonce)
                handle.flush()
                os.fsync(handle.fileno())
            if probe.read_text(encoding="utf-8") != nonce:
                raise LedgerSetupError("run directory write/read probe failed")
            probe.unlink()

            manifest_payload["environment_file"] = "environment.json"
            manifest_payload["environment_sha256"] = environment_digest
            manifest_path = run_dir / "manifest.json"
            if manifest_path.exists():
                raise LedgerSetupError(f"manifest already exists in {run_dir}")
            digest = _atomic_write(manifest_path, manifest_payload)
            reread = _read_json(manifest_path)
            if reread != manifest_payload:
                raise LedgerSetupError("manifest did not read back intact")
        except OSError as exc:
            raise LedgerSetupError(
                f"run directory is not writable: {run_dir}: "
                f"{type(exc).__name__}: {exc}"
            ) from exc
        except json.JSONDecodeError as exc:
            raise LedgerSetupError(
                f"manifest read-back is not valid JSON: {run_dir}: {exc}"
            ) from exc

        return cls(run_dir, reread, digest)

    @classmethod
    def open(cls, run_dir: str | Path) -> "RunLedger":
        directory = Path(run_dir).resolve()
        manifest_path = directory / "manifest.json"
        try:
            raw = manifest_path.read_bytes()
            manifest = json.loads(raw.decode("utf-8"))
        except OSError as exc:
            raise LedgerSetupError(f"cannot read manifest at {manifest_path}: {exc}") from exc
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise LedgerSetupError(f"manifest is corrupt at {manifest_path}: {exc}") from exc
        if manifest.get("frozen") is not True:
            raise LedgerSetupError(f"manifest at {manifest_path} is not frozen")
        if manifest.get("run_id") != directory.name:
            raise LedgerSetupError(
                f"manifest run_id {manifest.get('run_id')!r} does not match directory "
                f"{directory.name!r}"
            )
        return cls(directory, manifest, sha256_bytes(raw))

    # -- paths ----------------------------------------------------------
    @property
    def samples_dir(self) -> Path:
        return self.run_dir / "samples"

    @property
    def summary_path(self) -> Path:
        return self.run_dir / "summary.json"

    def sample_path(self, sample_id: str) -> Path:
        if sample_id not in self._planned:
            raise SampleReadError(f"unknown planned sample_id {sample_id!r}")
        return self.samples_dir / f"{sample_id}.json"

    @property
    def planned_sample_ids(self) -> list[str]:
        return [item["sample_id"] for item in self.manifest["planned"]]

    # -- samples --------------------------------------------------------
    def _validate_record(self, data: dict, sample_id: str) -> None:
        if not isinstance(data, dict):
            raise SampleReadError(f"sample {sample_id!r} is not a JSON object")
        if data.get("run_id") != self.run_id:
            raise SampleReadError(f"sample {sample_id!r} belongs to another run")
        if data.get("sample_id") != sample_id:
            raise SampleReadError(f"sample {sample_id!r} carries another id")
        planned = self._planned[sample_id]
        if data.get("case_id") != planned["case_id"]:
            raise SampleReadError(f"sample {sample_id!r} carries another case_id")
        agent = data.get("agent")
        judge = data.get("judge")
        if not isinstance(agent, dict) or not isinstance(judge, dict):
            raise SampleReadError(f"sample {sample_id!r} lacks agent/judge objects")
        if data.get("status") not in SAMPLE_STATUSES:
            raise SampleReadError(f"sample {sample_id!r} has unknown status")
        if judge.get("status") not in JUDGE_STATUSES:
            raise SampleReadError(f"sample {sample_id!r} has unknown judge status")
        answer = agent.get("answer")
        digest = agent.get("answer_sha256")
        if isinstance(answer, str):
            if digest != sha256_text(answer):
                raise SampleReadError(
                    f"sample {sample_id!r} answer digest does not match its answer"
                )
        elif answer is not None:
            raise SampleReadError(f"sample {sample_id!r} answer is not text")

    def read_sample(self, sample_id: str) -> dict:
        path = self.sample_path(sample_id)
        try:
            raw = path.read_bytes()
        except OSError as exc:
            raise SampleReadError(f"sample {sample_id!r} is missing at {path}: {exc}") from exc
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise SampleReadError(f"sample {sample_id!r} is truncated/corrupt at {path}: {exc}") from exc
        self._validate_record(data, sample_id)
        return data

    def read_answer(self, sample_id: str) -> dict:
        data = self.read_sample(sample_id)
        agent = data["agent"]
        path = self.sample_path(sample_id)
        return {
            "sample_id": sample_id,
            "case_id": data["case_id"],
            "answer": agent.get("answer"),
            "answer_sha256": agent.get("answer_sha256"),
            "record_sha256": sha256_file(path),
            "written_at": data.get("written_at"),
        }

    def write_sample(self, record: Mapping[str, Any]) -> dict:
        sample_id = str(record.get("sample_id") or "")
        if sample_id not in self._planned:
            raise SampleWriteError(f"refusing to write unplanned sample {sample_id!r}")
        data = json.loads(json.dumps(record))
        data["schema_version"] = SCHEMA_VERSION
        data["run_id"] = self.run_id
        data["written_at"] = utc_now()
        agent = data.setdefault("agent", {})
        answer = agent.get("answer")
        if isinstance(answer, str):
            digest = sha256_text(answer)
            claimed = agent.get("answer_sha256")
            if claimed is not None and claimed != digest:
                raise SampleWriteError(
                    f"sample {sample_id!r} answer digest does not match the answer"
                )
            agent["answer_sha256"] = digest
        elif answer is None:
            agent["answer_sha256"] = None
        else:
            raise SampleWriteError(f"sample {sample_id!r} answer must be text or null")

        existing = None
        existing_path = self.samples_dir / f"{sample_id}.json"
        if existing_path.exists():
            try:
                existing = self.read_sample(sample_id)
            except SampleReadError as exc:
                raise SampleWriteError(
                    f"existing sample {sample_id!r} is unreadable; refusing to overwrite: {exc}"
                ) from exc
        if existing is not None:
            previous = existing.get("agent", {})
            if previous.get("answer") is not None and previous.get("answer") != answer:
                raise SampleWriteError(
                    f"sample {sample_id!r} answer identity changed between writes"
                )

        path = self.samples_dir / f"{sample_id}.json"
        try:
            self._validate_record(data, sample_id)
            _atomic_write(path, data)
            read_back = _read_json(path)
            self._validate_record(read_back, sample_id)
        except SampleReadError as exc:
            raise SampleWriteError(
                f"sample {sample_id!r} failed write validation: {exc}"
            ) from exc
        except OSError as exc:
            raise SampleWriteError(
                f"cannot persist sample {sample_id!r} at {path}: "
                f"{type(exc).__name__}: {exc}"
            ) from exc
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise SampleWriteError(
                f"sample {sample_id!r} did not read back as JSON at {path}: {exc}"
            ) from exc
        except TypeError as exc:
            raise SampleWriteError(
                f"sample {sample_id!r} is not JSON serializable: {exc}"
            ) from exc
        if read_back != data:
            raise SampleWriteError(f"sample {sample_id!r} read-back differs from what was written")
        return read_back

    # -- integrity + summary -------------------------------------------
    def scan(self) -> dict:
        planned = self.manifest["planned"]
        missing: list[str] = []
        corrupt: list[dict] = []
        unexpected: list[str] = []
        samples: list[dict] = []
        reasons: list[dict] = []
        counts = {
            "planned": len(planned),
            "persisted": 0,
            "scored": 0,
            "agent_errors": 0,
            "judge_errors": 0,
            "pending": 0,
        }

        try:
            present_files = {
                path.stem: path
                for path in self.samples_dir.glob("*.json")
                if path.is_file() and not path.name.startswith(".")
            }
        except OSError:
            present_files = {}
        planned_ids = {item["sample_id"] for item in planned}
        for extra in sorted(set(present_files) - planned_ids):
            unexpected.append(extra)
            reasons.append({"kind": "unexpected_sample", "sample_id": extra})

        for item in planned:
            sample_id = item["sample_id"]
            path = self.samples_dir / f"{sample_id}.json"
            if sample_id not in present_files or not path.exists():
                missing.append(sample_id)
                reasons.append({"kind": "missing_sample", "sample_id": sample_id})
                samples.append(
                    {
                        "sample_id": sample_id,
                        "case_id": item["case_id"],
                        "status": "not_started",
                        "score": None,
                    }
                )
                continue
            try:
                data = self.read_sample(sample_id)
            except SampleReadError as exc:
                corrupt.append({"sample_id": sample_id, "reason": str(exc)})
                reasons.append(
                    {
                        "kind": "corrupt_sample",
                        "sample_id": sample_id,
                        "detail": str(exc),
                    }
                )
                samples.append(
                    {
                        "sample_id": sample_id,
                        "case_id": item["case_id"],
                        "status": "corrupt",
                        "score": None,
                    }
                )
                continue

            counts["persisted"] += 1
            status = data["status"]
            judge = data["judge"]
            score = judge.get("score")
            summary_item = {
                "sample_id": sample_id,
                "case_id": item["case_id"],
                "status": status,
                "judge_status": judge.get("status"),
                "score": score,
                "answer_sha256": data["agent"].get("answer_sha256"),
                "metric": judge.get("metric"),
            }
            if status == "scored":
                if judge.get("status") != "scored" or not _is_score(score):
                    corrupt.append(
                        {
                            "sample_id": sample_id,
                            "reason": "scored row lacks a valid judge score",
                        }
                    )
                    reasons.append(
                        {
                            "kind": "corrupt_sample",
                            "sample_id": sample_id,
                            "detail": "scored row lacks a valid judge score",
                        }
                    )
                    summary_item["status"] = "corrupt"
                    summary_item["score"] = None
                else:
                    counts["scored"] += 1
            elif status == "judge_error":
                counts["judge_errors"] += 1
                summary_item["error"] = judge.get("error")
                reasons.append({"kind": "judge_error", "sample_id": sample_id})
            elif status == "agent_error":
                counts["agent_errors"] += 1
                summary_item["error"] = data["agent"].get("error")
                reasons.append({"kind": "agent_error", "sample_id": sample_id})
            elif status == "pending_judge":
                counts["pending"] += 1
                reasons.append({"kind": "judge_pending", "sample_id": sample_id})
            samples.append(summary_item)

        incomplete = bool(
            missing or corrupt or unexpected or counts["pending"] or not planned
        )
        if not planned:
            reasons.append({"kind": "empty_plan"})
        if counts["scored"] != len(planned):
            incomplete = True
        score = None
        if not incomplete:
            score = round(
                sum(item["score"] for item in samples if item["status"] == "scored")
                / counts["scored"],
                6,
            )

        return {
            **counts,
            "missing": missing,
            "corrupt": corrupt,
            "unexpected": unexpected,
            "samples": samples,
            "reasons": reasons,
            "incomplete": incomplete,
            "score": score,
        }

    def _summary_payload(self, report: dict) -> dict:
        return {
            "schema_version": SCHEMA_VERSION,
            "ticket": TICKET,
            "run_id": self.run_id,
            "generated_at": utc_now(),
            "manifest_sha256": self.manifest_digest,
            "environment_sha256": self.manifest.get("environment_sha256"),
            "planned": report["planned"],
            "persisted": report["persisted"],
            "scored": report["scored"],
            "agent_errors": report["agent_errors"],
            "judge_errors": report["judge_errors"],
            "not_started": len(report["missing"]),
            "pending": report["pending"],
            "missing": report["missing"],
            "corrupt": report["corrupt"],
            "unexpected": report["unexpected"],
            "incomplete": report["incomplete"],
            "score": report["score"],
            "reasons": report["reasons"],
            "samples": report["samples"],
        }

    def finalize(self) -> dict:
        """Build and write the single-writer summary, then read it back."""
        report = self.scan()
        payload = self._summary_payload(report)
        lock = portalocker.Lock(
            str(self.run_dir / "summary.lock"),
            mode="a",
            timeout=SUMMARY_LOCK_TIMEOUT_S,
            flags=portalocker.LOCK_EX | portalocker.LOCK_NB,
        )
        try:
            lock.acquire()
        except portalocker.exceptions.AlreadyLocked as exc:
            raise SummaryBusy(
                f"summary for run {self.run_id!r} is already being written"
            ) from exc
        except portalocker.exceptions.LockException as exc:
            raise SummaryError(
                f"cannot take the summary lock for run {self.run_id!r}: {exc}"
            ) from exc
        try:
            try:
                _atomic_write(self.summary_path, payload)
                read_back = _read_json(self.summary_path)
            except OSError as exc:
                raise SummaryError(
                    f"cannot write summary for run {self.run_id!r} at "
                    f"{self.summary_path}: {type(exc).__name__}: {exc}"
                ) from exc
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise SummaryError(
                    f"summary for run {self.run_id!r} did not read back as JSON: {exc}"
                ) from exc
            if read_back != payload:
                raise SummaryError(
                    f"summary for run {self.run_id!r} read-back differs from what was written"
                )
            return read_back
        finally:
            try:
                lock.release()
            except Exception:
                pass

    def write_run_state(self, state: str, *, error: str | None = None, score=None) -> None:
        payload = {
            "schema_version": SCHEMA_VERSION,
            "ticket": TICKET,
            "run_id": self.run_id,
            "state": state,
            "incomplete": state != "complete",
            "score": score if state == "complete" else None,
            "error": error,
            "written_at": utc_now(),
        }
        _atomic_write(self.run_dir / "run_status.json", payload)


def _is_score(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and 0 <= value <= 1
