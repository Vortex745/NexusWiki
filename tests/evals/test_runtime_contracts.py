"""Runtime contracts for the isolated DeepEval environment (DR-02).

These tests exercise the eval runtime's public commands with real processes,
real temporary directories and real Windows file locks. They answer one
question: can this interpreter be trusted to run an evaluation that persists
results before any external eval request is made?

Seams:
  * ``tests/evals/preflight.py``            — fail-closed runtime preflight CLI
  * ``tests/evals/controlled_eval.py``      — controlled replay eval CLI
  * persisted DeepEval ``test_run_*.json``  — the result that must be re-read

No TypeSafe/Jev/OpenAI/network calls are made by any test.
"""

import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

import pytest
from portalocker import Lock, LockFlags

EVAL_DIR = Path(__file__).resolve().parent
PREFLIGHT = EVAL_DIR / "preflight.py"
CONTROLLED_EVAL = EVAL_DIR / "controlled_eval.py"

SENSITIVE_ENV_NAME = re.compile(
    r"(API_?KEY|ACCESS_?TOKEN|AUTH_?TOKEN|SECRET|PASSWORD|CREDENTIAL)", re.IGNORECASE
)


def _clean_env() -> dict:
    """Environment without credential-like values, so a pass cannot rely on them."""
    env = {k: v for k, v in os.environ.items() if not SENSITIVE_ENV_NAME.search(k)}
    env.update(
        {
            "PYTHONIOENCODING": "utf-8",
            "PYTHONUTF8": "1",
            "DEEPEVAL_TELEMETRY_OPT_OUT": "YES",
            "DEEPEVAL_NO_INSPECT_PROMPT": "1",
        }
    )
    return env


def _run(args: list[str], timeout: int = 120) -> subprocess.CompletedProcess:
    return subprocess.run(
        args,
        cwd=str(EVAL_DIR),
        env=_clean_env(),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )


def _read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _wait_for_json(path: Path, timeout: float = 15.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if path.exists():
            try:
                return _read_json(path)
            except (json.JSONDecodeError, OSError):
                pass
        time.sleep(0.05)
    raise AssertionError(f"probe report was not written: {path}")


def _assert_no_secret_values(serialized: str) -> None:
    for name, value in os.environ.items():
        if SENSITIVE_ENV_NAME.search(name) and len(value) >= 8:
            assert value not in serialized, f"runtime output leaked env var {name}"


def _start_lock_holder(lock_path: Path, report: Path, backend: str, hold_ms: int):
    return subprocess.Popen(
        [
            sys.executable,
            str(PREFLIGHT),
            "--probe-lock",
            str(lock_path),
            "--backend",
            backend,
            "--hold-ms",
            str(hold_ms),
            "--report",
            str(report),
        ],
        cwd=str(EVAL_DIR),
        env=_clean_env(),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )


def test_preflight_succeeds_on_locked_interpreter(tmp_path: Path) -> None:
    """A healthy 3.12 eval runtime passes every preflight step and is explained."""
    workdir = tmp_path / "preflight"
    report_path = tmp_path / "preflight-report.json"

    proc = _run(
        [
            sys.executable,
            str(PREFLIGHT),
            "--workdir",
            str(workdir),
            "--json-out",
            str(report_path),
        ]
    )

    assert proc.returncode == 0, f"stdout:\n{proc.stdout}\nstderr:\n{proc.stderr}"
    report = _read_json(report_path)
    assert report["ok"] is True
    assert report["failed_step"] is None
    assert report["error"] is None

    steps = report["steps"]
    assert steps["interpreter"]["ok"] is True
    assert steps["imports"]["ok"] is True
    assert steps["imports"]["packages"]["deepeval"] == "4.2.8"
    assert steps["imports"]["packages"]["typesafe-sdk"] == "0.7.4"
    assert steps["lock_implementation"]["ok"] is True
    assert steps["lock_implementation"]["no_shim"] is True
    assert steps["lock_implementation"]["module_under_interpreter_prefix"] is True
    assert steps["lock_implementation"]["deepeval_uses_same_portalocker"] is True
    assert steps["lock_implementation"]["win32_locker"] == "Win32Locker"
    assert steps["file_lock"]["ok"] is True
    assert steps["write_readback"]["ok"] is True
    assert steps["mutual_exclusion"]["ok"] is True

    for backend in ("portalocker", "win32"):
        proof = steps["mutual_exclusion"]["backends"][backend]
        assert proof["holder_acquired"] is True
        assert proof["contender_acquired"] is False
        assert proof["contender_exit_code"] == 3
        assert proof["file_opened_while_locked"] is True
        assert proof["acquired_after_release"] is True

    snapshot = report["snapshot"]
    assert snapshot["interpreter"]["version"].startswith("3.12.")
    assert snapshot["interpreter"]["implementation"] == "CPython"
    assert snapshot["packages"]["deepeval"] == "4.2.8"
    assert snapshot["packages"]["typesafe-sdk"] == "0.7.4"
    assert snapshot["lock"]["locker"] == "MsvcrtLocker"
    assert snapshot["lock"]["win32_locker"] == "Win32Locker"
    assert "portalocker" in snapshot["packages"]

    serialized = json.dumps(report, ensure_ascii=False)
    _assert_no_secret_values(serialized)
    assert "token" not in {key.lower() for key in snapshot}
    assert "password" not in {key.lower() for key in snapshot}


def test_write_readback_produces_and_rereads_real_file(tmp_path: Path) -> None:
    """The probe writes a nonce to disk, fsyncs, reads it back and reports the digest."""
    workdir = tmp_path / "writeback"
    report_path = tmp_path / "writeback-report.json"

    proc = _run(
        [
            sys.executable,
            str(PREFLIGHT),
            "--workdir",
            str(workdir),
            "--json-out",
            str(report_path),
        ]
    )
    assert proc.returncode == 0, f"stdout:\n{proc.stdout}\nstderr:\n{proc.stderr}"

    probe = _read_json(report_path)["steps"]["write_readback"]
    marker = Path(probe["path"])
    assert marker.is_file()
    written = marker.read_bytes()
    assert written.decode("utf-8") == probe["content"]
    import hashlib

    assert hashlib.sha256(written).hexdigest() == probe["sha256"]
    assert probe["read_back_equal"] is True
    assert probe["fsync"] is True


@pytest.mark.parametrize("backend", ["portalocker", "win32"])
def test_second_process_cannot_acquire_held_lock(tmp_path: Path, backend: str) -> None:
    """A real second process must fail while another process holds the lock.

    Opening the lock file still succeeds; only the lock acquisition may fail.
    That distinction is the whole point of the contract.
    """
    lock_path = tmp_path / f"resource-{backend}.lock"
    holder_report = tmp_path / f"holder-{backend}.json"
    contender_report = tmp_path / f"contender-{backend}.json"

    holder = _start_lock_holder(lock_path, holder_report, backend, hold_ms=4000)
    try:
        held = _wait_for_json(holder_report)
        assert held["acquired"] is True, held
        assert held["file_opened"] is True

        contender = _run(
            [
                sys.executable,
                str(PREFLIGHT),
                "--probe-lock",
                str(lock_path),
                "--backend",
                backend,
                "--report",
                str(contender_report),
            ],
            timeout=30,
        )
        assert contender.returncode == 3, (
            f"contender should report the lock as held, got {contender.returncode}\n"
            f"stdout:\n{contender.stdout}\nstderr:\n{contender.stderr}"
        )
        proof = _read_json(contender_report)
        assert proof["acquired"] is False
        assert proof["reason"] == "already_locked"
        assert proof["file_opened"] is True

        # The test process itself can open the file while the lock is held;
        # a successful open is not evidence of a successful lock.
        with open(lock_path, "a", encoding="utf-8"):
            pass
    finally:
        holder.wait(timeout=15)
    assert holder.returncode == 0, holder.stderr.read() if holder.stderr else ""

    after_report = tmp_path / f"after-{backend}.json"
    after = _run(
        [
            sys.executable,
            str(PREFLIGHT),
            "--probe-lock",
            str(lock_path),
            "--backend",
            backend,
            "--report",
            str(after_report),
        ],
        timeout=30,
    )
    assert after.returncode == 0, f"stdout:\n{after.stdout}\nstderr:\n{after.stderr}"
    assert _read_json(after_report)["acquired"] is True


def test_preflight_fails_closed_when_lock_cannot_be_acquired(tmp_path: Path) -> None:
    """If the protected resource is already locked, preflight exits non-zero.

    It must stop before the mutual-exclusion/eval steps; a run that cannot
    take its real lock must never be reported as ready.
    """
    lock_path = tmp_path / "guarded-resource.lock"
    workdir = tmp_path / "blocked-preflight"
    report_path = tmp_path / "blocked-report.json"

    held = Lock(
        str(lock_path),
        mode="a",
        timeout=0,
        flags=LockFlags.EXCLUSIVE | LockFlags.NON_BLOCKING,
    )
    held.acquire()
    try:
        proc = _run(
            [
                sys.executable,
                str(PREFLIGHT),
                "--workdir",
                str(workdir),
                "--lock-resource",
                str(lock_path),
                "--json-out",
                str(report_path),
            ]
        )
    finally:
        held.release()

    assert proc.returncode == 1, f"stdout:\n{proc.stdout}\nstderr:\n{proc.stderr}"
    report = _read_json(report_path)
    assert report["ok"] is False
    assert report["failed_step"] == "file_lock"
    assert "lock" in report["error"].lower()
    assert "Traceback" not in report["error"]
    assert "mutual_exclusion" not in report["steps"]
    assert "preflight failed" in proc.stderr.lower()


def test_pytest_session_gate_stops_evals_when_preflight_fails(tmp_path: Path) -> None:
    """``pytest tests/evals`` must stop before collection when the lock is held."""
    repo_root = EVAL_DIR.parent.parent
    lock_path = tmp_path / "session-gate.lock"
    held = Lock(
        str(lock_path),
        mode="a",
        timeout=0,
        flags=LockFlags.EXCLUSIVE | LockFlags.NON_BLOCKING,
    )
    held.acquire()
    try:
        env = _clean_env()
        env["NEXUSRAG_EVAL_PREFLIGHT_LOCK"] = str(lock_path)
        proc = subprocess.run(
            [
                sys.executable,
                "-m",
                "pytest",
                "tests/evals/test_runtime_contracts.py",
                "--collect-only",
                "-q",
            ],
            cwd=str(repo_root),
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=180,
        )
    finally:
        held.release()

    combined = f"{proc.stdout}\n{proc.stderr}"
    assert proc.returncode == 1, combined
    assert "refusing to start evals" in combined
    assert "test_runtime_contracts.py" not in proc.stdout
    assert "collected" not in proc.stdout


def test_controlled_eval_persists_and_reads_back_results(tmp_path: Path) -> None:
    """One deterministic replay eval runs end-to-end and its result survives re-read."""
    results_dir = tmp_path / "controlled-results"
    proc = _run(
        [
            sys.executable,
            str(CONTROLLED_EVAL),
            "--results-dir",
            str(results_dir),
        ],
        timeout=180,
    )
    assert proc.returncode == 0, f"stdout:\n{proc.stdout}\nstderr:\n{proc.stderr}"

    report_path = results_dir / "controlled-eval-report.json"
    report = _read_json(report_path)
    assert report["ok"] is True
    assert report["provider"]["mode"] == "replay"
    assert report["provider"]["network_calls"] == 0
    assert report["provider"]["requests"] == report["case_count"]
    assert report["network_guard"]["blocked_attempts"] == 0
    assert report["persistence"]["read_back_ok"] is True
    assert report["snapshot"]["interpreter"]["version"].startswith("3.12.")
    assert report["snapshot"]["packages"]["deepeval"] == "4.2.8"
    assert report["snapshot"]["packages"]["typesafe-sdk"] == "0.7.4"
    assert report["snapshot"]["lock"]["locker"] == "MsvcrtLocker"
    assert report["snapshot"]["lock"]["win32_locker"] == "Win32Locker"

    persisted = Path(report["persistence"]["file"])
    assert persisted.is_file()
    assert persisted.parent == results_dir
    assert report["persistence"]["sha256"]

    data = _read_json(persisted)
    cases = data["testCases"]
    assert len(cases) == report["case_count"] == 2
    assert data["testPassed"] == 2
    assert data["testFailed"] == 0
    for case in cases:
        assert case["success"] is True
        metric = case["metricsData"][0]
        assert metric["name"] == "Replay Exact Match"
        assert metric["score"] == 1.0
        assert metric["success"] is True

    # The report itself was persisted and can be re-read.
    assert _read_json(report_path)["persistence"]["read_back_ok"] is True
