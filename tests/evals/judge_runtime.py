"""Bounded Jev judge runtime with per-case metrics and one retry layer (DR-05/06).

The judge scores an Agent answer that ``run_suite`` already persisted. It
never re-sends the chat request, so retrying a judge cannot re-run a stateful
Agent action.

Per-case metrics (DR-06): every case is judged with a fresh metric set from
``metrics.build_case_metrics``. The result carries one entry per metric with
``applicability`` (``applicable`` / ``not_applicable``), score, success,
reason, error and the Jev question breakdown, so a memory-only case can show
document Grounding as ``not_applicable`` instead of a zero or a pass. The
Grounding retrieval context is built from the returned reference titles and
bounded excerpts (600 characters each) - cited-evidence summaries, not the
full generation context. A case with no references uses an explicit
"no documents retrieved" marker; memory-only cases never reach Grounding and
therefore never get a synthetic retrieval context.

Retry contract (fixed by DR-05, enforced through DeepEval's own provider
retry decorator - there is no retry loop in this module):

  DEEPEVAL_RETRY_MAX_ATTEMPTS=3                     total attempts, not retries
  DEEPEVAL_PER_ATTEMPT_TIMEOUT_SECONDS_OVERRIDE=10  soft per-attempt timeout
  DEEPEVAL_PER_TASK_TIMEOUT_SECONDS_OVERRIDE=45     one-metric total budget
  DEEPEVAL_SDK_RETRY_PROVIDERS                      left unset, so
                                                    TypeSafeModel passes
                                                    RetryPolicy(max_retries=0)

Only connection errors, timeouts, 429 and retryable 5xx are retried by the
TypeSafe error policy. 401/403/451, invalid requests, invalid responses and
low scores are single-attempt outcomes and are never converted into a pass.

Usage:

  python tests/evals/run_suite.py --judge tests/evals/judge_runtime.py:judge

Environment:
  TYPESAFE_API_KEY          Jev credential (required for a real call)
  NEXUSRAG_JUDGE_BASE_URL   optional judge endpoint override (evidence only)
  TYPESAFE_MODEL_NAME       optional model alias (default jev-latest)

Every invocation records per-attempt outcomes (attempt number, wait, status,
error class, duration) and the applied budget in the sample's
``judge.details``. A permanent failure or budget exhaustion raises
``JudgeFailure`` (details attached) so run_suite writes score=null and a
non-zero exit while the raw Agent answer stays readable.
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from pathlib import Path
from typing import Any, Callable, Mapping

import ledger

TICKET = "DR-05"
DEFAULT_MODEL = "jev-latest"
METRIC_NAME = "Task Resolution"

# Applied before DeepEval builds its settings singleton. Explicit environment
# values win, so evidence runs can tighten budgets; the committed contract is
# the default below.
CONTRACT_ENVIRONMENT = {
    "DEEPEVAL_RETRY_MAX_ATTEMPTS": "3",
    "DEEPEVAL_PER_ATTEMPT_TIMEOUT_SECONDS_OVERRIDE": "10",
    "DEEPEVAL_PER_TASK_TIMEOUT_SECONDS_OVERRIDE": "45",
    "DEEPEVAL_TELEMETRY_OPT_OUT": "YES",
    "DEEPEVAL_NO_INSPECT_PROMPT": "1",
}


class JudgeConfigurationError(RuntimeError):
    """The judge cannot guarantee a single, bounded retry layer."""


class JudgeFailure(RuntimeError):
    """The judge produced no score; ``details`` carries the attempt record."""

    def __init__(self, message: str, details: dict | None = None) -> None:
        super().__init__(message)
        self.details = details or {}


def _sdk_retry_providers() -> list[str]:
    raw = os.environ.get("DEEPEVAL_SDK_RETRY_PROVIDERS") or ""
    return [part.strip().lower() for part in raw.replace(";", ",").split(",") if part.strip()]


def configure_retry_environment(environ: dict | None = None) -> dict:
    """Apply the DR-05 retry contract and refuse a stacked SDK retry layer."""
    target = os.environ if environ is None else environ
    for name, value in CONTRACT_ENVIRONMENT.items():
        target.setdefault(name, value)
    providers = _sdk_retry_providers() if environ is None else [
        part.strip().lower()
        for part in (environ.get("DEEPEVAL_SDK_RETRY_PROVIDERS") or "").replace(";", ",").split(",")
        if part.strip()
    ]
    if "*" in providers or "typesafe" in providers:
        raise JudgeConfigurationError(
            "DEEPEVAL_SDK_RETRY_PROVIDERS enables TypeSafe SDK retries on top of "
            "DeepEval's retry layer; unset it so RetryPolicy(max_retries=0) applies"
        )
    return {name: target.get(name) for name in CONTRACT_ENVIRONMENT}


configure_retry_environment()

from deepeval.config.settings import get_settings  # noqa: E402
from deepeval.constants import ProviderSlug as PS  # noqa: E402
from deepeval.models.retry_policy import (  # noqa: E402
    reset_outer_deadline,
    set_outer_deadline,
    sdk_retries_for,
)
from deepeval.models.system_one.typesafe_model import TypeSafeModel  # noqa: E402
from deepeval.test_case import LLMTestCase, SingleTurnParams  # noqa: E402
from tenacity import RetryError  # noqa: E402
import httpx2  # noqa: E402

import metrics  # noqa: E402

THRESHOLD = metrics.DEFAULT_THRESHOLD
JUDGE_QUESTION = metrics.GENERIC_TASK_QUESTION

EVAL_DIR = Path(__file__).resolve().parent
REPO_ROOT = EVAL_DIR.parent.parent

NO_EVIDENCE_MARKER = (
    "(no documents retrieved - the app returned no references for this query)"
)
MAX_EVIDENCE_CHARS = 600


def _dot_env(key: str) -> str:
    for candidate in (REPO_ROOT / ".env",):
        try:
            for line in candidate.read_text(encoding="utf-8").splitlines():
                if line.startswith(key + "="):
                    return line.split("=", 1)[1].strip()
        except OSError:
            continue
    return ""


def _budget_snapshot() -> dict:
    settings = get_settings()
    task_timeout = float(settings.DEEPEVAL_PER_TASK_TIMEOUT_SECONDS)
    return {
        "max_attempts": int(settings.DEEPEVAL_RETRY_MAX_ATTEMPTS),
        "per_attempt_timeout_s": float(settings.DEEPEVAL_PER_ATTEMPT_TIMEOUT_SECONDS),
        "task_timeout_s": task_timeout,
        "outer_deadline_s": task_timeout,
        "sdk_retries": bool(sdk_retries_for(PS.TYPESAFE)),
        "sdk_retry_providers_set": bool(os.environ.get("DEEPEVAL_SDK_RETRY_PROVIDERS")),
        "backoff": {
            "initial_s": float(settings.DEEPEVAL_RETRY_INITIAL_SECONDS),
            "exp_base": float(settings.DEEPEVAL_RETRY_EXP_BASE),
            "jitter_s": float(settings.DEEPEVAL_RETRY_JITTER),
            "cap_s": float(settings.DEEPEVAL_RETRY_CAP_SECONDS),
        },
    }


class AttemptRecorder:
    """Observes every HTTP attempt the SDK makes through the judge client."""

    def __init__(self, per_attempt_timeout_s: float) -> None:
        self._lock = threading.Lock()
        self._attempts: list[dict[str, Any]] = []
        self._closed = False
        self._last_end: float | None = None
        self._per_attempt = float(per_attempt_timeout_s)

    def begin(self) -> int:
        with self._lock:
            now = time.monotonic()
            self._close_open_locked(now)
            wait_ms = None
            if self._last_end is not None:
                wait_ms = max(0, int(round((now - self._last_end) * 1000)))
            self._attempts.append(
                {
                    "attempt": len(self._attempts) + 1,
                    "started_at": ledger.utc_now(),
                    "started_monotonic": now,
                    "wait_before_ms": wait_ms,
                    "duration_ms": None,
                    "duration_source": None,
                    "outcome": "in_flight",
                    "http_status": None,
                    "error_class": None,
                }
            )
            return len(self._attempts) - 1

    def finish(self, index: int, *, status: int | None = None, error: BaseException | None = None) -> None:
        with self._lock:
            if self._closed or not 0 <= index < len(self._attempts):
                return
            attempt = self._attempts[index]
            if attempt["outcome"] != "in_flight":
                return
            now = time.monotonic()
            attempt["duration_ms"] = max(0, int(round((now - attempt["started_monotonic"]) * 1000)))
            attempt["duration_source"] = "measured"
            self._last_end = now
            if error is None:
                attempt["http_status"] = status
                attempt["outcome"] = (
                    "success" if status is not None and 200 <= status < 300 else "http_error"
                )
            elif isinstance(error, Exception) and error.__class__.__name__.endswith("TimeoutException"):
                attempt["outcome"] = "timeout"
                attempt["error_class"] = type(error).__name__
            elif isinstance(error, Exception) and "Timeout" in type(error).__name__:
                attempt["outcome"] = "timeout"
                attempt["error_class"] = type(error).__name__
            else:
                attempt["outcome"] = "connection_error"
                attempt["error_class"] = type(error).__name__

    def close(self) -> None:
        with self._lock:
            self._closed = True
            now = time.monotonic()
            # The last attempt may have been abandoned at the metric deadline
            # (remaining budget < per-attempt timeout); report the wall time
            # the judge actually waited for it.
            for attempt in self._attempts:
                if attempt["outcome"] != "in_flight":
                    continue
                attempt["outcome"] = "timeout"
                attempt["error_class"] = "TimeoutError"
                attempt["duration_ms"] = max(
                    0, int(round((now - attempt["started_monotonic"]) * 1000))
                )
                attempt["duration_source"] = "stopped_at_deadline"
            self._last_end = now

    def _close_open_locked(self, now: float) -> None:
        """An in-flight attempt aborted by DeepEval's soft timeout never returns."""
        for attempt in self._attempts:
            if attempt["outcome"] != "in_flight":
                continue
            started = attempt["started_monotonic"]
            # The HTTP call is still blocked; DeepEval stopped waiting after the
            # per-attempt budget, so report that cap instead of a late finish.
            attempt["outcome"] = "timeout"
            attempt["error_class"] = "TimeoutError"
            attempt["duration_ms"] = int(round(self._per_attempt * 1000))
            attempt["duration_source"] = "per_attempt_cap"
            self._last_end = started + self._per_attempt

    def snapshot(self) -> list[dict[str, Any]]:
        with self._lock:
            results = []
            for attempt in self._attempts:
                item = {key: value for key, value in attempt.items() if key != "started_monotonic"}
                results.append(item)
            return results

    @property
    def count(self) -> int:
        with self._lock:
            return len(self._attempts)


class _RecordingTransport(httpx2.BaseTransport):
    """Pass-through HTTP transport that timestamps each attempt."""

    def __init__(self, recorder: AttemptRecorder) -> None:
        self._inner = httpx2.HTTPTransport()
        self._recorder = recorder

    def handle_request(self, request: httpx2.Request) -> httpx2.Response:
        index = self._recorder.begin()
        try:
            response = self._inner.handle_request(request)
        except BaseException as exc:
            self._recorder.finish(index, error=exc)
            raise
        self._recorder.finish(index, status=response.status_code)
        return response

    def close(self) -> None:
        self._inner.close()


def _root_error(exc: BaseException) -> BaseException:
    if isinstance(exc, RetryError):
        last = getattr(exc, "last_attempt", None)
        if last is not None:
            root = last.exception()
            if root is not None:
                return root
    return exc


def _error_family(root: BaseException) -> str:
    if getattr(root, "status", None) is not None:
        return "http"
    if isinstance(root, TimeoutError) or "Timeout" in type(root).__name__:
        return "timeout"
    if isinstance(root, ConnectionError):
        return "connection"
    return "other"


def _describe_error(exc: BaseException, scrubber: ledger.SecretScrubber) -> dict:
    root = _root_error(exc)
    status = getattr(root, "status", None)
    return {
        "error_class": type(root).__name__,
        "error_family": _error_family(root),
        "wrapper_class": type(exc).__name__,
        "http_status": status if isinstance(status, int) else None,
        "message": scrubber.scrub(str(root))[:1500],
    }


def _retrieval_context(references: Any) -> list[str]:
    """Bounded cited-evidence summaries from the returned references."""
    evidence: list[str] = []
    for reference in references or []:
        if not isinstance(reference, Mapping):
            continue
        reference_id = reference.get("id", "?")
        title = reference.get("title", "")
        excerpt = reference.get("excerpt", "") or ""
        evidence.append(
            f"[{reference_id}] {title}: {str(excerpt)[:MAX_EVIDENCE_CHARS]}".strip()
        )
    return evidence or [NO_EVIDENCE_MARKER]


def _termination(
    error: dict | None, request_count: int, max_attempts: int
) -> str:
    if error is None:
        return "scored"
    if request_count <= 1:
        return "not_retried"
    if request_count >= max_attempts:
        return "attempts_exhausted"
    return "budget_stopped"


def _test_case_for_metric(
    metric,
    *,
    input_text: str,
    answer: str,
    expected_output: str | None,
    references: Any,
) -> LLMTestCase:
    params = list(getattr(metric, "evaluation_params", None) or [])
    kwargs: dict[str, Any] = {"input": input_text, "actual_output": answer}
    if SingleTurnParams.EXPECTED_OUTPUT in params:
        if not isinstance(expected_output, str) or not expected_output.strip():
            raise JudgeFailure(
                "the case has no expected_output for a metric that asks about "
                "the standard answer; refusing to invent one",
                {"error": "missing_expected_output", "metric": metric.name},
            )
        kwargs["expected_output"] = expected_output
    if SingleTurnParams.RETRIEVAL_CONTEXT in params:
        kwargs["retrieval_context"] = _retrieval_context(references)
    return LLMTestCase(**kwargs)


def _load_answer(record: Mapping[str, Any], context: Mapping[str, Any]) -> dict:
    reader = context.get("read_answer")
    persisted: dict | None = None
    source = "sample_record"
    if callable(reader):
        persisted = reader()
        source = "ledger.read_answer"
    agent = record.get("agent") or {}
    answer = (persisted or {}).get("answer", agent.get("answer"))
    if not isinstance(answer, str) or not answer.strip():
        raise JudgeFailure(
            "the sample has no persisted Agent answer to judge; refusing to re-send chat",
            {"answer": None, "error": "missing_persisted_answer"},
        )
    computed = hashlib.sha256(answer.encode("utf-8")).hexdigest()
    claimed = agent.get("answer_sha256") or (persisted or {}).get("answer_sha256")
    if claimed is not None and claimed != computed:
        raise JudgeFailure(
            "the persisted Agent answer does not match its recorded digest",
            {"answer": {"answer_sha256": computed, "claimed_sha256": claimed}, "error": "answer_digest_mismatch"},
        )
    return {
        "source": source,
        "sample_id": record.get("sample_id"),
        "answer_sha256": computed,
        "record_sha256_before_judge": (persisted or {}).get("record_sha256"),
        "written_at": (persisted or {}).get("written_at"),
        "answer": answer,
    }


class Judge:
    """A callable judge for ``run_suite --judge`` backed by TypeSafe Jev.

    ``model_factory`` lets an offline controlled model replace the TypeSafe
    HTTP model (contract tests, replay). A factory is called once per metric
    so no metric or model state is shared between cases.
    """

    def __init__(
        self,
        *,
        base_url: str | None = None,
        api_key: str | None = None,
        model: str | None = None,
        model_factory: Callable[[], Any] | None = None,
    ) -> None:
        configure_retry_environment()
        self._base_url = (
            base_url
            or os.environ.get("NEXUSRAG_JUDGE_BASE_URL")
            or os.environ.get("TYPESAFE_BASE_URL")
            or None
        )
        self._api_key = api_key or os.environ.get("TYPESAFE_API_KEY") or _dot_env("TYPESAFE_API_KEY")
        self._model = model or os.environ.get("TYPESAFE_MODEL_NAME") or DEFAULT_MODEL
        self._model_factory = model_factory
        self._scrubber = ledger.SecretScrubber.from_environment()

    # -- configuration --------------------------------------------------
    def configuration(self) -> dict:
        budget = _budget_snapshot()
        return {
            "ticket": TICKET,
            "model": self._model,
            "model_source": "injected" if self._model_factory is not None else "typesafe",
            "base_url": ledger.safe_url(self._base_url or "https://api.typesafe.ai"),
            "metric": METRIC_NAME,
            "threshold": THRESHOLD,
            "budget": budget,
            "api_key_present": bool(self._api_key),
            "rubric": {
                "version": metrics.RUBRIC_VERSION,
                "digest": metrics.rubric_digest(),
                "evidence_scope": metrics.EVIDENCE_SCOPE,
            },
        }

    # -- judge callable -------------------------------------------------
    def __call__(self, record: Mapping[str, Any], context: Mapping[str, Any] | None = None) -> dict:
        return self.score(record, context or {})

    def score(self, record: Mapping[str, Any], context: Mapping[str, Any]) -> dict:
        configure_retry_environment()
        budget = _budget_snapshot()
        started_at = ledger.utc_now()
        started = time.monotonic()
        base_details: dict[str, Any] = {
            "ticket": TICKET,
            "model": self._model,
            "model_source": "injected" if self._model_factory is not None else "typesafe",
            "base_url": ledger.safe_url(self._base_url or "https://api.typesafe.ai"),
            "budget": budget,
            "attempts": [],
            "request_count": 0,
            "waits_ms": [],
            "total_ms": None,
            "started_at": started_at,
            "finished_at": None,
            "score": None,
            "success": None,
            "error": None,
            "termination": None,
            "metrics": [],
            "applicability": {},
        }

        try:
            answer = _load_answer(record, context)
        except JudgeFailure as exc:
            details = {**base_details, **(exc.details or {}), "finished_at": ledger.utc_now()}
            details["total_ms"] = int((time.monotonic() - started) * 1000)
            raise JudgeFailure(str(exc), details) from None

        base_details["answer"] = {
            key: answer[key]
            for key in ("source", "sample_id", "answer_sha256", "record_sha256_before_judge", "written_at")
        }
        if self._model_factory is None and not self._api_key:
            details = {
                **base_details,
                "finished_at": ledger.utc_now(),
                "total_ms": int((time.monotonic() - started) * 1000),
                "error": {"error_class": "JudgeConfigurationError", "message": "TYPESAFE_API_KEY is not set"},
            }
            raise JudgeFailure("TYPESAFE_API_KEY is not set; cannot construct the Jev judge", details)

        planned = record.get("planned") or {}
        metadata = (
            context.get("metadata")
            or planned.get("metadata")
            or record.get("metadata")
            or {}
        )
        expected_output = context.get("expected_output")
        if expected_output is None:
            expected_output = planned.get("expected_output") or record.get("expected_output")
        references = (record.get("agent") or {}).get("references") or []
        input_text = str(
            record.get("agent", {}).get("request", {}).get("message")
            or record.get("planned_input")
            or planned.get("input")
            or ""
        )

        plan = metrics.build_case_metrics(metadata, case_id=record.get("case_id"))
        base_details["rubric"] = {
            "version": plan.rubric_version,
            "digest": plan.rubric_digest,
            "plan_digest": plan.plan_digest,
            "evidence_scope": plan.evidence_scope,
        }
        base_details["evidence_scope"] = plan.evidence_scope
        entries: list[dict[str, Any]] = []
        for item in plan.applicability:
            entries.append(
                {
                    "metric": item.metric,
                    "applicability": item.status,
                    "reason": item.reason,
                    "threshold": THRESHOLD if item.status == "applicable" else None,
                    "score": None,
                    "success": None,
                    "error": None,
                    "attempted": item.status == "applicable",
                    "model_source": None,
                    "request_count": 0,
                    "attempts": [],
                    "termination": "not_applicable" if item.status != "applicable" else None,
                    "breakdown": None,
                }
            )
        entries_by_name = {entry["metric"]: entry for entry in entries}
        base_details["applicability"] = {
            entry["metric"]: {
                "status": entry["applicability"],
                "reason": entry["reason"],
            }
            for entry in entries
        }
        base_details["metrics"] = entries

        failed: dict[str, Any] | None = None
        for metric in plan.metrics:
            entry = entries_by_name[metric.name]
            recorder: AttemptRecorder | None = None
            if self._model_factory is not None:
                system_one_model = self._model_factory()
                entry["model_source"] = "injected"
            else:
                recorder = AttemptRecorder(budget["per_attempt_timeout_s"])
                system_one_model = TypeSafeModel(
                    model=self._model,
                    api_key=self._api_key,
                    base_url=self._base_url,
                    transport=_RecordingTransport(recorder),
                )
                entry["model_source"] = "typesafe_http"
            metric.system_one_model = system_one_model
            metric.evaluation_model = system_one_model.get_model_name()

            error: dict | None = None
            score_value: Any = None
            token = set_outer_deadline(budget["task_timeout_s"])
            try:
                test_case = _test_case_for_metric(
                    metric,
                    input_text=input_text,
                    answer=answer["answer"],
                    expected_output=expected_output,
                    references=references,
                )
                score_value = metric.measure(test_case, _show_indicator=False)
            except Exception as exc:  # provider/validation/timeout failure
                error = _describe_error(exc, self._scrubber)
            finally:
                reset_outer_deadline(token)
                if recorder is not None:
                    recorder.close()

            attempts = recorder.snapshot() if recorder is not None else []
            if score_value is not None and not (
                isinstance(score_value, (int, float)) and not isinstance(score_value, bool)
            ):
                error = {
                    "error_class": "InvalidJudgeScore",
                    "error_family": "other",
                    "wrapper_class": type(score_value).__name__,
                    "http_status": None,
                    "message": f"judge returned a non-numeric score: {score_value!r}"[:500],
                }
                score_value = None
            request_count = len(attempts)
            if error is not None:
                score_value = None
            termination = _termination(error, request_count, budget["max_attempts"])
            entry.update(
                {
                    "score": None if score_value is None else float(score_value),
                    "success": bool(metric.success) if error is None else False,
                    "reason": (
                        self._scrubber.scrub(metric.reason)[:2000]
                        if metric.reason
                        else entry["reason"]
                    ),
                    "error": error,
                    "attempted": True,
                    "request_count": request_count,
                    "attempts": attempts,
                    "termination": termination,
                    "breakdown": metric.score_breakdown,
                }
            )
            if error is not None:
                failed = entry
                break

        applicable = [entry for entry in entries if entry["applicability"] == "applicable"]
        attempted_metrics = [entry for entry in applicable if entry["attempted"]]
        all_attempts: list[dict[str, Any]] = []
        for entry in attempted_metrics:
            for attempt in entry["attempts"]:
                all_attempts.append({**attempt, "metric": entry["metric"]})
        request_count = len(all_attempts)

        case_error = failed["error"] if failed is not None else None
        termination = failed["termination"] if failed is not None else "scored"
        case_score: float | None = None
        if failed is None:
            incomplete = [
                entry for entry in applicable
                if entry["score"] is None or entry["success"] is None
            ]
            if incomplete:
                entry = incomplete[0]
                case_error = {
                    "error_class": "IncompleteMetricResult",
                    "error_family": "other",
                    "wrapper_class": None,
                    "http_status": None,
                    "message": f"metric {entry['metric']!r} produced no score",
                }
                entry["error"] = case_error
                entry["success"] = False
                termination = "not_retried"
            else:
                # The case score is the weakest applicable metric so a failing
                # dimension (e.g. Grounding) cannot be averaged away by two
                # good ones. A not_applicable metric never enters this set.
                case_score = min(float(entry["score"]) for entry in applicable)

        details = {
            **base_details,
            "attempts": all_attempts,
            "request_count": request_count,
            "waits_ms": [
                item["wait_before_ms"]
                for item in all_attempts
                if item["wait_before_ms"] is not None
            ],
            "total_ms": int((time.monotonic() - started) * 1000),
            "finished_at": ledger.utc_now(),
            "score": case_score,
            "success": (
                case_error is None
                and bool(applicable)
                and all(entry["success"] for entry in applicable)
            ),
            "error": case_error,
            "termination": termination,
            "threshold": THRESHOLD,
            "metrics": entries,
        }
        if case_error is not None:
            failed_entry = failed or next(
                entry for entry in applicable if entry.get("error") is not None
            )
            message = (
                f"{case_error['error_class']} after {failed_entry['request_count']} "
                f"judge attempt(s) on {failed_entry['metric']}: {case_error['message']}"
            )
            raise JudgeFailure(self._scrubber.scrub(message)[:2000], details)

        if len(applicable) == 1:
            metric_name = applicable[0]["metric"]
            reason = applicable[0]["reason"]
        else:
            metric_name = "per-case metrics"
            reason = " | ".join(
                f"{entry['metric']}: {entry['reason'] or 'no reason'}"
                for entry in applicable
            )
        return {
            "score": float(case_score),
            "metric": metric_name,
            "success": bool(details["success"]),
            "reason": self._scrubber.scrub(reason)[:2000] if reason else None,
            "metrics": entries,
            "applicability": base_details["applicability"],
            "rubric": base_details["rubric"],
            "evidence_scope": plan.evidence_scope,
            "details": details,
        }


def make_judge(
    *,
    base_url: str | None = None,
    api_key: str | None = None,
    model: str | None = None,
    model_factory: Callable[[], Any] | None = None,
) -> Callable[[Mapping[str, Any], Mapping[str, Any]], dict]:
    judge = Judge(
        base_url=base_url,
        api_key=api_key,
        model=model,
        model_factory=model_factory,
    )

    def jev_judge(record: Mapping[str, Any], context: Mapping[str, Any] | None = None) -> dict:
        return judge(record, context)

    jev_judge.__name__ = "jev_judge"
    return jev_judge


_DEFAULT_JUDGE: Judge | None = None


def judge(record: Mapping[str, Any], context: Mapping[str, Any] | None = None) -> dict:
    """Module-level judge for ``run_suite --judge tests/evals/judge_runtime.py:judge``."""
    global _DEFAULT_JUDGE
    if _DEFAULT_JUDGE is None:
        _DEFAULT_JUDGE = Judge()
    return _DEFAULT_JUDGE(record, context)


def configuration() -> dict:
    """Budget and endpoint facts for a run snapshot, without calling Jev."""
    return Judge().configuration()


def main(argv: list[str] | None = None) -> int:
    """Print the effective judge configuration as JSON (evidence helper)."""
    print(json.dumps(configuration(), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
