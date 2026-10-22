"""Controlled, offline end-to-end DeepEval run for the DR-02 runtime proof.

This is deliberately not an online evaluation: it proves that the isolated
Python 3.12 runtime can execute a DeepEval test case, evaluate a deterministic
metric, persist the result the same way a real run does (portalocker-protected
``test_run_*.json``) and read that result back. Quality is out of scope.

The "agent" is a replay chat provider fed from
``fixtures/controlled_chat_replay.json``; the metric is an exact-match check.
A process-wide network guard fails the run if anything attempts a socket
connection while the controlled evaluation is executing.

Run:
  .venv-evals/Scripts/python.exe tests/evals/controlled_eval.py --results-dir .tmp/controlled
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata as metadata
import json
import os
import platform
import sys
import tempfile
from pathlib import Path

EVAL_DIR = Path(__file__).resolve().parent
FIXTURE_PATH = EVAL_DIR / "fixtures" / "controlled_chat_replay.json"
METRIC_NAME = "Replay Exact Match"


class NetworkGuard:
    """Block every outbound socket connect and count attempts."""

    def __init__(self) -> None:
        self.blocked_attempts = 0
        self._originals: list[tuple[object, str, object]] = []

    def __enter__(self) -> "NetworkGuard":
        import socket

        self._guard_module = socket
        originals = [
            (socket.socket, "connect", socket.socket.connect),
            (socket.socket, "connect_ex", socket.socket.connect_ex),
            (socket, "create_connection", socket.create_connection),
        ]
        self._originals = originals

        def deny(*_args, **_kwargs):
            self.blocked_attempts += 1
            raise RuntimeError("network is disabled during the controlled eval")

        socket.socket.connect = deny  # type: ignore[method-assign]
        socket.socket.connect_ex = deny  # type: ignore[method-assign]
        socket.create_connection = deny  # type: ignore[assignment]
        return self

    def __exit__(self, *_exc_info) -> None:
        for owner, name, original in self._originals:
            setattr(owner, name, original)


class ReplayChatProvider:
    """Local stand-in for the chat backend; answers only from the fixture."""

    mode = "replay"

    def __init__(self, fixture_path: Path) -> None:
        data = json.loads(fixture_path.read_text(encoding="utf-8"))
        if data.get("provider") != "replay":
            raise ValueError(f"{fixture_path} is not a replay provider fixture")
        self.cases = data["cases"]
        self._reply_by_input = {case["input"]: case["reply"] for case in self.cases}
        self.requests = 0
        self.network_calls = 0

    def reply(self, message: str) -> str:
        self.requests += 1
        try:
            return self._reply_by_input[message]
        except KeyError as exc:
            raise KeyError(
                f"replay provider has no configured reply for {message!r}; "
                "refusing to fall back to a network provider"
            ) from exc


def _build_metric():
    from deepeval.metrics import BaseMetric

    class ReplayExactMatchMetric(BaseMetric):
        """Deterministic: 1.0 only when the reply equals the frozen expectation."""

        def __init__(self) -> None:
            self.threshold = 1.0
            self.async_mode = False
            self.include_reason = True
            self.score = None
            self.reason = None
            self.success = None
            self.error = None
            self.evaluation_model = "replay-exact-match"

        @property
        def __name__(self):
            return METRIC_NAME

        def measure(self, test_case, *args, **kwargs) -> float:
            expected = (test_case.expected_output or "").strip()
            actual = (test_case.actual_output or "").strip()
            if not expected:
                self.error = "expected_output is required for the replay metric"
                self.score = None
                self.success = False
                return 0.0
            self.score = 1.0 if actual == expected else 0.0
            self.reason = (
                "reply matches the frozen replay expectation"
                if self.score == 1.0
                else "reply differs from the frozen replay expectation"
            )
            self.success = self.score >= self.threshold
            return self.score

    return ReplayExactMatchMetric()


def _snapshot() -> dict:
    import portalocker

    packages = {}
    for distribution in ("deepeval", "typesafe-sdk", "portalocker", "pywin32", "pytest"):
        try:
            packages[distribution] = metadata.version(distribution)
        except metadata.PackageNotFoundError:
            continue
    interpreter = {
        "version": sys.version.split()[0],
        "implementation": platform.python_implementation(),
        "executable": sys.executable,
        "prefix": sys.prefix,
        "in_venv": sys.prefix != sys.base_prefix,
    }
    return {
        "interpreter": interpreter,
        "python": interpreter,
        "platform": {
            "system": platform.system(),
            "release": platform.release(),
            "machine": platform.machine(),
        },
        "packages": packages,
        "lock": {
            "portalocker_version": packages.get("portalocker"),
            "lock_class": "portalocker.utils.Lock",
            "locker": portalocker.portalocker.LOCKER.__name__,
            "win32_locker": "Win32Locker",
        },
    }


def _write_json_atomic(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)


def _read_back_persisted(
    results_dir: Path, expected_cases: list[dict]
) -> tuple[Path, dict, list[dict]]:
    files = sorted(
        results_dir.glob("test_run_*.json"), key=lambda path: path.stat().st_mtime_ns
    )
    if not files:
        raise AssertionError(f"DeepEval did not persist a test run in {results_dir}")
    persisted = files[-1]
    data = json.loads(persisted.read_text(encoding="utf-8"))
    cases = data.get("testCases") or []
    if len(cases) != len(expected_cases):
        raise AssertionError(
            f"persisted {len(cases)} test cases, expected {len(expected_cases)}"
        )

    by_name = {case.get("name"): case for case in cases}
    replayed: list[dict] = []
    for expected in expected_cases:
        case = by_name.get(expected["id"])
        if case is None:
            raise AssertionError(f"persisted run is missing case {expected['id']!r}")
        if case.get("actualOutput") != expected["reply"]:
            raise AssertionError(
                f"case {expected['id']!r} persisted actualOutput != replay reply"
            )
        if case.get("success") is not True:
            raise AssertionError(f"case {expected['id']!r} did not pass")
        metrics = case.get("metricsData") or []
        if len(metrics) != 1 or metrics[0].get("name") != METRIC_NAME:
            raise AssertionError(
                f"case {expected['id']!r} persisted unexpected metrics: {metrics}"
            )
        if metrics[0].get("score") != 1.0 or metrics[0].get("success") is not True:
            raise AssertionError(
                f"case {expected['id']!r} persisted score {metrics[0].get('score')!r}"
            )
        replayed.append(
            {
                "id": expected["id"],
                "input": expected["input"],
                "score": metrics[0]["score"],
                "success": metrics[0]["success"],
            }
        )
    return persisted, data, replayed


def run(results_dir: Path, fixture_path: Path) -> dict:
    # Configure DeepEval before importing it: no telemetry, state under the run dir.
    os.environ.setdefault("DEEPEVAL_TELEMETRY_OPT_OUT", "YES")
    os.environ.setdefault("DEEPEVAL_NO_INSPECT_PROMPT", "1")
    os.environ["DEEPEVAL_CACHE_FOLDER"] = str(results_dir / "deepeval-cache")
    os.environ["DEEPEVAL_HOME"] = str(results_dir / "deepeval-home")
    os.environ["DEEPEVAL_LOCAL_STORE"] = "json"

    results_dir.mkdir(parents=True, exist_ok=True)

    from deepeval.evaluate import evaluate
    from deepeval.evaluate.configs import (
        AsyncConfig,
        CacheConfig,
        DisplayConfig,
        ErrorConfig,
    )
    from deepeval.test_case import LLMTestCase

    provider = ReplayChatProvider(fixture_path)
    metric = _build_metric()

    test_cases = [
        LLMTestCase(
            name=case["id"],
            input=case["input"],
            actual_output=provider.reply(case["input"]),
            expected_output=case["expected_output"],
            retrieval_context=case["retrieval_context"],
            metadata={"provider": provider.mode, "case_id": case["id"]},
        )
        for case in provider.cases
    ]

    with NetworkGuard() as guard:
        evaluate(
            test_cases=test_cases,
            metrics=[metric],
            async_config=AsyncConfig(run_async=False),
            display_config=DisplayConfig(
                show_indicator=False,
                print_results=False,
                inspect_after_run=False,
                results_folder=str(results_dir),
            ),
            cache_config=CacheConfig(write_cache=False, use_cache=False),
            error_config=ErrorConfig(
                ignore_errors=False, skip_on_missing_params=False
            ),
        )

    persisted, data, replayed = _read_back_persisted(results_dir, provider.cases)
    persisted_bytes = persisted.read_bytes()
    report = {
        "ok": True,
        "ticket": "DR-02",
        "provider": {
            "mode": provider.mode,
            "fixture": str(fixture_path),
            "requests": provider.requests,
            "network_calls": provider.network_calls,
        },
        "metric": {
            "name": METRIC_NAME,
            "threshold": 1.0,
            "mode": "deterministic",
        },
        "case_count": len(replayed),
        "cases": replayed,
        "persistence": {
            "results_dir": str(results_dir.resolve()),
            "file": str(persisted.resolve()),
            "bytes": len(persisted_bytes),
            "sha256": hashlib.sha256(persisted_bytes).hexdigest(),
            "read_back_ok": True,
            "test_passed": data.get("testPassed"),
            "test_failed": data.get("testFailed"),
        },
        "network_guard": {
            "active": True,
            "blocked_attempts": guard.blocked_attempts,
        },
        "snapshot": _snapshot(),
    }
    if guard.blocked_attempts:
        raise AssertionError(
            f"{guard.blocked_attempts} network connection attempt(s) were blocked; "
            "the controlled eval must not need the network"
        )
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Controlled offline DeepEval runtime proof")
    parser.add_argument(
        "--results-dir",
        default=None,
        help="directory that receives the persisted DeepEval test run "
        "(default: a system temp directory)",
    )
    parser.add_argument("--fixture", default=str(FIXTURE_PATH))
    args = parser.parse_args(argv)

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    results_dir = (
        Path(args.results_dir).resolve()
        if args.results_dir
        else Path(tempfile.mkdtemp(prefix="nexusrag-controlled-eval-"))
    )
    report_path = results_dir / "controlled-eval-report.json"
    try:
        report = run(results_dir, Path(args.fixture).resolve())
        _write_json_atomic(report_path, report)
        # Re-read the report itself before declaring success.
        reread = json.loads(report_path.read_text(encoding="utf-8"))
        if reread.get("persistence", {}).get("sha256") != report["persistence"]["sha256"]:
            raise AssertionError("controlled eval report did not read back intact")
    except Exception as exc:
        print(
            f"[controlled-eval] FAILED: {type(exc).__name__}: {exc}",
            file=sys.stderr,
            flush=True,
        )
        return 1

    print(
        json.dumps(
            {
                "ok": True,
                "cases": report["case_count"],
                "persisted": report["persistence"]["file"],
                "sha256": report["persistence"]["sha256"],
                "network_blocked": report["network_guard"]["blocked_attempts"],
            },
            ensure_ascii=False,
        ),
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
