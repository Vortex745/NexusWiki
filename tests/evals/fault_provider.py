"""Local TypeSafe ``/v1/systemone`` fault provider for DR-05 judge-retry tests.

This is a real HTTP server: DeepEval's own provider retry decorator and the
TypeSafe SDK's HTTP client talk to it over a socket, so request counts,
statuses, connection drops and hangs are observed exactly as the judge sees
them. It is not a mock of the SDK.

Each POST consumes the next scripted step; when the script is exhausted the
``default`` step is repeated. Every request is logged with its path, body,
headers, step and timing so a test (or the live evidence run) can count the
actual attempts and waits.

CLI (used by the DR-05 live-path evidence):

  python tests/evals/fault_provider.py --steps 503,503 --port 0 \
      --ready-file ready.json --report requests.json
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Sequence

SYSTEM_ONE_PATH = "/v1/systemone"
DEFAULT_PROBABILITY = 0.93
INVALID_BODY = {"model": "jev-latest", "answers": {}}
SENSITIVE_HEADERS = {
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
    "api-key",
}


def _safe_headers(headers) -> dict[str, str]:
    """Report headers without the credential the SDK sends."""
    return {
        key: "[REDACTED]" if key.lower() in SENSITIVE_HEADERS else value
        for key, value in headers.items()
    }


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


@dataclass(frozen=True)
class Step:
    kind: str  # success | status | drop | hang | invalid
    status: int | None = None
    probability: float = DEFAULT_PROBABILITY
    seconds: float = 0.0

    @property
    def name(self) -> str:
        if self.kind == "status":
            return f"status:{self.status}"
        return self.kind


def success(probability: float = DEFAULT_PROBABILITY) -> Step:
    return Step("success", probability=probability)


def status(code: int) -> Step:
    return Step("status", status=code)


def drop() -> Step:
    """Accept the request, close the connection without an HTTP response."""
    return Step("drop")


def hang(seconds: float = 30.0) -> Step:
    """Accept the request and stay silent for ``seconds`` (a read timeout)."""
    return Step("hang", seconds=seconds)


def invalid_body() -> Step:
    """A 200 whose JSON body fails the SDK response contract."""
    return Step("invalid")


STEP_BUILDERS = {
    "success": success,
    "drop": drop,
    "invalid": invalid_body,
    "200": success,
}


def _step_from_token(token: str) -> Step:
    token = token.strip()
    if token in STEP_BUILDERS:
        return STEP_BUILDERS[token]()
    if token.startswith("hang:"):
        return hang(float(token.split(":", 1)[1]))
    if token.startswith("success:"):
        return success(float(token.split(":", 1)[1]))
    return status(int(token))


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args) -> None:  # keep pytest output clean
        pass

    def do_POST(self) -> None:  # noqa: N802 - http.server API
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            body = json.loads(raw or b"{}")
        except (json.JSONDecodeError, UnicodeDecodeError):
            body = {}
        provider: "FaultProvider" = self.server.provider  # type: ignore[attr-defined]
        record = provider._begin_request(self, body)
        step = record["step"]
        try:
            if step.kind == "drop":
                record["outcome"] = "connection_closed"
                self.close_connection = True
                try:
                    self.connection.close()
                except OSError:
                    pass
                return
            if step.kind == "hang":
                record["outcome"] = "hung"
                self.close_connection = True
                time.sleep(step.seconds)
            payload, code = provider._payload_for(step, body)
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            record["status"] = code
            record["outcome"] = "served"
        except OSError:
            record["outcome"] = record.get("outcome") or "client_gone"
        finally:
            record["responded_at"] = utc_now()
            provider._persist()


class FaultProvider:
    """A threaded server that replays scripted success/failure steps."""

    def __init__(
        self,
        steps: Sequence[Step],
        *,
        default: Step | None = None,
        report_path: str | Path | None = None,
        port: int = 0,
    ) -> None:
        if not steps:
            raise ValueError("a fault provider needs at least one scripted step")
        self._steps = list(steps)
        self._default = default or self._steps[-1]
        self._index = 0
        self._lock = threading.Lock()
        self._requests: list[dict[str, Any]] = []
        self._report_path = Path(report_path).resolve() if report_path else None
        self.server = ThreadingHTTPServer(("127.0.0.1", port), _Handler)
        self.server.daemon_threads = True
        self.server.provider = self  # type: ignore[attr-defined]
        self.thread = threading.Thread(
            target=self.server.serve_forever, daemon=True, name="dr05-fault-provider"
        )
        self._started = False

    # -- lifecycle ------------------------------------------------------
    def __enter__(self) -> "FaultProvider":
        self.thread.start()
        self._started = True
        return self

    def __exit__(self, *_exc) -> None:
        if self._started:
            self.server.shutdown()
            self.server.server_close()
            self.thread.join(timeout=5)
            self._started = False

    # -- observations ---------------------------------------------------
    @property
    def base_url(self) -> str:
        host, port = self.server.server_address[:2]
        return f"http://{host}:{port}"

    @property
    def requests(self) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(item) for item in self._requests]

    @property
    def request_count(self) -> int:
        with self._lock:
            return len(self._requests)

    def wait_for_requests(self, count: int, timeout: float = 5.0) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.request_count >= count:
                return True
            time.sleep(0.02)
        return self.request_count >= count

    # -- request handling ----------------------------------------------
    def _begin_request(self, handler: BaseHTTPRequestHandler, body: dict) -> dict:
        with self._lock:
            step = (
                self._steps[self._index]
                if self._index < len(self._steps)
                else self._default
            )
            self._index += 1
            record = {
                "number": len(self._requests) + 1,
                "path": handler.path,
                "method": handler.command,
                "step": step,
                "body": body,
                "headers": _safe_headers(handler.headers),
                "received_at": utc_now(),
                "received_monotonic": time.monotonic(),
                "responded_at": None,
                "outcome": "in_flight",
                "status": None,
                "probability": step.probability,
            }
            self._requests.append(record)
        self._persist()
        return record

    @staticmethod
    def _payload_for(step: Step, body: dict) -> tuple[bytes, int]:
        if step.kind == "invalid":
            return json.dumps(INVALID_BODY).encode("utf-8"), 200
        if step.kind == "status":
            return (
                json.dumps({"error": f"scripted HTTP {step.status}"}).encode("utf-8"),
                int(step.status or 500),
            )
        questions = body.get("questions") or {"q_0": {"type": "noul"}}
        answers = {
            name: {"type": "noul", "noul": float(step.probability)}
            for name, question in questions.items()
            if isinstance(question, dict) and question.get("type") == "noul"
        }
        payload = {
            "model": body.get("model") or "jev-latest",
            "answers": answers,
            "usage": {"input_tokens": 12, "output_tokens": 1},
        }
        return json.dumps(payload).encode("utf-8"), 200

    # -- public report --------------------------------------------------
    def report(self) -> dict:
        with self._lock:
            requests = [dict(item, step=item["step"].name) for item in self._requests]
        return {
            "base_url": self.base_url,
            "script": [step.name for step in self._steps],
            "default": self._default.name,
            "request_count": len(requests),
            "requests": requests,
        }

    def _persist(self) -> None:
        if self._report_path is None:
            return
        payload = self.report()
        tmp = self._report_path.with_name(self._report_path.name + ".tmp")
        try:
            self._report_path.parent.mkdir(parents=True, exist_ok=True)
            tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
            os.replace(tmp, self._report_path)
        except OSError:
            pass


def _port(provider: FaultProvider) -> int:
    return int(provider.server.server_address[1])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Scripted TypeSafe /v1/systemone fault provider")
    parser.add_argument("--steps", required=True, help="comma list, e.g. 503,429,success,drop,invalid")
    parser.add_argument(
        "--default",
        help="step repeated after the script is exhausted (default: the last step)",
    )
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--ready-file", help="write {base_url, port} once listening")
    parser.add_argument("--report", help="write the request report here (updated per request)")
    parser.add_argument("--hold-seconds", type=float, default=120.0)
    args = parser.parse_args(argv)

    steps = [_step_from_token(token) for token in args.steps.split(",") if token.strip()]
    default = _step_from_token(args.default) if args.default else None
    provider = FaultProvider(
        steps, default=default, report_path=args.report, port=args.port
    )
    with provider:
        ready = {"base_url": provider.base_url, "port": _port(provider)}
        if args.ready_file:
            path = Path(args.ready_file).resolve()
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(ready), encoding="utf-8")
        print(json.dumps(ready), flush=True)
        stopped = threading.Event()

        def _stop(*_args) -> None:
            stopped.set()

        for name in ("SIGINT", "SIGTERM"):
            handler = getattr(signal, name, None)
            if handler is not None:
                try:
                    signal.signal(handler, _stop)
                except (ValueError, OSError):
                    pass
        stopped.wait(args.hold_seconds)
        provider._persist()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
