"""Durable sample ledger and run-suite contracts (DR-04).

Every test drives the public seams an operator uses: ``run_suite.execute_run``
/ ``run_suite.main`` for a full run, ``run_suite.rebuild_run`` and
``RunLedger`` for artifacts on disk. A local HTTP stub stands in for the
NexusRAG backend; no external model, Jev or network call is made.

The invariants under test:
  * the raw Agent answer is persisted and read back before the judge runs
  * judge / Agent / write failures become score=null, incomplete, non-zero
  * missing, truncated and corrupt sample rows are detected
  * the summary is rebuilt from sample records only and never overwrites history
  * concurrent workers write only their own sample file
  * nothing persisted contains tokens, cookies or keys
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import portalocker
import pytest

EVAL_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(EVAL_DIR))

import ledger  # noqa: E402
import run_suite  # noqa: E402

TOKEN = "stub-access-token-DO-NOT-PERSIST"
JUDGE_SECRET = "judge-error-secret-DO-NOT-PERSIST"


class _StubHandler(BaseHTTPRequestHandler):
    server_version = "DR04Stub/1.0"

    def log_message(self, *_args) -> None:  # keep pytest output clean
        pass

    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:  # noqa: N802 - http.server API
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            body = {}
        with self.server.guard:
            self.server.requests.append(
                {
                    "path": self.path,
                    "body": body,
                    "authorization_present": "Authorization" in self.headers,
                    "authorization_is_bearer": str(
                        self.headers.get("Authorization", "")
                    ).startswith("Bearer "),
                }
            )
        if self.path == "/api/auth/login":
            self._send(200, {"accessToken": TOKEN})
            return
        if self.path == "/api/chat":
            with self.server.guard:
                index = self.server.chat_requests
                self.server.chat_requests += 1
            message = body.get("message")
            if message in self.server.fail_messages:
                self._send(
                    500,
                    {
                        "error": (
                            "backend exploded; Authorization: Bearer "
                            f"{TOKEN}; Cookie: session={TOKEN}"
                        )
                    },
                )
                return
            reply = self.server.replies.get(message, "unexpected question")
            references = self.server.references.get(message)
            if references is None:
                references = [{"id": "doc-1", "title": "Doc", "excerpt": "evidence"}]
            self._send(
                200,
                {
                    "reply": reply,
                    "references": references,
                    "runId": f"backend-run-{index}",
                    "status": "completed",
                },
            )
            return
        self._send(404, {"error": "not found"})


class StubBackend:
    def __init__(self) -> None:
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _StubHandler)
        self.server.guard = threading.Lock()
        self.server.requests = []
        self.server.chat_requests = 0
        self.server.replies = {}
        self.server.references = {}
        self.server.fail_messages = set()
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def base_url(self) -> str:
        host, port = self.server.server_address[:2]
        return f"http://{host}:{port}"

    @property
    def chat_requests(self) -> int:
        with self.server.guard:
            return self.server.chat_requests

    @property
    def requests(self) -> list[dict]:
        with self.server.guard:
            return list(self.server.requests)

    def __enter__(self) -> "StubBackend":
        self.thread.start()
        return self

    def __exit__(self, *_exc) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


@contextmanager
def stub_backend(
    replies: dict[str, str],
    fail_messages: set[str] | None = None,
    references: dict[str, list[dict]] | None = None,
):
    backend = StubBackend()
    backend.server.replies = dict(replies)
    backend.server.fail_messages = set(fail_messages or ())
    backend.server.references = dict(references or {})
    with backend:
        yield backend


def write_dataset(path: Path, cases: list[dict]) -> Path:
    path.write_text(json.dumps(cases, ensure_ascii=False), encoding="utf-8")
    return path


def case(name: str, message: str, scope: list[str] | None = None) -> dict:
    return {
        "name": name,
        "input": message,
        "expected_output": f"expected for {name}",
        "additional_metadata": {"scope": scope if scope is not None else []},
    }


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def all_run_text(run_dir: Path) -> str:
    chunks = []
    for path in sorted(run_dir.rglob("*")):
        if path.is_file():
            chunks.append(path.read_text(encoding="utf-8", errors="replace"))
    return "\n".join(chunks)


def test_answer_is_persisted_before_first_judge_and_readable_after_judge_failure(
    tmp_path: Path,
) -> None:
    dataset = write_dataset(
        tmp_path / "dataset.json",
        [case("case-a", "question-a"), case("case-b", "question-b")],
    )
    replies = {"question-a": "answer-a", "question-b": "answer-b"}
    observed: list[dict] = []

    def judge(record: dict, context: dict) -> dict:
        sample_path = Path(context["sample_path"])
        on_disk = read_json(sample_path) if sample_path.exists() else None
        observed.append(
            {
                "case_id": record["case_id"],
                "file_existed": on_disk is not None,
                "on_disk_answer": (on_disk or {}).get("agent", {}).get("answer"),
                "on_disk_sha": (on_disk or {}).get("agent", {}).get("answer_sha256"),
                "chat_requests": backend.chat_requests,
                "manifest_path": str(Path(context["run_dir"]) / "manifest.json"),
            }
        )
        if record["case_id"] == "case-b":
            raise RuntimeError(
                f"judge exploded; Authorization: Bearer {JUDGE_SECRET}; "
                f"Cookie: session={JUDGE_SECRET}; api_key={JUDGE_SECRET}"
            )
        return {"score": 1.0, "metric": "fake-exact", "success": True}

    with stub_backend(replies) as backend:
        outcome = run_suite.execute_run(
            tmp_path / "runs",
            dataset_path=dataset,
            cases=["case-a", "case-b"],
            judge=judge,
            base_url=backend.base_url,
            password="stub-password",
        )

    assert outcome.exit_code == 1
    assert len(observed) == 2
    first = observed[0]
    assert first["file_existed"] is True
    assert first["on_disk_answer"] == "answer-a"
    assert first["on_disk_sha"] == hashlib.sha256(b"answer-a").hexdigest()
    assert first["chat_requests"] == 1
    # The judge is never invoked before its sample answer is on disk.
    assert observed[1]["chat_requests"] == 2

    summary = outcome.summary
    assert summary["planned"] == 2
    assert summary["scored"] == 1
    assert summary["judge_errors"] == 1
    assert summary["incomplete"] is True
    assert summary["score"] is None

    reopened = ledger.RunLedger.open(outcome.run_dir)
    recovered = reopened.read_answer(outcome.summary["samples"][1]["sample_id"])
    assert recovered["answer"] == "answer-b"
    assert recovered["answer_sha256"] == hashlib.sha256(b"answer-b").hexdigest()

    failed_sample = read_json(
        outcome.run_dir / "samples" / f"{summary['samples'][1]['sample_id']}.json"
    )
    assert failed_sample["status"] == "judge_error"
    assert failed_sample["judge"]["score"] is None
    assert "judge exploded" in failed_sample["judge"]["error"]
    text = all_run_text(outcome.run_dir)
    assert TOKEN not in text
    assert JUDGE_SECRET not in text
    assert "stub-password" not in text

    manifest_at_judge = read_json(Path(first["manifest_path"]))
    assert manifest_at_judge["frozen"] is True
    assert len(manifest_at_judge["planned"]) == 2

    chat_requests = [item for item in backend.requests if item["path"] == "/api/chat"]
    login_requests = [item for item in backend.requests if item["path"] == "/api/auth/login"]
    assert len(login_requests) == 1
    assert len(chat_requests) == 2
    assert len({item["body"]["sessionId"] for item in chat_requests}) == 2
    assert all(item["body"]["stream"] is False for item in chat_requests)
    assert all(item["authorization_is_bearer"] for item in chat_requests)


def test_unwritable_run_root_fails_before_any_request(tmp_path: Path) -> None:
    blocker = tmp_path / "blocked"
    blocker.write_text("not a directory", encoding="utf-8")
    dataset = write_dataset(tmp_path / "dataset.json", [case("case-a", "question-a")])

    with stub_backend({"question-a": "answer-a"}) as backend:
        outcome = run_suite.execute_run(
            blocker / "runs",
            dataset_path=dataset,
            judge=lambda record, context: {"score": 1.0, "metric": "fake"},
            base_url=backend.base_url,
            password="stub-password",
        )

    assert outcome.exit_code != 0
    assert outcome.incomplete is True
    assert outcome.score is None
    assert outcome.summary is None
    assert outcome.error and "run root" in outcome.error
    assert backend.requests == []


def test_truncated_sample_json_makes_run_incomplete(tmp_path: Path) -> None:
    dataset = write_dataset(tmp_path / "dataset.json", [case("case-a", "question-a")])
    with stub_backend({"question-a": "answer-a"}) as backend:
        outcome = run_suite.execute_run(
            tmp_path / "runs",
            dataset_path=dataset,
            judge=lambda record, context: {"score": 1.0, "metric": "fake"},
            base_url=backend.base_url,
            password="stub-password",
        )
    assert outcome.exit_code == 0
    sample_path = outcome.run_dir / "samples" / f"{outcome.summary['samples'][0]['sample_id']}.json"
    raw = sample_path.read_bytes()
    sample_path.write_bytes(raw[: len(raw) // 2])

    rebuilt = run_suite.rebuild_run(outcome.run_dir)
    assert rebuilt.exit_code != 0
    assert rebuilt.score is None
    assert rebuilt.incomplete is True
    assert rebuilt.summary["corrupt"]
    assert any(
        reason["kind"] == "corrupt_sample" for reason in rebuilt.summary["reasons"]
    )
    assert [item["status"] for item in rebuilt.summary["samples"]] == ["corrupt"]
    assert rebuilt.summary["samples"][0]["sample_id"] == outcome.summary["samples"][0][
        "sample_id"
    ]
    assert read_json(outcome.run_dir / "summary.json")["score"] is None
    status = read_json(outcome.run_dir / "run_status.json")
    assert status["incomplete"] is True and status["score"] is None


def test_missing_sample_row_makes_run_incomplete(tmp_path: Path) -> None:
    dataset = write_dataset(
        tmp_path / "dataset.json",
        [case("case-a", "question-a"), case("case-b", "question-b")],
    )
    with stub_backend({"question-a": "answer-a", "question-b": "answer-b"}) as backend:
        outcome = run_suite.execute_run(
            tmp_path / "runs",
            dataset_path=dataset,
            judge=lambda record, context: {"score": 1.0, "metric": "fake"},
            base_url=backend.base_url,
            password="stub-password",
        )
    assert outcome.exit_code == 0
    missing_id = outcome.summary["samples"][0]["sample_id"]
    (outcome.run_dir / "samples" / f"{missing_id}.json").unlink()

    rebuilt = run_suite.rebuild_run(outcome.run_dir)
    assert rebuilt.exit_code != 0
    assert rebuilt.score is None
    assert rebuilt.summary["missing"] == [missing_id]
    assert rebuilt.summary["not_started"] == 1
    assert rebuilt.summary["planned"] == 2
    assert rebuilt.summary["scored"] == 1


def test_summary_write_failure_is_incomplete_with_no_score(tmp_path: Path) -> None:
    dataset = write_dataset(tmp_path / "dataset.json", [case("case-a", "question-a")])
    runs_root = tmp_path / "runs"

    def judge(record: dict, context: dict) -> dict:
        # Real failure injection: occupy summary.json with a directory so the
        # atomic replace cannot publish the summary.
        (Path(context["run_dir"]) / "summary.json").mkdir()
        return {"score": 1.0, "metric": "fake"}

    with stub_backend({"question-a": "answer-a"}) as backend:
        outcome = run_suite.execute_run(
            runs_root,
            dataset_path=dataset,
            judge=judge,
            base_url=backend.base_url,
            password="stub-password",
        )

    assert outcome.exit_code != 0
    assert outcome.score is None
    assert outcome.incomplete is True
    assert outcome.error and "summary" in outcome.error.lower()
    status = read_json(outcome.run_dir / "run_status.json")
    assert status["incomplete"] is True
    assert status["score"] is None
    assert "summary" in status["error"].lower()
    # The sample itself stayed intact; only the projection failed.
    sample = read_json(
        outcome.run_dir / "samples" / f"{outcome.manifest['planned'][0]['sample_id']}.json"
    )
    assert sample["agent"]["answer"] == "answer-a"
    assert sample["status"] == "scored"


def test_agent_and_judge_errors_remain_in_the_planned_denominator(tmp_path: Path) -> None:
    dataset = write_dataset(
        tmp_path / "dataset.json",
        [
            case("case-ok", "question-ok"),
            case("case-http", "question-http"),
            case("case-judge", "question-judge"),
        ],
    )

    def judge(record: dict, context: dict) -> dict:
        if record["case_id"] == "case-judge":
            raise RuntimeError("judge unavailable")
        return {"score": 1.0, "metric": "fake"}

    with stub_backend(
        {"question-ok": "answer-ok", "question-judge": "answer-judge"},
        fail_messages={"question-http"},
    ) as backend:
        outcome = run_suite.execute_run(
            tmp_path / "runs",
            dataset_path=dataset,
            judge=judge,
            base_url=backend.base_url,
            password="stub-password",
        )

    assert outcome.exit_code != 0
    assert outcome.score is None
    assert outcome.summary["planned"] == 3
    assert outcome.summary["persisted"] == 3
    assert outcome.summary["scored"] == 1
    assert outcome.summary["agent_errors"] == 1
    assert outcome.summary["judge_errors"] == 1
    assert outcome.summary["not_started"] == 0
    assert len(outcome.manifest["planned"]) == 3
    assert outcome.manifest["frozen"] is True
    assert outcome.manifest["planned"][2]["case_id"] == "case-judge"

    http_sample = read_json(
        outcome.run_dir / "samples" / f"{outcome.summary['samples'][1]['sample_id']}.json"
    )
    assert http_sample["status"] == "agent_error"
    assert http_sample["agent"]["answer"] is None
    assert http_sample["judge"]["status"] == "not_attempted"
    assert "HTTP 500" in http_sample["agent"]["error"]

    text = all_run_text(outcome.run_dir)
    assert TOKEN not in text
    assert "Bearer stub-access-token" not in text


def test_empty_selection_is_fatal_and_creates_no_run(tmp_path: Path) -> None:
    dataset = write_dataset(tmp_path / "dataset.json", [case("case-a", "question-a")])
    runs_root = tmp_path / "runs"
    with stub_backend({"question-a": "answer-a"}) as backend:
        outcome = run_suite.execute_run(
            runs_root,
            dataset_path=dataset,
            cases=["does-not-exist"],
            judge=lambda record, context: {"score": 1.0, "metric": "fake"},
            base_url=backend.base_url,
            password="stub-password",
        )
    assert outcome.exit_code != 0
    assert outcome.score is None
    assert outcome.incomplete is True
    assert backend.requests == []
    assert not runs_root.exists() or not any(runs_root.iterdir())


@pytest.fixture(autouse=True)
def _clean_secret_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep ambient credentials out of snapshots; tests set what they need."""
    for name in list(os.environ):
        if any(
            marker in name.upper()
            for marker in ("TOKEN", "SECRET", "PASSWORD", "API_KEY", "COOKIE")
        ):
            monkeypatch.delenv(name, raising=False)


def make_ledger(tmp_path: Path, count: int = 6) -> ledger.RunLedger:
    planned = [
        {"sample_id": f"sample-{index:02d}", "case_id": f"case-{index:02d}"}
        for index in range(count)
    ]
    return ledger.RunLedger.create(
        tmp_path / "runs",
        planned=planned,
        manifest={"suite": {"name": "ledger-test", "version": "1"}},
        environment={"schema_version": 1, "values_recorded": False},
    )


def scored_record(sample_id: str, case_id: str, score: float = 1.0) -> dict:
    answer = f"answer for {sample_id}"
    return {
        "sample_id": sample_id,
        "case_id": case_id,
        "sample_index": 0,
        "status": "scored",
        "agent": {"answer": answer},
        "judge": {"status": "scored", "score": score, "metric": "fake"},
    }


def file_hashes(run_dir: Path) -> dict[str, str]:
    return {
        str(path.relative_to(run_dir)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(run_dir.rglob("*"))
        if path.is_file() and path.name != "summary.lock"
    }


def test_sample_write_failure_is_explicit_and_summary_is_incomplete(
    tmp_path: Path,
) -> None:
    run = make_ledger(tmp_path, count=1)
    sample_id = run.manifest["planned"][0]["sample_id"]
    case_id = run.manifest["planned"][0]["case_id"]

    # Real failure injection: the samples directory becomes unusable.
    for path in run.samples_dir.iterdir():
        path.unlink()
    run.samples_dir.rmdir()
    run.samples_dir.write_text("not a directory", encoding="utf-8")

    with pytest.raises(ledger.SampleWriteError):
        run.write_sample(scored_record(sample_id, case_id))
    assert not (run.run_dir / "summary.json").exists()

    summary = run.finalize()
    assert summary["incomplete"] is True
    assert summary["score"] is None
    assert summary["planned"] == 1
    assert summary["missing"] == [sample_id]


def test_concurrent_workers_only_write_their_own_samples(tmp_path: Path) -> None:
    run = make_ledger(tmp_path, count=12)
    summary_seen = threading.Event()
    workers_done = threading.Event()

    def watch_summary() -> None:
        while not workers_done.wait(0.005):
            if (run.run_dir / "summary.json").exists():
                summary_seen.set()
                return

    watcher = threading.Thread(target=watch_summary, daemon=True)
    watcher.start()
    try:
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(
                pool.map(
                    lambda item: run.write_sample(
                        scored_record(item["sample_id"], item["case_id"])
                    ),
                    run.manifest["planned"],
                )
            )
    finally:
        workers_done.set()
        watcher.join(timeout=5)

    assert summary_seen.is_set() is False
    assert not (run.run_dir / "summary.json").exists()
    assert not [
        path
        for path in run.samples_dir.iterdir()
        if path.name.endswith(".tmp")
    ]

    summary = run.finalize()
    assert summary["planned"] == 12
    assert summary["scored"] == 12
    assert summary["incomplete"] is False
    assert summary["score"] == 1.0
    for item in run.manifest["planned"]:
        recovered = run.read_answer(item["sample_id"])
        assert recovered["answer"] == f"answer for {item['sample_id']}"


def test_summary_has_a_single_writer_lock(tmp_path: Path) -> None:
    run = make_ledger(tmp_path, count=2)
    for item in run.manifest["planned"]:
        run.write_sample(scored_record(item["sample_id"], item["case_id"]))

    lock = portalocker.Lock(
        str(run.run_dir / "summary.lock"),
        mode="a",
        timeout=0,
        flags=portalocker.LOCK_EX | portalocker.LOCK_NB,
    )
    lock.acquire()
    try:
        with pytest.raises(ledger.SummaryBusy):
            run.finalize()
    finally:
        lock.release()
    assert not (run.run_dir / "summary.json").exists()

    first = run.finalize()
    before = (run.run_dir / "summary.json").read_bytes()
    lock.acquire()
    try:
        with pytest.raises(ledger.SummaryBusy):
            run.finalize()
    finally:
        lock.release()
    assert (run.run_dir / "summary.json").read_bytes() == before
    assert first["score"] == 1.0


def test_run_directories_are_unique_and_history_is_not_overwritten(
    tmp_path: Path,
) -> None:
    dataset = write_dataset(
        tmp_path / "dataset.json",
        [case("case-a", "question-a"), case("case-b", "question-b")],
    )
    runs_root = tmp_path / "runs"
    with stub_backend(
        {"question-a": "answer-a", "question-b": "answer-b"}
    ) as backend:
        first = run_suite.execute_run(
            runs_root,
            dataset_path=dataset,
            cases=["case-a"],
            judge=lambda record, context: {"score": 1.0, "metric": "fake"},
            base_url=backend.base_url,
            password="stub-password",
        )
        second = run_suite.execute_run(
            runs_root,
            dataset_path=dataset,
            cases=["case-b"],
            judge=lambda record, context: {"score": 0.0, "metric": "fake"},
            base_url=backend.base_url,
            password="stub-password",
        )

    assert first.exit_code == 0 and second.exit_code == 0
    assert first.run_dir != second.run_dir
    assert first.run_dir.parent == second.run_dir.parent == runs_root.resolve()
    assert first.summary["planned"] == 1
    assert second.summary["planned"] == 1
    assert first.manifest["planned"][0]["case_id"] == "case-a"
    assert second.manifest["planned"][0]["case_id"] == "case-b"
    first_hashes = file_hashes(first.run_dir)
    assert len(first_hashes) >= 5
    # Running again did not rewrite a single byte of the earlier run.
    assert file_hashes(first.run_dir) == first_hashes


def test_rebuild_reconstructs_summary_from_sample_records_only(
    tmp_path: Path,
) -> None:
    dataset = write_dataset(
        tmp_path / "dataset.json",
        [case("case-a", "question-a"), case("case-b", "question-b")],
    )
    scores = iter([0.25, 0.75])

    def judge(record: dict, context: dict) -> dict:
        return {"score": next(scores), "metric": "fake"}

    with stub_backend(
        {"question-a": "answer-a", "question-b": "answer-b"}
    ) as backend:
        outcome = run_suite.execute_run(
            tmp_path / "runs",
            dataset_path=dataset,
            judge=judge,
            base_url=backend.base_url,
            password="stub-password",
        )
    assert outcome.exit_code == 0
    assert outcome.summary["score"] == 0.5
    original = dict(outcome.summary)
    samples_before = {
        key: value
        for key, value in file_hashes(outcome.run_dir).items()
        if key.startswith("samples/") or key in {"manifest.json", "environment.json"}
    }

    # A maintainer may find a corrupt or missing summary; samples are enough.
    (outcome.run_dir / "summary.json").write_text("{ not valid json", encoding="utf-8")
    rebuilt = run_suite.rebuild_run(outcome.run_dir)
    assert rebuilt.exit_code == 0
    assert rebuilt.summary["incomplete"] is False
    assert rebuilt.summary["score"] == 0.5
    assert rebuilt.summary["planned"] == 2
    assert rebuilt.summary["scored"] == 2
    for key in ("planned", "persisted", "scored", "score", "samples", "reasons"):
        assert rebuilt.summary[key] == original[key]
    assert {
        key: value
        for key, value in file_hashes(outcome.run_dir).items()
        if key.startswith("samples/") or key in {"manifest.json", "environment.json"}
    } == samples_before


def test_environment_snapshot_and_error_records_have_no_secret_values(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    password = "env-password-value-123"
    api_key = "sk-live-secret-value-456"
    monkeypatch.setenv("DEMO_OIDC_PASSWORD", password)
    monkeypatch.setenv("NEXUSRAG_EVAL_API_KEY", api_key)
    dataset = write_dataset(tmp_path / "dataset.json", [case("case-a", "question-a")])

    def judge(record: dict, context: dict) -> dict:
        raise RuntimeError(
            f"judge failed with {api_key}; Authorization: Bearer bearer-value-789; "
            f"Cookie: session=cookie-value-000"
        )

    with stub_backend({"question-a": "answer-a"}) as backend:
        outcome = run_suite.execute_run(
            tmp_path / "runs",
            dataset_path=dataset,
            judge=judge,
            base_url=backend.base_url,
        )

    assert outcome.exit_code != 0
    snapshot = read_json(outcome.run_dir / "environment.json")
    assert snapshot["packages"]["deepeval"] == "4.2.8"
    assert snapshot["packages"]["portalocker"]
    assert snapshot["configuration"]["budgets"]["planned_samples"] == 1
    assert snapshot["run_version"]["commit"] != "unavailable"
    assert snapshot["environment"]["values_recorded"] is False
    assert "DEMO_OIDC_PASSWORD" in snapshot["environment"]["credential_names_present"]
    assert "NEXUSRAG_EVAL_API_KEY" in snapshot["environment"]["credential_names_present"]

    sample = read_json(
        outcome.run_dir / "samples" / f"{outcome.summary['samples'][0]['sample_id']}.json"
    )
    assert sample["status"] == "judge_error"
    assert "judge failed" in sample["judge"]["error"]
    assert "REDACTED" in sample["judge"]["error"]

    text = all_run_text(outcome.run_dir)
    for secret in (password, api_key, TOKEN, "bearer-value-789", "cookie-value-000"):
        assert secret not in text


def test_cli_plugin_judge_and_rebuild_exit_codes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture
) -> None:
    monkeypatch.setenv("DEMO_OIDC_PASSWORD", "stub-password")
    dataset = write_dataset(tmp_path / "dataset.json", [case("case-a", "question-a")])
    plugin = tmp_path / "judge_plugin.py"
    plugin.write_text(
        "def judge(record, context):\n"
        "    return {'score': 0.5, 'metric': 'plugin-fake'}\n",
        encoding="utf-8",
    )

    with stub_backend({"question-a": "answer-a"}) as backend:
        code = run_suite.main(
            [
                "--runs-root",
                str(tmp_path / "runs"),
                "--dataset",
                str(dataset),
                "--case",
                "case-a",
                "--judge",
                f"{plugin}:judge",
                "--base-url",
                backend.base_url,
            ]
        )
    assert code == 0
    payload = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert payload["score"] == 0.5
    assert payload["incomplete"] is False
    run_dir = Path(payload["run_dir"])

    sample_path = run_dir / "samples" / f"{payload['samples'][0]['sample_id']}.json"
    sample_path.write_text(sample_path.read_text(encoding="utf-8")[:20], encoding="utf-8")
    rebuilt_code = run_suite.main(["--rebuild", str(run_dir)])
    assert rebuilt_code != 0
    rebuilt_payload = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert rebuilt_payload["score"] is None
    assert rebuilt_payload["incomplete"] is True
