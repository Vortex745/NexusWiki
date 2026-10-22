"""Fail-closed preflight for the isolated DeepEval runtime (DR-02).

Why this exists: an evaluation run that cannot take its real Windows file
lock, or cannot write and re-read its result file, must never start making
external eval requests. Importing the locked dependencies is necessary but
not sufficient evidence.

Contract (all steps run before any eval request):
  1. interpreter      - CPython 3.12 (the parser's 3.14 runtime is untouched)
  2. imports          - deepeval 4.2.8, typesafe-sdk 0.7.4, portalocker, pytest
  3. lock_implementation - the installed portalocker (no local shim), the
                        locker DeepEval actually uses, and a working
                        pywin32-backed Win32Locker
  4. file_lock        - real acquisition and in-process contention
  5. write_readback   - write + fsync + read-back of a nonce file
  6. mutual_exclusion - two real child processes contend for the same lock;
                        the contender must NOT acquire while the holder owns it

Run:
  .venv-evals/Scripts/python.exe tests/evals/preflight.py

Exit codes: 0 ready, 1 preflight failed (fail closed), 3 probe found the lock
held by another process, 4 probe/internal error. Probe mode is internal and is
also used by tests/evals/test_runtime_contracts.py.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib
import importlib.metadata as metadata
import json
import os
import platform
import secrets
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

TICKET = "DR-02"
REQUIRED_PYTHON = (3, 12)
FIXED_DISTRIBUTIONS = {
    "deepeval": "4.2.8",
    "typesafe-sdk": "0.7.4",
}
REQUIRED_MODULES = ("deepeval", "typesafe_sdk", "portalocker", "pytest", "requests")

EXIT_OK = 0
EXIT_PREFLIGHT_FAILED = 1
EXIT_LOCK_HELD = 3
EXIT_PROBE_ERROR = 4


class PreflightError(RuntimeError):
    def __init__(self, step: str, message: str) -> None:
        super().__init__(message)
        self.step = step


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _write_json_atomic(path: Path, payload: dict) -> None:
    """Persist JSON and fsync before an atomic replace, so readers never see half."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)


def _dist_version(name: str) -> str:
    return metadata.version(name)


def _configure_deepeval_sandbox(workdir: Path) -> None:
    """Keep preflight imports out of the repo and off the network."""
    os.environ.setdefault("DEEPEVAL_TELEMETRY_OPT_OUT", "YES")
    os.environ.setdefault("DEEPEVAL_NO_INSPECT_PROMPT", "1")
    os.environ["DEEPEVAL_CACHE_FOLDER"] = str(workdir / "deepeval-cache")
    os.environ["DEEPEVAL_HOME"] = str(workdir / "deepeval-home")


def check_interpreter() -> dict:
    actual = sys.version_info[:2]
    if actual != REQUIRED_PYTHON:
        raise PreflightError(
            "interpreter",
            f"Python {REQUIRED_PYTHON[0]}.{REQUIRED_PYTHON[1]} is required for evals; "
            f"running {sys.version.split()[0]} at {sys.executable}. "
            "Use .venv-evals/Scripts/python.exe, not the parser's main interpreter.",
        )
    return {
        "ok": True,
        "version": sys.version.split()[0],
        "implementation": platform.python_implementation(),
        "executable": sys.executable,
        "prefix": sys.prefix,
        "in_venv": sys.prefix != sys.base_prefix,
    }


def check_imports() -> dict:
    packages: dict[str, str] = {}
    modules: dict[str, str] = {}
    for name in REQUIRED_MODULES:
        try:
            module = importlib.import_module(name)
        except Exception as exc:  # pragma: no cover - depends on environment
            raise PreflightError(
                "imports", f"cannot import {name!r} in this interpreter: {exc}"
            ) from exc
        modules[name] = str(Path(getattr(module, "__file__", "")).resolve())

    for distribution, expected in FIXED_DISTRIBUTIONS.items():
        try:
            packages[distribution] = _dist_version(distribution)
        except metadata.PackageNotFoundError as exc:
            raise PreflightError(
                "imports", f"locked distribution {distribution!r} is not installed"
            ) from exc
        if packages[distribution] != expected:
            raise PreflightError(
                "imports",
                f"{distribution} must be {expected}; found {packages[distribution]}",
            )

    if sys.platform == "win32":
        try:
            import win32file  # noqa: F401
        except Exception as exc:
            raise PreflightError(
                "imports", f"pywin32 is required for real Win32 locks: {exc}"
            ) from exc
        packages["pywin32"] = _dist_version("pywin32")

    for distribution in ("portalocker", "pytest", "requests"):
        packages[distribution] = _dist_version(distribution)

    return {"ok": True, "packages": packages, "modules": modules}


def check_lock_implementation(workdir: Path) -> dict:
    import portalocker
    from portalocker.portalocker import Win32Locker

    module_path = Path(portalocker.__file__).resolve()
    prefix = Path(sys.prefix).resolve()
    under_prefix = module_path.is_relative_to(prefix)
    no_shim = under_prefix and "site-packages" in module_path.parts
    if not no_shim:
        raise PreflightError(
            "lock_implementation",
            f"portalocker resolves to {module_path}, outside {prefix}/site-packages; "
            "a local shim cannot be used for eval locking",
        )

    # DeepEval must import the same installed portalocker, not a shim and not
    # the read-only fallback where local_store imports no locker at all.
    local_store = importlib.import_module("deepeval.evaluate.local_store")
    if getattr(local_store, "portalocker", None) is not portalocker:
        raise PreflightError(
            "lock_implementation",
            "DeepEval did not import the installed portalocker (read-only env or shim); "
            "result persistence would not be locked",
        )

    # Prove the pywin32 path really works: two handles cannot hold the same
    # range, and release must make the file available again.
    probe_path = workdir / "win32-locker-selfcheck.lock"
    win32_excludes_second_handle = False
    with open(probe_path, "a", encoding="utf-8") as first:
        locker = Win32Locker()
        locker.lock(first, portalocker.LOCK_EX | portalocker.LOCK_NB)
        try:
            with open(probe_path, "a", encoding="utf-8") as second:
                try:
                    Win32Locker().lock(second, portalocker.LOCK_EX | portalocker.LOCK_NB)
                except portalocker.exceptions.AlreadyLocked:
                    win32_excludes_second_handle = True
                else:
                    raise PreflightError(
                        "lock_implementation",
                        "Win32Locker allowed a second handle to lock the same file",
                    )
                finally:
                    try:
                        Win32Locker().unlock(second)
                    except Exception:
                        pass
        finally:
            locker.unlock(first)
    if not win32_excludes_second_handle:
        raise PreflightError(
            "lock_implementation", "Win32Locker did not demonstrate real exclusion"
        )

    return {
        "ok": True,
        "no_shim": True,
        "module_path": str(module_path),
        "module_under_interpreter_prefix": under_prefix,
        "lock_class": "portalocker.utils.Lock",
        "locker": portalocker.portalocker.LOCKER.__name__,
        "win32_locker": "Win32Locker",
        "win32_excludes_second_handle": win32_excludes_second_handle,
        "deepeval_uses_same_portalocker": True,
        "portalocker_version": portalocker.__version__,
        "pywin32_version": _dist_version("pywin32") if sys.platform == "win32" else None,
    }


def check_file_lock(workdir: Path, lock_resource: Path | None) -> dict:
    import portalocker

    path = (lock_resource or (workdir / "eval-runtime.lock")).resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    first = portalocker.Lock(
        str(path),
        mode="a",
        timeout=0,
        flags=portalocker.LOCK_EX | portalocker.LOCK_NB,
    )
    try:
        first.acquire()
    except portalocker.exceptions.LockException as exc:
        raise PreflightError(
            "file_lock",
            f"protected file lock unavailable at {path}: {type(exc).__name__}: {exc}",
        ) from exc
    try:
        contended = False
        second = portalocker.Lock(
            str(path),
            mode="a",
            timeout=0,
            flags=portalocker.LOCK_EX | portalocker.LOCK_NB,
        )
        try:
            second.acquire()
        except portalocker.exceptions.AlreadyLocked:
            contended = True
        finally:
            try:
                second.release()
            except Exception:
                pass
        if not contended:
            raise PreflightError(
                "file_lock", f"a second lock handle acquired {path}; lock is not real"
            )
    finally:
        first.release()

    # Re-acquire after release to prove the lock is reusable, not one-shot.
    with portalocker.Lock(
        str(path),
        mode="a",
        timeout=0,
        flags=portalocker.LOCK_EX | portalocker.LOCK_NB,
    ) as handle:
        handle.write("eval-preflight lock probe\n")
        handle.flush()
        os.fsync(handle.fileno())

    return {
        "ok": True,
        "path": str(path),
        "contended_same_process": contended,
        "reacquired_after_release": True,
    }


def check_write_readback(workdir: Path) -> dict:
    nonce = secrets.token_hex(16)
    content = f"eval-preflight-write-readback:{nonce}\n"
    encoded = content.encode("utf-8")
    path = workdir / "preflight-write-probe.txt"
    try:
        with open(path, "wb") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        with open(path, "rb") as handle:
            read_back = handle.read()
    except OSError as exc:
        raise PreflightError(
            "write_readback", f"cannot write/read eval probe file at {path}: {exc}"
        ) from exc

    if read_back != encoded:
        raise PreflightError(
            "write_readback",
            f"read-back mismatch at {path}: wrote {len(encoded)} bytes, "
            f"read {len(read_back)} bytes",
        )
    return {
        "ok": True,
        "path": str(path.resolve()),
        "content": content,
        "bytes": len(read_back),
        "sha256": hashlib.sha256(read_back).hexdigest(),
        "read_back_equal": True,
        "fsync": True,
    }


def _probe_main(args: argparse.Namespace) -> int:
    """One-process lock probe. Exit 0 acquired, 3 held elsewhere, 4 error."""
    lock_path = Path(args.probe_lock).resolve()
    report_path = Path(args.report).resolve() if args.report else None
    report: dict = {
        "mode": "probe",
        "backend": args.backend,
        "pid": os.getpid(),
        "locked_file": str(lock_path),
        "acquired": False,
        "file_opened": False,
    }
    lock_obj = None
    handle = None
    try:
        import portalocker

        report["portalocker_version"] = portalocker.__version__
        report["portalocker_module"] = str(Path(portalocker.__file__).resolve())
        lock_path.parent.mkdir(parents=True, exist_ok=True)

        # Opening the file is deliberately separate from locking it. A plain
        # open must keep working while another process holds the lock.
        with open(lock_path, "a", encoding="utf-8"):
            report["file_opened"] = True

        if args.backend == "portalocker":
            report["locker"] = portalocker.portalocker.LOCKER.__name__
            lock_obj = portalocker.Lock(
                str(lock_path),
                mode="a",
                timeout=0,
                flags=portalocker.LOCK_EX | portalocker.LOCK_NB,
            )
            lock_obj.acquire()
        else:
            from portalocker.portalocker import Win32Locker

            report["locker"] = "Win32Locker"
            handle = open(lock_path, "a", encoding="utf-8")
            lock_obj = Win32Locker()
            lock_obj.lock(handle, portalocker.LOCK_EX | portalocker.LOCK_NB)

        report["acquired"] = True
        report["reason"] = "acquired"
        if report_path:
            _write_json_atomic(report_path, report)
        time.sleep(max(0, args.hold_ms) / 1000.0)
        return EXIT_OK
    except Exception as exc:
        already_locked = False
        try:
            import portalocker

            already_locked = isinstance(exc, portalocker.exceptions.AlreadyLocked)
        except Exception:
            pass
        report["reason"] = "already_locked" if already_locked else "probe_error"
        report["error"] = f"{type(exc).__name__}: {exc}"
        if report_path:
            _write_json_atomic(report_path, report)
        return EXIT_LOCK_HELD if already_locked else EXIT_PROBE_ERROR
    finally:
        if lock_obj is not None:
            try:
                if args.backend == "win32":
                    lock_obj.unlock(handle)
                else:
                    lock_obj.release()
            except Exception:
                pass
        if handle is not None:
            try:
                handle.close()
            except Exception:
                pass


def _run_probe(
    lock_path: Path,
    backend: str,
    report_path: Path,
    hold_ms: int,
    timeout: float,
) -> subprocess.CompletedProcess:
    return subprocess.run(
        [
            sys.executable,
            str(Path(__file__).resolve()),
            "--probe-lock",
            str(lock_path),
            "--backend",
            backend,
            "--hold-ms",
            str(hold_ms),
            "--report",
            str(report_path),
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )


def _start_probe_holder(
    lock_path: Path, backend: str, report_path: Path, hold_ms: int
) -> subprocess.Popen:
    return subprocess.Popen(
        [
            sys.executable,
            str(Path(__file__).resolve()),
            "--probe-lock",
            str(lock_path),
            "--backend",
            backend,
            "--hold-ms",
            str(hold_ms),
            "--report",
            str(report_path),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )


def _wait_for_report(path: Path, process: subprocess.Popen, timeout: float = 20.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if path.exists():
            try:
                return json.loads(path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                pass
        if process.poll() is not None:
            stderr = process.stderr.read() if process.stderr else ""
            raise PreflightError(
                "mutual_exclusion",
                f"lock holder exited {process.returncode} before reporting: {stderr.strip()}",
            )
        time.sleep(0.05)
    raise PreflightError(
        "mutual_exclusion", f"lock holder did not report within {timeout:.0f}s: {path}"
    )


def _prove_backend(workdir: Path, backend: str) -> dict:
    lock_path = workdir / f"mutex-{backend}.lock"
    holder_report = workdir / f"mutex-{backend}-holder.json"
    contender_report = workdir / f"mutex-{backend}-contender.json"
    after_report = workdir / f"mutex-{backend}-after.json"

    holder = _start_probe_holder(lock_path, backend, holder_report, hold_ms=1500)
    try:
        held = _wait_for_report(holder_report, holder)
        if held.get("acquired") is not True:
            raise PreflightError(
                "mutual_exclusion",
                f"{backend} holder failed to acquire: {held.get('error', held)}",
            )

        contender = _run_probe(
            lock_path, backend, contender_report, hold_ms=0, timeout=30
        )
        if contender.returncode != EXIT_LOCK_HELD:
            raise PreflightError(
                "mutual_exclusion",
                f"{backend} contender exited {contender.returncode}, expected "
                f"{EXIT_LOCK_HELD} while the holder owns the lock: "
                f"{contender.stderr.strip()}",
            )
        proof = (
            json.loads(contender_report.read_text(encoding="utf-8"))
            if contender_report.exists()
            else {}
        )
        if proof.get("acquired") is not False or proof.get("reason") != "already_locked":
            raise PreflightError(
                "mutual_exclusion",
                f"{backend} contender did not report an already-held lock: {proof}",
            )

        # The lock file itself stays openable; that is not a lock.
        with open(lock_path, "a", encoding="utf-8"):
            pass
    finally:
        try:
            holder.wait(timeout=20)
        except subprocess.TimeoutExpired:
            holder.kill()
            holder.wait(timeout=5)
    if holder.returncode != EXIT_OK:
        stderr = holder.stderr.read() if holder.stderr else ""
        raise PreflightError(
            "mutual_exclusion",
            f"{backend} holder exited {holder.returncode}: {stderr.strip()}",
        )

    after = _run_probe(lock_path, backend, after_report, hold_ms=0, timeout=30)
    if after.returncode != EXIT_OK:
        raise PreflightError(
            "mutual_exclusion",
            f"{backend} lock was not acquirable after release (exit {after.returncode}): "
            f"{after.stderr.strip()}",
        )
    after_proof = (
        json.loads(after_report.read_text(encoding="utf-8"))
        if after_report.exists()
        else {}
    )
    if after_proof.get("acquired") is not True:
        raise PreflightError(
            "mutual_exclusion", f"{backend} did not re-acquire after release: {after_proof}"
        )

    return {
        "holder_acquired": True,
        "contender_exit_code": contender.returncode,
        "contender_acquired": False,
        "file_opened_while_locked": True,
        "acquired_after_release": True,
        "holder_report": str(holder_report),
        "contender_report": str(contender_report),
        "after_report": str(after_report),
    }


def check_mutual_exclusion(workdir: Path) -> dict:
    backends = {
        "portalocker": _prove_backend(workdir, "portalocker"),
        "win32": _prove_backend(workdir, "win32"),
    }
    return {"ok": True, "backends": backends}


def build_snapshot() -> dict:
    packages: dict[str, str] = {}
    for distribution in (
        "deepeval",
        "typesafe-sdk",
        "portalocker",
        "pytest",
        "requests",
        "pywin32",
    ):
        try:
            packages[distribution] = _dist_version(distribution)
        except metadata.PackageNotFoundError:
            continue

    lock: dict = {"portalocker_version": packages.get("portalocker")}
    try:
        import portalocker

        lock.update(
            {
                "lock_class": "portalocker.utils.Lock",
                "locker": portalocker.portalocker.LOCKER.__name__,
                "win32_locker": "Win32Locker"
                if sys.platform == "win32"
                else None,
                "module_path": str(Path(portalocker.__file__).resolve()),
            }
        )
    except Exception as exc:
        lock["detail"] = f"portalocker unavailable: {type(exc).__name__}"

    return {
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
        "lock": lock,
    }


def run_preflight(workdir: Path, lock_resource: Path | None = None) -> dict:
    started = time.monotonic()
    report: dict = {
        "ticket": TICKET,
        "ok": False,
        "started_at": _utc_now(),
        "workdir": str(workdir.resolve()),
        "failed_step": None,
        "error": None,
        "steps": {},
    }
    steps = [
        ("interpreter", lambda: check_interpreter()),
        ("imports", check_imports),
        ("lock_implementation", lambda: check_lock_implementation(workdir)),
        ("file_lock", lambda: check_file_lock(workdir, lock_resource)),
        ("write_readback", lambda: check_write_readback(workdir)),
        ("mutual_exclusion", lambda: check_mutual_exclusion(workdir)),
    ]
    for name, step in steps:
        try:
            report["steps"][name] = step()
        except PreflightError as exc:
            report["failed_step"] = exc.step
            report["error"] = str(exc)
            break
        except Exception as exc:  # pragma: no cover - defensive
            report["failed_step"] = name
            report["error"] = f"{type(exc).__name__}: {exc}"
            break

    report["ok"] = report["failed_step"] is None
    report["snapshot"] = build_snapshot()
    report["duration_ms"] = int((time.monotonic() - started) * 1000)
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Fail-closed DeepEval runtime preflight")
    parser.add_argument("--workdir", help="artifact directory (default: temp dir)")
    parser.add_argument(
        "--lock-resource",
        help="protected lock path to verify (default: <workdir>/eval-runtime.lock)",
    )
    parser.add_argument("--json-out", help="write the full JSON report to this path")
    parser.add_argument("--probe-lock", help=argparse.SUPPRESS)
    parser.add_argument(
        "--backend", choices=("portalocker", "win32"), default="portalocker", help=argparse.SUPPRESS
    )
    parser.add_argument("--hold-ms", type=int, default=0, help=argparse.SUPPRESS)
    parser.add_argument("--report", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)

    if args.probe_lock:
        return _probe_main(args)

    workdir = (
        Path(args.workdir).resolve()
        if args.workdir
        else Path(tempfile.mkdtemp(prefix="nexusrag-eval-preflight-"))
    )
    workdir.mkdir(parents=True, exist_ok=True)
    _configure_deepeval_sandbox(workdir)

    lock_resource = Path(args.lock_resource).resolve() if args.lock_resource else None
    report = run_preflight(workdir, lock_resource=lock_resource)

    if args.json_out:
        _write_json_atomic(Path(args.json_out).resolve(), report)

    print(json.dumps(report, ensure_ascii=False), flush=True)
    if report["ok"]:
        snapshot = report["snapshot"]
        print(
            "[eval-preflight] OK "
            f"python={snapshot['interpreter']['version']} "
            f"deepeval={snapshot['packages'].get('deepeval')} "
            f"typesafe-sdk={snapshot['packages'].get('typesafe-sdk')} "
            f"portalocker={snapshot['lock'].get('portalocker_version')} "
            f"lock={snapshot['lock'].get('locker')} "
            f"win32={snapshot['lock'].get('win32_locker')}",
            file=sys.stderr,
            flush=True,
        )
        return EXIT_OK

    print(
        f"[eval-preflight] preflight failed at step '{report['failed_step']}': "
        f"{report['error']}",
        file=sys.stderr,
        flush=True,
    )
    return EXIT_PREFLIGHT_FAILED


if __name__ == "__main__":
    raise SystemExit(main())
