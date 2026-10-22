"""One evaluation run through the real HTTP Agent, persisted before judging.

Usage (DR-04; DR-08 extends selection/reporting):

  python tests/evals/run_suite.py --case hard-04 --samples 1 \
      --judge path/to/judge.py:judge --runs-root .tmp/eval-runs

  python tests/evals/run_suite.py --rebuild .tmp/eval-runs/<run-id>

Contract:
  * the run plan (case/sample IDs) is frozen in ``manifest.json`` before the
    first HTTP request; every planned sample is accounted for in the summary
  * each sample uses a fresh session and POSTs JSON chat to
    ``NEXUSRAG_BASE_URL`` (default http://localhost:3001)
  * the raw Agent answer is written and read back *before* the judge is
    called; a judge failure keeps that answer and marks the run incomplete
  * any Agent/judge/write failure, missing/truncated/corrupt row or summary
    write failure yields score=null, ``incomplete`` and a non-zero exit
  * ``--rebuild`` recomputes the summary from per-sample records only

Exit codes: 0 complete, 1 run incomplete, 2 the run could not start or the
summary could not be written (both non-zero, both score=null).
"""

from __future__ import annotations

import argparse
import copy
import importlib
import importlib.util
import json
import os
import sys
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parent))

import requests

import ledger

TICKET = "DR-04"
SUITE_VERSION = "dr-04.1"
EXIT_OK = 0
EXIT_INCOMPLETE = 1
EXIT_FATAL = 2

EVAL_DIR = Path(__file__).resolve().parent
REPO_ROOT = EVAL_DIR.parent.parent
DEFAULT_DATASET = EVAL_DIR / ".dataset.json"
DEFAULT_RUNS_ROOT = REPO_ROOT / ".tmp" / "eval-runs"
DEFAULT_BASE_URL = "http://localhost:3001"
DEFAULT_CHAT_TIMEOUT_S = 300.0


class ChatError(RuntimeError):
    """The demo sign-in or the chat request failed."""


class JudgeError(RuntimeError):
    """The judge plugin could not run or returned an invalid verdict."""


@dataclass
class RunOutcome:
    exit_code: int
    run_dir: Path | None
    run_id: str | None
    summary: dict | None
    manifest: dict | None
    error: str | None = None
    run_errors: list[str] = field(default_factory=list)

    @property
    def score(self):
        return None if self.summary is None else self.summary.get("score")

    @property
    def incomplete(self) -> bool:
        if self.summary is not None:
            return bool(self.summary.get("incomplete"))
        return True

    def public_payload(self) -> dict:
        payload = {
            "ticket": TICKET,
            "exit_code": self.exit_code,
            "run_id": self.run_id,
            "run_dir": str(self.run_dir) if self.run_dir else None,
            "score": self.score,
            "incomplete": self.incomplete,
            "error": ledger.redact_text(self.error) if self.error else None,
        }
        if self.summary is not None:
            for key in (
                "planned",
                "persisted",
                "scored",
                "agent_errors",
                "judge_errors",
                "not_started",
                "pending",
            ):
                payload[key] = self.summary.get(key)
            payload["reasons"] = self.summary.get("reasons")
            payload["samples"] = self.summary.get("samples")
        elif self.manifest is not None:
            payload["planned"] = len(self.manifest.get("planned") or [])
        if self.run_errors:
            payload["run_errors"] = [ledger.redact_text(item) for item in self.run_errors]
        return payload


# ---------------------------------------------------------------------------
# credentials, dataset and judge plugins
# ---------------------------------------------------------------------------

def _dot_env(key: str) -> str:
    """Read one key from the repo-root .env without exposing other values."""
    for candidate in (REPO_ROOT / ".env", EVAL_DIR.parent.parent / ".env"):
        try:
            for line in candidate.read_text(encoding="utf-8").splitlines():
                if line.startswith(key + "="):
                    return line.split("=", 1)[1].strip()
        except OSError:
            continue
    return ""


def resolve_password(explicit: str | None = None) -> str:
    password = explicit or os.environ.get("DEMO_OIDC_PASSWORD") or _dot_env("DEMO_OIDC_PASSWORD")
    if not password:
        raise ChatError("DEMO_OIDC_PASSWORD is not set; cannot sign in to the demo tenant")
    return password


def load_dataset(path: str | Path) -> list[dict]:
    dataset_path = Path(path).resolve()
    try:
        data = json.loads(dataset_path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise ValueError(f"cannot read dataset {dataset_path}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"dataset {dataset_path} is not valid JSON: {exc}") from exc
    if not isinstance(data, list) or not data:
        raise ValueError(f"dataset {dataset_path} must be a non-empty list of cases")
    cases: list[dict] = []
    seen: set[str] = set()
    for index, item in enumerate(data):
        if not isinstance(item, dict):
            raise ValueError(f"dataset case #{index} is not an object")
        name = item.get("name")
        message = item.get("input")
        if not isinstance(name, str) or not name:
            raise ValueError(f"dataset case #{index} has no name")
        if not isinstance(message, str) or not message:
            raise ValueError(f"dataset case {name!r} has no input")
        if name in seen:
            raise ValueError(f"dataset contains duplicate case name {name!r}")
        seen.add(name)
        metadata = item.get("additional_metadata") or {}
        if not isinstance(metadata, dict):
            raise ValueError(f"dataset case {name!r} has non-object additional_metadata")
        scope = metadata.get("scope")
        if scope is not None and not isinstance(scope, list):
            raise ValueError(f"dataset case {name!r} has a non-list scope")
        cases.append(
            {
                "name": name,
                "input": message,
                "scope": scope,
                "kind": metadata.get("kind"),
            }
        )
    return cases


def select_cases(cases: Sequence[dict], selectors: Sequence[str] | None) -> list[dict]:
    if not selectors:
        return list(cases)
    wanted: list[dict] = []
    for selector in selectors:
        matches = [
            item
            for item in cases
            if item["name"] == selector or selector in item["name"]
        ]
        if not matches:
            raise ValueError(f"case selector {selector!r} matched no dataset case")
        for item in matches:
            if item not in wanted:
                wanted.append(item)
    return wanted


def load_judge(spec: str | Callable) -> tuple[Callable, str]:
    if callable(spec):
        return spec, getattr(spec, "__name__", "callable")
    if not isinstance(spec, str) or ":" not in spec:
        raise JudgeError("judge must be a callable or a 'module:function' / 'file.py:function' spec")
    target, _, attribute = spec.rpartition(":")
    if not target or not attribute:
        raise JudgeError(f"invalid judge spec {spec!r}")
    if target.endswith(".py") or "/" in target or "\\" in target:
        path = Path(target).resolve()
        if not path.exists():
            raise JudgeError(f"judge plugin file does not exist: {path}")
        module_name = f"_dr04_judge_{abs(hash(str(path)))}"
        module_spec = importlib.util.spec_from_file_location(module_name, path)
        if module_spec is None or module_spec.loader is None:
            raise JudgeError(f"cannot load judge plugin from {path}")
        module = importlib.util.module_from_spec(module_spec)
        module_spec.loader.exec_module(module)
    else:
        module = importlib.import_module(target)
    function = getattr(module, attribute, None)
    if not callable(function):
        raise JudgeError(f"judge spec {spec!r} does not resolve to a callable")
    return function, spec


def _is_score(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and 0 <= float(value) <= 1
    )


def _judge_scored(result: Any, scrubber: ledger.SecretScrubber, judge_name: str) -> dict:
    if isinstance(result, Mapping):
        score = result.get("score")
        if not _is_score(score):
            raise JudgeError("judge result needs a numeric score between 0 and 1")
        success = result.get("success")
        return {
            "status": "scored",
            "score": float(score),
            "metric": str(result.get("metric") or "unspecified"),
            "success": success if isinstance(success, bool) else None,
            "reason": scrubber.scrub(result.get("reason"))[:2000]
            if result.get("reason") is not None
            else None,
            "error": None,
            "judge": judge_name,
        }
    if _is_score(result):
        return {
            "status": "scored",
            "score": float(result),
            "metric": "unspecified",
            "success": None,
            "reason": None,
            "error": None,
            "judge": judge_name,
        }
    raise JudgeError("judge must return a score or a mapping with a score")


# ---------------------------------------------------------------------------
# HTTP client
# ---------------------------------------------------------------------------

class ChatClient:
    """Demo login + non-streaming JSON chat, one fresh session per sample."""

    def __init__(
        self,
        base_url: str,
        *,
        timeout_s: float,
        password: str | None,
        scrubber: ledger.SecretScrubber,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout_s = timeout_s
        self._password = password
        self._scrubber = scrubber
        self._token: str | None = None
        self._session = requests.Session()

    def ensure_login(self) -> None:
        if self._token is not None:
            return
        try:
            password = resolve_password(self._password)
        except ChatError:
            raise
        try:
            response = self._session.post(
                f"{self.base_url}/api/auth/login",
                json={"account": "admin", "password": password},
                timeout=min(30.0, self.timeout_s),
            )
        except requests.RequestException as exc:
            raise ChatError(
                f"demo sign-in request failed at {self.base_url}: "
                f"{self._scrubber.scrub(exc)}"
            ) from None
        if response.status_code != 200:
            raise ChatError(
                f"demo sign-in failed: HTTP {response.status_code}: "
                f"{self._scrubber.scrub(response.text[:300])}"
            )
        try:
            token = response.json().get("accessToken", "")
        except (ValueError, AttributeError):
            token = ""
        if not token:
            raise ChatError("demo sign-in returned no accessToken")
        self._token = token

    def chat(self, message: str, session_id: str, scope) -> dict:
        self.ensure_login()
        body: dict = {"message": message, "stream": False, "sessionId": session_id}
        if scope is not None:
            body["knowledgeBaseIds"] = scope
        started_at = ledger.utc_now()
        started = time.monotonic()
        try:
            response = self._session.post(
                f"{self.base_url}/api/chat",
                json=body,
                headers={"Authorization": f"Bearer {self._token}"},
                timeout=self.timeout_s,
            )
        except requests.RequestException as exc:
            raise ChatError(
                f"chat backend unreachable at {self.base_url}: "
                f"{self._scrubber.scrub(exc)}"
            ) from None
        finished_at = ledger.utc_now()
        duration_ms = int((time.monotonic() - started) * 1000)
        if response.status_code != 200:
            raise ChatError(
                f"chat backend returned HTTP {response.status_code}: "
                f"{self._scrubber.scrub(response.text[:500])}"
            )
        try:
            payload = response.json()
        except ValueError as exc:
            raise ChatError(f"chat backend returned non-JSON: {exc}") from None
        if not isinstance(payload, dict):
            raise ChatError("chat backend returned a non-object JSON body")
        return {
            "payload": payload,
            "http_status": response.status_code,
            "started_at": started_at,
            "finished_at": finished_at,
            "duration_ms": duration_ms,
        }


# ---------------------------------------------------------------------------
# plan + execution
# ---------------------------------------------------------------------------

def build_plan(
    selected: Sequence[dict], samples_per_case: int
) -> list[dict]:
    planned: list[dict] = []
    for ordinal, item in enumerate(selected):
        for index in range(samples_per_case):
            planned.append(
                {
                    "sample_id": f"{ordinal:03d}-{item['name']}-s{index}",
                    "case_id": item["name"],
                    "case_ordinal": ordinal,
                    "sample_index": index,
                    "input": item["input"],
                    "input_sha256": ledger.sha256_text(item["input"]),
                    "scope": item["scope"],
                }
            )
    return planned


def _agent_record(
    planned: Mapping[str, Any],
    session_id: str,
    base_url: str,
    *,
    request_body: dict,
    result: dict | None = None,
    error: Any = None,
) -> dict:
    agent: dict[str, Any] = {
        "request": {
            "message": planned["input"],
            "session_id": session_id,
            "stream": False,
            "scope": planned["scope"],
            "base_url": base_url,
            "body": request_body,
        },
        "answer": None,
        "references": [],
        "http_status": None,
        "backend_run_id": None,
        "backend_status": None,
        "started_at": None,
        "finished_at": None,
        "duration_ms": None,
        "error": None,
    }
    if result is not None:
        payload = result["payload"]
        agent.update(
            {
                "answer": payload.get("reply"),
                "references": payload.get("references") or [],
                "raw_payload": payload,
                "http_status": result["http_status"],
                "backend_run_id": payload.get("runId"),
                "backend_status": payload.get("status"),
                "started_at": result["started_at"],
                "finished_at": result["finished_at"],
                "duration_ms": result["duration_ms"],
            }
        )
    if error is not None:
        agent["error"] = error
    return {
        "sample_id": planned["sample_id"],
        "case_id": planned["case_id"],
        "sample_index": planned["sample_index"],
        "session_id": session_id,
        "planned": {
            "input_sha256": planned["input_sha256"],
            "scope": planned["scope"],
        },
        "agent": agent,
        "judge": {"status": "not_attempted", "score": None, "error": None},
        "status": "agent_error" if error is not None else "pending_judge",
        "error": error,
    }


def _judge_context(ledger_instance: ledger.RunLedger, sample_id: str) -> dict:
    return {
        "run_id": ledger_instance.run_id,
        "run_dir": str(ledger_instance.run_dir),
        "sample_id": sample_id,
        "sample_path": str(ledger_instance.sample_path(sample_id)),
        "read_answer": lambda: ledger_instance.read_answer(sample_id),
    }


def execute_run(
    runs_root: str | Path = DEFAULT_RUNS_ROOT,
    *,
    dataset_path: str | Path = DEFAULT_DATASET,
    cases: Sequence[str] | None = None,
    samples: int = 1,
    judge: str | Callable,
    base_url: str | None = None,
    password: str | None = None,
    chat_timeout_s: float | None = None,
    suite_version: str = SUITE_VERSION,
    repo_root: Path | None = None,
) -> RunOutcome:
    """Run the frozen plan once, persisting answers before judging."""
    scrubber = ledger.SecretScrubber.from_environment()
    if samples < 1:
        return RunOutcome(EXIT_FATAL, None, None, None, None, "samples must be >= 1")

    base_url = (base_url or os.environ.get("NEXUSRAG_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
    timeout_s = (
        float(chat_timeout_s)
        if chat_timeout_s is not None
        else float(os.environ.get("NEXUSRAG_CHAT_TIMEOUT_S", DEFAULT_CHAT_TIMEOUT_S))
    )

    try:
        all_cases = load_dataset(dataset_path)
        selected = select_cases(all_cases, cases)
        judge_fn, judge_name = load_judge(judge)
    except Exception as exc:  # includes ImportError from a bad plugin spec
        return RunOutcome(EXIT_FATAL, None, None, None, None, scrubber.scrub(exc))

    planned = build_plan(selected, samples)
    dataset_path = Path(dataset_path).resolve()
    try:
        dataset_digest = ledger.sha256_file(dataset_path)
    except OSError as exc:
        return RunOutcome(EXIT_FATAL, None, None, None, None, f"cannot hash dataset: {exc}")

    budgets = {
        "samples_per_case": samples,
        "planned_samples": len(planned),
        "chat_timeout_s": timeout_s,
        "summary_lock_timeout_s": ledger.SUMMARY_LOCK_TIMEOUT_S,
        "judge_attempts": 1,
    }
    environment = ledger.build_environment_snapshot(
        suite_version=suite_version,
        base_url=ledger.safe_url(base_url),
        budgets=budgets,
        configuration={
            "dataset_sha256": dataset_digest,
            "dataset_path": str(dataset_path),
            "judge": judge_name,
            "cases": [item["name"] for item in selected],
            "samples_per_case": samples,
        },
        repo_root=repo_root,
    )
    manifest = {
        "suite": {"name": "nexusrag-deepeval", "version": suite_version},
        "dataset": {
            "path": str(dataset_path),
            "sha256": dataset_digest,
            "case_count_total": len(all_cases),
        },
        "selection": {
            "cases": [item["name"] for item in selected],
            "samples_per_case": samples,
        },
        "run": {
            "base_url": ledger.safe_url(base_url),
            "chat_timeout_s": timeout_s,
            "judge": judge_name,
            "workers": 1,
        },
    }

    try:
        run_ledger = ledger.RunLedger.create(
            runs_root,
            planned=planned,
            manifest=manifest,
            environment=environment,
        )
    except ledger.LedgerSetupError as exc:
        return RunOutcome(EXIT_FATAL, None, None, None, None, scrubber.scrub(exc))

    outcome = RunOutcome(
        EXIT_INCOMPLETE,
        run_ledger.run_dir,
        run_ledger.run_id,
        None,
        run_ledger.manifest,
    )
    try:
        run_ledger.write_run_state("running")
    except OSError as exc:
        outcome.exit_code = EXIT_FATAL
        outcome.error = scrubber.scrub(f"cannot record run state: {exc}")
        return outcome

    client = ChatClient(
        base_url,
        timeout_s=timeout_s,
        password=password,
        scrubber=scrubber,
    )
    login_error: str | None = None
    try:
        client.ensure_login()
    except ChatError as exc:
        login_error = scrubber.scrub(exc)

    write_failure: str | None = None
    for planned_item in planned:
        session_id = str(uuid.uuid4())
        request_body: dict = {
            "message": planned_item["input"],
            "stream": False,
            "sessionId": session_id,
        }
        if planned_item["scope"] is not None:
            request_body["knowledgeBaseIds"] = planned_item["scope"]

        record: dict | None = None
        if login_error is not None:
            record = _agent_record(
                planned_item,
                session_id,
                ledger.safe_url(base_url),
                request_body=request_body,
                error=login_error,
            )
        else:
            try:
                result = client.chat(
                    planned_item["input"], session_id, planned_item["scope"]
                )
                reply = result["payload"].get("reply")
                if not isinstance(reply, str) or not reply.strip():
                    raise ChatError(
                        f"chat backend returned an empty reply: "
                        f"{scrubber.scrub(result['payload'])}"[:500]
                    )
                record = _agent_record(
                    planned_item,
                    session_id,
                    ledger.safe_url(base_url),
                    request_body=request_body,
                    result=result,
                )
            except ChatError as exc:
                record = _agent_record(
                    planned_item,
                    session_id,
                    ledger.safe_url(base_url),
                    request_body=request_body,
                    error=scrubber.scrub(exc),
                )

        try:
            stored = run_ledger.write_sample(record)
        except ledger.SampleWriteError as exc:
            write_failure = scrubber.scrub(exc)
            outcome.run_errors.append(write_failure)
            break

        if stored["status"] == "agent_error":
            continue

        context = _judge_context(run_ledger, planned_item["sample_id"])
        started_at = ledger.utc_now()
        started = time.monotonic()
        try:
            verdict = _judge_scored(
                judge_fn(copy.deepcopy(stored), context), scrubber, judge_name
            )
            verdict.update(
                {
                    "started_at": started_at,
                    "finished_at": ledger.utc_now(),
                    "duration_ms": int((time.monotonic() - started) * 1000),
                }
            )
            stored["status"] = "scored"
        except Exception as exc:  # judge failure must keep the saved answer
            stored["status"] = "judge_error"
            verdict = {
                "status": "error",
                "score": None,
                "metric": None,
                "success": None,
                "reason": None,
                "error": scrubber.scrub(f"{type(exc).__name__}: {exc}")[:2000],
                "judge": judge_name,
                "started_at": started_at,
                "finished_at": ledger.utc_now(),
                "duration_ms": int((time.monotonic() - started) * 1000),
            }
        stored["judge"] = verdict
        if stored["status"] == "judge_error":
            stored["error"] = verdict["error"]
        try:
            run_ledger.write_sample(stored)
        except ledger.SampleWriteError as exc:
            write_failure = scrubber.scrub(exc)
            outcome.run_errors.append(write_failure)
            break

    if write_failure is not None:
        outcome.error = write_failure
    try:
        summary = run_ledger.finalize()
    except ledger.SummaryError as exc:
        outcome.exit_code = EXIT_FATAL
        outcome.error = scrubber.scrub(exc)
        try:
            run_ledger.write_run_state(
                "incomplete", error=f"summary write failed: {outcome.error}", score=None
            )
        except OSError:
            pass
        return outcome

    outcome.summary = summary
    outcome.exit_code = EXIT_INCOMPLETE if summary["incomplete"] else EXIT_OK
    state_error = outcome.error
    if state_error is None and summary["incomplete"] and summary.get("reasons"):
        state_error = json.dumps(summary["reasons"][:5], ensure_ascii=False)
    try:
        run_ledger.write_run_state(
            "incomplete" if summary["incomplete"] else "complete",
            error=state_error,
            score=summary["score"],
        )
    except OSError as exc:
        outcome.run_errors.append(scrubber.scrub(f"cannot record final run state: {exc}"))
    return outcome


def rebuild_run(run_dir: str | Path) -> RunOutcome:
    """Recompute the summary from sample records without touching samples."""
    scrubber = ledger.SecretScrubber.from_environment()
    directory = Path(run_dir).resolve()
    try:
        run_ledger = ledger.RunLedger.open(directory)
    except ledger.LedgerSetupError as exc:
        return RunOutcome(EXIT_FATAL, directory, None, None, None, scrubber.scrub(exc))
    try:
        summary = run_ledger.finalize()
    except ledger.SummaryError as exc:
        outcome = RunOutcome(
            EXIT_FATAL,
            directory,
            run_ledger.run_id,
            None,
            run_ledger.manifest,
            scrubber.scrub(exc),
        )
        try:
            run_ledger.write_run_state(
                "incomplete", error=f"summary write failed: {outcome.error}", score=None
            )
        except OSError:
            pass
        return outcome
    outcome = RunOutcome(
        EXIT_INCOMPLETE if summary["incomplete"] else EXIT_OK,
        directory,
        run_ledger.run_id,
        summary,
        run_ledger.manifest,
    )
    try:
        run_ledger.write_run_state(
            "incomplete" if summary["incomplete"] else "complete",
            error=None,
            score=summary["score"],
        )
    except OSError as exc:
        outcome.run_errors.append(scrubber.scrub(f"cannot record run state: {exc}"))
    return outcome


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _split_selectors(values: Sequence[str] | None) -> list[str]:
    selectors: list[str] = []
    for value in values or ():
        for part in value.split(","):
            part = part.strip()
            if part:
                selectors.append(part)
    return selectors


def _print_payload(payload: dict, json_out: str | None) -> None:
    text = json.dumps(payload, ensure_ascii=False)
    print(text, flush=True)
    if json_out:
        path = Path(json_out).resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Run or rebuild one durable NexusRAG evaluation run (DR-04)"
    )
    parser.add_argument("--runs-root", default=str(DEFAULT_RUNS_ROOT))
    parser.add_argument("--dataset", default=str(DEFAULT_DATASET))
    parser.add_argument(
        "--case",
        action="append",
        help="case name or substring (repeatable, comma-separated; default: all)",
    )
    parser.add_argument(
        "--samples", type=int, default=1, help="independent samples per selected case"
    )
    parser.add_argument(
        "--judge",
        help="judge plugin as module:function or file.py:function (required for a run)",
    )
    parser.add_argument("--base-url", default=None)
    parser.add_argument("--timeout", type=float, default=None)
    parser.add_argument(
        "--rebuild", metavar="RUN_DIR", help="rebuild summary.json from sample records"
    )
    parser.add_argument("--json-out", default=None)
    args = parser.parse_args(argv)

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    if args.rebuild:
        outcome = rebuild_run(args.rebuild)
        payload = outcome.public_payload()
        _print_payload(payload, args.json_out)
        if outcome.run_errors:
            for item in outcome.run_errors:
                print(f"[run-suite] warning: {item}", file=sys.stderr, flush=True)
        if outcome.exit_code != EXIT_OK:
            print(
                f"[run-suite] run incomplete: {payload.get('error') or payload.get('reasons')}",
                file=sys.stderr,
                flush=True,
            )
        return outcome.exit_code

    if not args.judge:
        parser.error("--judge is required for a new run (use --rebuild to reuse samples)")
    outcome = execute_run(
        args.runs_root,
        dataset_path=args.dataset,
        cases=_split_selectors(args.case),
        samples=args.samples,
        judge=args.judge,
        base_url=args.base_url,
        chat_timeout_s=args.timeout,
    )
    payload = outcome.public_payload()
    _print_payload(payload, args.json_out)
    for item in outcome.run_errors:
        print(f"[run-suite] warning: {item}", file=sys.stderr, flush=True)
    if outcome.exit_code != EXIT_OK:
        print(
            f"[run-suite] run incomplete: {payload.get('error') or payload.get('reasons')}",
            file=sys.stderr,
            flush=True,
        )
    return outcome.exit_code


if __name__ == "__main__":
    raise SystemExit(main())
