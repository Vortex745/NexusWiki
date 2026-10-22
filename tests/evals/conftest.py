"""Session gate: no eval test may run until the runtime preflight passes (DR-02).

``pytest_sessionstart`` runs the same fail-closed preflight command that an
operator runs, before pytest imports the eval modules or executes a single
golden. A failure exits the session with a non-zero status and a diagnostic;
it never turns into a skipped test.

The session-scoped autouse fixture exposes the passing report to tests and
keeps the gate visible in the fixture graph, but it never re-runs the
(expensive) preflight.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

EVAL_DIR = Path(__file__).resolve().parent
PREFLIGHT = EVAL_DIR / "preflight.py"

_GATE: dict = {}


def _gate_env() -> dict:
    env = os.environ.copy()
    env.setdefault("PYTHONIOENCODING", "utf-8")
    env.setdefault("PYTHONUTF8", "1")
    env.setdefault("DEEPEVAL_TELEMETRY_OPT_OUT", "YES")
    env.setdefault("DEEPEVAL_NO_INSPECT_PROMPT", "1")
    return env


def _run_preflight(workdir: Path) -> tuple[int, dict | None, str]:
    report_path = workdir / "preflight-report.json"
    command = [
        sys.executable,
        str(PREFLIGHT),
        "--workdir",
        str(workdir),
        "--json-out",
        str(report_path),
    ]
    # Only tightens the gate: point the protected resource at a path that a
    # test (or CI) already holds to prove fail-closed behaviour.
    lock_resource = os.environ.get("NEXUSRAG_EVAL_PREFLIGHT_LOCK")
    if lock_resource:
        command += ["--lock-resource", lock_resource]

    try:
        proc = subprocess.run(
            command,
            cwd=str(EVAL_DIR),
            env=_gate_env(),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=240,
        )
    except subprocess.TimeoutExpired:
        return 1, None, "preflight timed out after 240s"

    report = None
    if report_path.exists():
        try:
            report = json.loads(report_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            return 1, None, f"preflight report unreadable: {exc}"
    stderr = proc.stderr or ""
    if proc.returncode != 0 or not report or report.get("ok") is not True:
        detail = (report or {}).get("error") or stderr.strip() or "no diagnostic"
        return proc.returncode or 1, report, detail
    return 0, report, stderr


def pytest_sessionstart(session: pytest.Session) -> None:
    workdir = Path(tempfile.mkdtemp(prefix="nexusrag-eval-gate-"))
    _GATE["workdir"] = workdir
    code, report, detail = _run_preflight(workdir)
    _GATE["report"] = report
    _GATE["detail"] = detail
    if code != 0 or report is None or report.get("ok") is not True:
        pytest.exit(
            "DR-02 eval runtime preflight failed; refusing to start evals: "
            f"{detail}",
            returncode=1,
        )

    snapshot = report["snapshot"]
    print(
        "[eval-gate] preflight OK "
        f"python={snapshot['interpreter']['version']} "
        f"deepeval={snapshot['packages'].get('deepeval')} "
        f"typesafe-sdk={snapshot['packages'].get('typesafe-sdk')} "
        f"lock={snapshot['lock'].get('locker')}/"
        f"{snapshot['lock'].get('win32_locker')}"
    )


def pytest_sessionfinish(session: pytest.Session, exitstatus: int) -> None:
    workdir = _GATE.get("workdir")
    if workdir:
        shutil.rmtree(workdir, ignore_errors=True)


@pytest.fixture(scope="session", autouse=True)
def eval_runtime_preflight() -> dict:
    """Fail the session if the preflight gate did not pass."""
    report = _GATE.get("report")
    if not report or report.get("ok") is not True:
        pytest.fail(
            "eval runtime preflight did not pass; refusing to evaluate: "
            f"{_GATE.get('detail', 'unknown error')}",
            pytrace=False,
        )
    return report
