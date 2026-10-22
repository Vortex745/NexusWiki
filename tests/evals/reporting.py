"""Complete baseline report for one evaluation run (DR-08).

The report is a pure projection of the frozen manifest, the environment
snapshot and the per-sample records. It never invents a result for a sample
that has no record and it never borrows results from another run.

Layout (``report.json`` in the run directory):

  snapshots   dataset/rubric/model/config/scope/environment (no secret values)
  counts      planned, attempted, scored, error, skipped, not_applicable,
              not_started plus metric-level denominators
  thresholds  6 hard all pass, 10/14 others, 16/20 overall; judge 0.5 and the
              0.7 retest trigger
  gate        incomplete / passed / failed / complete, never a silent green
  sections    facts, citations, isolation, judge, capabilities, latency
  cases       per-case behaviour and judge results
  raw         per-sample projection sufficient to recompute every count

Behaviour is the deterministic v2 gate (DR-03) persisted with each sample;
judge results are the per-case Jev metrics (DR-06). They are reported
separately, and a high judge score can never turn a failed behaviour result
into a pass. ``not_applicable`` metrics have no score and are excluded from
the case score; missing records are ``not_started`` and keep the run
incomplete.

Latency is the Agent chat request wall time only (``agent.duration_ms``);
judge time is reported elsewhere and excluded from the latency section.
"""

from __future__ import annotations

import json
import math
import os
from collections import OrderedDict
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

import ledger

SCHEMA = "eval-baseline-report"
REPORT_VERSION = 1
TICKET = "DR-08"

JUDGE_THRESHOLD = 0.5
RETEST_TRIGGER = 0.7
HARD_REQUIRED = 6
OTHERS_REQUIRED = 10
OVERALL_REQUIRED = 16

# Cases the parent spec puts into retest regardless of their first result.
PRESELECTED_RETEST = (
    "hard-03",
    "hard-04",
    "hard-06",
    "case-16",
)

V2_KINDS = frozenset({"answer", "refuse", "memory-not-cited"})

FACT_CHECKS = (
    "contract_version",
    "result_shape",
    "answer_points_configured",
    "answer_points",
    "terminal_status",
    "prohibited_assertions_configured",
    "prohibited_assertions",
    "forbidden_reference_content_configured",
    "forbidden_reference_content",
)
CITATION_CHECKS = (
    "inline_citation_present",
    "inline_citation_parseable",
    "inline_citation_resolved",
)
ISOLATION_CHECKS = (
    "honest_refusal",
    "clarification_is_not_refusal",
    "empty_scope",
    "reply_length",
    "memory_constraint_configured",
    "memory_not_in_references",
    "owner_viewing_allowed",
)


def _redact(value: Any) -> Any:
    if isinstance(value, str):
        return ledger.redact_text(value)
    if isinstance(value, Mapping):
        return {str(key): _redact(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_redact(item) for item in value]
    return value


def _is_v2(metadata: Mapping[str, Any] | None) -> bool:
    metadata = metadata or {}
    return (
        metadata.get("contract_version") == 2
        and metadata.get("kind") in V2_KINDS
    )


def _is_score(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and 0 <= float(value) <= 1
    )


def _metric_entries(record: Mapping[str, Any]) -> list[dict]:
    judge = record.get("judge") or {}
    found = judge.get("metrics")
    if not isinstance(found, list):
        details = judge.get("details")
        found = details.get("metrics") if isinstance(details, Mapping) else None
    return [dict(item) for item in (found or []) if isinstance(item, Mapping)]


def _rubric_from_record(record: Mapping[str, Any]) -> dict | None:
    judge = record.get("judge") or {}
    candidates = [judge.get("rubric")]
    details = judge.get("details")
    if isinstance(details, Mapping):
        candidates.extend([details.get("rubric"), details])
    for candidate in candidates:
        if not isinstance(candidate, Mapping):
            continue
        version = candidate.get("version") or candidate.get("rubric_version")
        digest = candidate.get("digest") or candidate.get("rubric_digest")
        if isinstance(version, str) and isinstance(digest, str):
            return {
                "version": version,
                "digest": digest,
                "threshold": candidate.get("threshold", JUDGE_THRESHOLD),
                "evidence_scope": candidate.get("evidence_scope"),
            }
    return None


def _model_from_record(record: Mapping[str, Any]) -> dict | None:
    judge = record.get("judge") or {}
    details = judge.get("details")
    if not isinstance(details, Mapping):
        return None
    model = details.get("model")
    if not isinstance(model, str):
        return None
    return {
        "model": model,
        "model_source": details.get("model_source"),
        "base_url": ledger.safe_url(details.get("base_url") or ""),
        "budget": details.get("budget"),
    }


def project_metric_results(records: Iterable[Mapping[str, Any]]) -> list[dict]:
    """Flatten per-metric results from sample records in plan order."""
    projected: list[dict] = []
    for record in records:
        for item in _metric_entries(record):
            projected.append(
                {
                    "sample_id": record.get("sample_id"),
                    "case_id": record.get("case_id"),
                    "metric": item.get("metric"),
                    "applicability": item.get("applicability"),
                    "score": item.get("score"),
                    "success": item.get("success"),
                    "reason": _redact(item.get("reason")),
                    "error": _redact(item.get("error")),
                    "termination": item.get("termination"),
                    "request_count": item.get("request_count"),
                }
            )
    return projected


def project_rubric(records: Iterable[Mapping[str, Any]]) -> dict | None:
    for record in records:
        rubric = _rubric_from_record(record)
        if rubric is not None:
            return rubric
    return None


def _behaviour_for(
    record: Mapping[str, Any] | None,
    metadata: Mapping[str, Any] | None,
    status: str,
) -> dict:
    if status not in {"not_started", "corrupt", "skipped", "agent_error"} and record is not None and isinstance(record.get("behaviour"), Mapping):
        return dict(record["behaviour"])
    required = _is_v2(metadata)
    if status == "not_started":
        return {
            "schema": "eval-behaviour-status",
            "status": "not_started",
            "passed": False,
            "required": required,
            "failures": ["no sample record was written; the case was not started"],
            "checks": {},
        }
    if status == "corrupt":
        return {
            "schema": "eval-behaviour-status",
            "status": "corrupt",
            "passed": False,
            "required": required,
            "failures": ["the sample record is missing or truncated"],
            "checks": {},
        }
    if status == "skipped":
        return {
            "schema": "eval-behaviour-status",
            "status": "skipped",
            "passed": False,
            "required": required,
            "failures": ["the sample was skipped; a skip is not a pass"],
            "checks": {},
        }
    if status == "agent_error":
        return {
            "schema": "eval-behaviour-status",
            "status": "error",
            "passed": False,
            "required": required,
            "failures": ["the Agent request failed"],
            "checks": {},
        }
    if required:
        return {
            "schema": "eval-behaviour-status",
            "status": "missing",
            "passed": False,
            "required": True,
            "failures": ["the v2 case has no deterministic behaviour record"],
            "checks": {},
        }
    return {
        "schema": "eval-behaviour-status",
        "status": "not_configured",
        "passed": None,
        "required": False,
        "failures": [],
        "checks": {},
    }


def _judge_projection(
    record: Mapping[str, Any] | None, status: str
) -> dict:
    if record is None:
        return {
            "status": "not_attempted",
            "score": None,
            "metric": None,
            "success": None,
            "reason": None,
            "error": None,
            "duration_ms": None,
            "request_count": 0,
            "rubric": None,
            "metrics": [],
            "metric_status": status,
        }
    judge = record.get("judge") or {}
    details = judge.get("details") if isinstance(judge.get("details"), Mapping) else {}
    entries = _metric_entries(record)
    return {
        "status": judge.get("status"),
        "score": judge.get("score"),
        "metric": judge.get("metric"),
        "success": judge.get("success"),
        "reason": _redact(judge.get("reason")),
        "error": _redact(judge.get("error")),
        "duration_ms": judge.get("duration_ms"),
        "request_count": details.get("request_count"),
        "rubric": _rubric_from_record(record),
        "metrics": [
            {
                "metric": item.get("metric"),
                "applicability": item.get("applicability"),
                "score": item.get("score"),
                "success": item.get("success"),
                "reason": _redact(item.get("reason")),
                "error": _redact(item.get("error")),
                "termination": item.get("termination"),
                "request_count": item.get("request_count"),
            }
            for item in entries
        ],
    }


def _sample_projection(
    planned: Mapping[str, Any],
    record: Mapping[str, Any] | None,
    status: str,
) -> dict:
    metadata = planned.get("metadata") or {}
    agent = (record or {}).get("agent") or {}
    behaviour = _behaviour_for(record, metadata, status)
    judge = _judge_projection(record, status)
    not_applicable = sum(
        1
        for item in judge["metrics"]
        if item.get("applicability") == "not_applicable"
    )
    return {
        "sample_id": planned.get("sample_id"),
        "case_id": planned.get("case_id"),
        "sample_index": planned.get("sample_index"),
        "status": status,
        "session_id": (record or {}).get("session_id"),
        "input_sha256": (planned.get("input_sha256") or (record or {}).get("planned", {}).get("input_sha256")),
        "agent_http_status": agent.get("http_status"),
        "agent_backend_status": agent.get("backend_status"),
        "agent_duration_ms": agent.get("duration_ms"),
        "answer_sha256": agent.get("answer_sha256"),
        "reference_count": len(agent.get("references") or []),
        "behaviour_status": behaviour.get("status"),
        "behaviour_passed": behaviour.get("passed"),
        "judge_status": judge.get("status"),
        "judge_score": judge.get("score"),
        "judge_duration_ms": judge.get("duration_ms"),
        "metric_count": len(judge["metrics"]),
        "not_applicable_count": not_applicable,
        "error": _redact((record or {}).get("error")),
    }


def _case_behaviour(
    samples: Sequence[Mapping[str, Any]],
) -> dict:
    if not samples:
        return {"status": "missing", "passed": False, "failures": ["no planned sample"]}
    statuses = [sample["behaviour_status"] for sample in samples]
    failures = [
        failure
        for sample in samples
        for failure in (sample.get("behaviour_failures") or [])
    ]
    passed = bool(samples) and all(
        sample.get("behaviour_passed") is True for sample in samples
    )
    if "not_configured" in statuses and all(
        status == "not_configured" for status in statuses
    ):
        status = "not_configured"
        passed = None
    elif passed:
        status = "passed"
    elif "not_started" in statuses:
        status = "not_started"
    elif "corrupt" in statuses:
        status = "corrupt"
    elif "skipped" in statuses:
        status = "skipped"
    elif "error" in statuses:
        status = "error"
    elif "missing" in statuses:
        status = "missing"
    else:
        status = "failed"
    return {"status": status, "passed": passed, "failures": failures}


def _case_judge(samples: Sequence[Mapping[str, Any]]) -> dict:
    metrics = [
        entry
        for sample in samples
        for entry in sample.get("judge_metrics") or []
    ]
    applicable = [
        item for item in metrics if item.get("applicability") == "applicable"
    ]
    scored = [
        item for item in applicable if _is_score(item.get("score"))
    ]
    errors = [
        item
        for item in applicable
        if item.get("error") is not None or not _is_score(item.get("score"))
    ]
    integrity_ok = all(sample.get("metric_contract_valid") is True for sample in samples)
    passed = (
        integrity_ok
        and bool(applicable)
        and not errors
        and all(float(item["score"]) >= JUDGE_THRESHOLD for item in scored)
    )
    return {
        "status": "scored" if scored and not errors else ("error" if errors else "not_scored"),
        "passed": passed,
        "applicable": len(applicable),
        "scored": len(scored),
        "errors": len(errors),
        "not_applicable": sum(
            1 for item in metrics if item.get("applicability") == "not_applicable"
        ),
        "score": (
            min(float(item["score"]) for item in scored)
            if scored and integrity_ok else None
        ),
    }


def _expected_metric_contract(planned: Mapping[str, Any], rubric: Mapping[str, Any] | None) -> dict | None:
    frozen = planned.get("expected_metrics")
    if isinstance(frozen, Mapping) and frozen:
        return dict(frozen)
    if not _is_v2(planned.get("metadata")):
        return None
    version = (rubric or {}).get("version")
    if not isinstance(version, str) or not version.startswith("dr-06."):
        return None
    try:
        import metrics as metrics_module
        return metrics_module.expected_metric_applicability(planned.get("metadata") or {})
    except Exception:
        return None


def _metric_contract_error(planned: Mapping[str, Any], record: Mapping[str, Any] | None,
                           rubric: Mapping[str, Any] | None, *, baseline: bool,
                           status: str) -> str | None:
    expected = _expected_metric_contract(planned, rubric)
    if expected is None:
        # A baseline must prove its metric contract. Legacy ad-hoc runs keep
        # their previous single-score judge shape.
        return "expected metric contract is not frozen or recognized" if baseline else None
    if record is None or status not in {"scored", "judge_error"}:
        # Missing records and Agent failures have no judge rows; their own
        # missing/error reasons already keep the run incomplete.
        return None
    entries = _metric_entries(record or {})
    actual: dict[str, str] = {}
    for entry in entries:
        name = entry.get("metric")
        applicability = entry.get("applicability")
        if not isinstance(name, str) or name in actual:
            return "metric rows contain an invalid or duplicate name"
        if applicability not in {"applicable", "not_applicable"}:
            return f"metric {name} has invalid applicability"
        actual[name] = applicability
    if actual != expected:
        return "metric rows do not match the frozen name/applicability set"
    return None


def _nearest_rank(values: Sequence[float], percentile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    rank = max(1, math.ceil(percentile * len(ordered)))
    return ordered[rank - 1]


def _latency_stats(values: Sequence[float]) -> dict:
    ordered = sorted(values)
    if not ordered:
        return {
            "count": 0,
            "min_ms": None,
            "mean_ms": None,
            "median_ms": None,
            "p95_ms": None,
            "max_ms": None,
        }
    return {
        "count": len(ordered),
        "min_ms": ordered[0],
        "mean_ms": round(sum(ordered) / len(ordered), 1),
        "median_ms": _nearest_rank(ordered, 0.5),
        "p95_ms": _nearest_rank(ordered, 0.95),
        "max_ms": ordered[-1],
    }


def _failure_reasons(scan: Mapping[str, Any]) -> list[dict]:
    reasons: list[dict] = []
    for item in scan.get("reasons") or []:
        if not isinstance(item, Mapping):
            continue
        reasons.append(_redact(dict(item)))
    return reasons


def _cache_snapshot(environment: Mapping[str, Any]) -> dict:
    configured = ((environment.get("configuration") or {}).get("cache") or {})
    return {
        "reading": configured.get("reading", "disabled"),
        "writing": configured.get("writing", "disabled"),
        "enabled": bool(configured.get("enabled", False)),
    }


RERANK_FUSED_REASONS = frozenset(
    {"not_configured", "below_threshold", "unavailable", "multi_query_aggregation"}
)
# DR-22 distinguishes answer-level failures from configuration/scope facts. Only
# these reasons mean the rerank path itself failed; `web_unconfigured` and
# `parent_expansion_unavailable` must not block DR-14's clean-coverage proof.
RERANK_DEGRADATION_REASONS = frozenset({"reranker_unavailable"})
RERANK_MATRIX = (
    ("provider_call", "the dedicated reranker provider was actually called"),
    ("ordering", "the published final ranking is labelled dedicated_rerank"),
    ("model_snapshot", "the terminal run snapshot names the rerank model used"),
    ("no_degradation", "no rerank fallback or unavailable degradation was observed"),
)


def _rerank_sample_evidence(record: Mapping[str, Any]) -> dict:
    """One sample's rerank facts, read only from the retained Agent payload.

    The final retrieval event carries the published ordering; the terminal event
    carries the non-secret model snapshot. Answer text is deliberately ignored:
    a reply that mentions rerank cannot prove that the provider ran.
    """
    agent = record.get("agent")
    payload = agent.get("raw_payload") if isinstance(agent, Mapping) else None
    events = payload.get("events") if isinstance(payload, Mapping) else None
    ordering = None
    ordering_seen = False
    degraded_reasons: list[str] = []
    rerank_model: str | None = None
    if isinstance(events, Sequence) and not isinstance(events, (str, bytes)):
        for event in events:
            if not isinstance(event, Mapping):
                continue
            if event.get("type") == "progress" and event.get("stage") == "retrieval":
                data = event.get("data")
                if not isinstance(data, Mapping):
                    continue
                reasons = data.get("degradedReasons")
                if isinstance(reasons, list):
                    degraded_reasons.extend(
                        item for item in reasons if isinstance(item, str)
                    )
                if "finalContextOrdering" in data:
                    ordering = data.get("finalContextOrdering")
                    ordering_seen = True
            elif event.get("type") == "done":
                result = event.get("result")
                profile = result.get("modelProfile") if isinstance(result, Mapping) else None
                model = profile.get("rerankModel") if isinstance(profile, Mapping) else None
                if isinstance(model, str) and model.strip():
                    rerank_model = model.strip()
    source: str | None = None
    reason: str | None = None
    invalid: str | None = None
    if ordering_seen:
        if not isinstance(ordering, Mapping):
            invalid = "final ordering evidence is not an object"
        else:
            candidate_source = ordering.get("source")
            candidate_reason = ordering.get("reason")
            if candidate_source == "dedicated_rerank" and candidate_reason is None:
                source = "dedicated_rerank"
            elif (
                candidate_source == "fused"
                and candidate_reason in RERANK_FUSED_REASONS
            ):
                source = "fused"
                reason = candidate_reason
            else:
                invalid = "final ordering has an unrecognized source/reason pair"
    return {
        "source": source,
        "reason": reason,
        "degraded_reasons": degraded_reasons,
        "rerank_model": rerank_model,
        "invalid": invalid,
        "observed": bool(ordering_seen or rerank_model or degraded_reasons),
    }


def _configured_rerank_model(environment: Mapping[str, Any]) -> str | None:
    models = ((environment.get("configuration") or {}).get("models") or {})
    value = models.get("RERANK_MODEL")
    return value.strip() if isinstance(value, str) and value.strip() else None


def _rerank_capability(
    environment: Mapping[str, Any],
    snapshot: Mapping[str, Any],
    planned: Sequence[Mapping[str, Any]],
    records: Mapping[str, Mapping[str, Any]],
) -> dict:
    """Separate rerank execution coverage from answer correctness and config.

    Statuses are evidence-first:
      * ``not_configured``: no provider configured and no run evidence;
      * ``not_exercised``: configured, but no sample proves a provider call;
      * ``degraded``: the provider failed and the published order stayed fused;
      * ``exercised``: a controlled run published dedicated-rerank ordering;
      * ``invalid``: the ordering evidence is unrecognized, so no claim is made.
    """
    configured_model = _configured_rerank_model(environment)
    stored_status = snapshot.get("status")
    configured = bool(snapshot.get("configured")) or stored_status not in {
        None,
        "",
        "not_configured",
        "skipped",
    }

    evidence = [
        _rerank_sample_evidence(records[item["sample_id"]])
        for item in planned
        if isinstance(records.get(item.get("sample_id")), Mapping)
    ]
    dedicated = [item for item in evidence if item["source"] == "dedicated_rerank"]
    invalid = [item for item in evidence if item["invalid"]]
    unavailable = [item for item in evidence if item["reason"] == "unavailable"]
    degraded = [
        item
        for item in evidence
        if any(
            reason in RERANK_DEGRADATION_REASONS
            for reason in item["degraded_reasons"]
        )
    ]
    fused = [item for item in evidence if item["source"] == "fused"]
    observed_models = sorted(
        {item["rerank_model"] for item in evidence if item["rerank_model"]}
    )
    configured = configured or bool(observed_models) or bool(dedicated)

    if invalid:
        status = "invalid"
    elif dedicated:
        status = "exercised"
    elif unavailable:
        status = "degraded"
    elif configured:
        status = "not_exercised"
    else:
        status = "not_configured"

    model_matches = bool(observed_models) and (
        configured_model is None or observed_models == [configured_model]
    )
    proven = {
        "provider_call": bool(dedicated),
        "ordering": bool(dedicated) and not invalid,
        "model_snapshot": bool(dedicated) and model_matches,
        "no_degradation": bool(dedicated) and not invalid and not unavailable and not degraded,
    }
    matrix = [
        {
            "id": identifier,
            "required": True,
            "status": "proven" if proven[identifier] else "incomplete",
            "counted_as_pass": proven[identifier],
            "detail": (
                requirement
                if proven[identifier]
                else f"required evidence is missing: {requirement}"
            ),
        }
        for identifier, requirement in RERANK_MATRIX
    ]
    coverage_complete = all(proven.values())

    if status == "not_configured":
        detail = (
            "no rerank provider is configured; the capability is skipped and "
            "configuration presence or an answer mentioning rerank is not coverage"
        )
    elif status == "not_exercised":
        detail = (
            "a rerank provider is configured but no sample proves a provider "
            "call; configured presence is not coverage"
        )
    elif status == "degraded":
        detail = (
            "the rerank provider failed and the published ranking kept the "
            "explicit fused/degraded source; it is not a dedicated-rerank success"
        )
    elif status == "exercised":
        detail = (
            "a controlled run published dedicated_rerank ordering with a "
            "matching model snapshot; this proves the protocol/report branch "
            "only, online rerank acceptance remains not run"
        )
    else:
        detail = (
            "the retained ordering evidence is malformed or unrecognized; "
            "coverage is not claimed from configuration or model snapshots"
        )

    return {
        "status": status,
        "configured": configured,
        "skipped": status == "not_configured",
        "counted_as_pass": False,
        "source": (
            "dedicated_rerank"
            if status == "exercised"
            else ("fused" if fused or unavailable else None)
        ),
        "degradation_reason": "unavailable" if status == "degraded" else None,
        "model": {
            "configured": configured_model,
            "observed": observed_models,
        },
        "evidence": {
            "samples": len(evidence),
            "observed": sum(1 for item in evidence if item["observed"]),
            "dedicated_rerank": len(dedicated),
            "fused": len(fused),
            "fused_reasons": {
                reason: sum(1 for item in evidence if item["reason"] == reason)
                for reason in sorted(RERANK_FUSED_REASONS)
                if any(item["reason"] == reason for item in evidence)
            },
            "degraded_reasons": sorted(
                {
                    reason
                    for item in evidence
                    for reason in item["degraded_reasons"]
                }
            ),
            "invalid_samples": len(invalid),
        },
        "coverage": {
            "status": "complete" if coverage_complete else "incomplete",
            "counted_as_pass": False,
            "matrix": matrix,
        },
        "coverage_scope": "controlled" if coverage_complete else "none",
        "online_acceptance": "not_run",
        "detail": detail,
    }


def _capabilities(
    environment: Mapping[str, Any],
    capability_snapshot: Mapping[str, Any] | None,
    planned: Sequence[Mapping[str, Any]] = (),
    records: Mapping[str, Mapping[str, Any]] | None = None,
) -> dict:
    stored = (environment.get("configuration") or {}).get("capabilities") or {}
    combined = {**dict(stored), **dict(capability_snapshot or {})}
    rerank = combined.get("rerank")
    if not isinstance(rerank, Mapping):
        rerank = {
            "status": "not_configured",
            "configured": False,
            "counted_as_pass": False,
            "detail": (
                "no rerank capability snapshot was recorded; absence of a "
                "configured rerank provider is not coverage"
            ),
        }
    projected = _rerank_capability(environment, rerank, planned, records or {})
    capabilities = {"rerank": _redact(projected)}
    capabilities["cache"] = _cache_snapshot(environment)
    return capabilities


DEGRADATION_MATRIX_SCHEMA = "degradation-status-matrix-v1"

# DR-22: retrieval reasons that mean the answer was generated from a degraded
# read. A missing capability (`reranker_not_configured`, `web_unconfigured`) or
# an empty scope (`no_knowledge_scope`) is a configuration/scope fact and must
# not be counted as an answer degradation.
DEGRADATION_FAILURE_REASONS = frozenset(
    {"parent_expansion_unavailable", "reranker_unavailable"}
)


def _is_degradation_failure(reason: Any) -> bool:
    return isinstance(reason, str) and (
        reason in DEGRADATION_FAILURE_REASONS or reason.endswith(" unavailable")
    )


def _degradation_sample_evidence(record: Mapping[str, Any]) -> dict:
    """Terminal state and stage reasons from the retained Agent payload."""
    agent = record.get("agent")
    agent = agent if isinstance(agent, Mapping) else {}
    payload = agent.get("raw_payload")
    events = payload.get("events") if isinstance(payload, Mapping) else None
    degraded_reasons: list[str] = []
    ordering: Any = None
    ordering_seen = False
    terminal_status: str | None = None
    degradation: dict | None = None
    observed = False
    if isinstance(events, Sequence) and not isinstance(events, (str, bytes)):
        for event in events:
            if not isinstance(event, Mapping):
                continue
            if event.get("type") == "progress" and event.get("stage") == "retrieval":
                data = event.get("data")
                if isinstance(data, Mapping):
                    reasons = data.get("degradedReasons")
                    if isinstance(reasons, list):
                        degraded_reasons.extend(
                            item for item in reasons if isinstance(item, str)
                        )
                    if "finalContextOrdering" in data:
                        ordering = data.get("finalContextOrdering")
                        ordering_seen = True
                    observed = True
            elif event.get("type") == "done":
                result = event.get("result")
                if isinstance(result, Mapping):
                    status = result.get("status")
                    if isinstance(status, str):
                        terminal_status = status
                    state = result.get("degradation")
                    if isinstance(state, Mapping):
                        degradation = dict(state)
                    observed = True
    if terminal_status is None:
        backend_status = agent.get("backend_status")
        terminal_status = (
            backend_status if isinstance(backend_status, str) else "not_started"
        )
    ordering_value = ordering if isinstance(ordering, Mapping) else None
    return {
        "terminal_status": terminal_status,
        "degradation": degradation or {},
        "stage_reasons": degraded_reasons,
        "ordering": dict(ordering_value) if ordering_value is not None else None,
        "ordering_seen": ordering_seen,
        "observed": observed,
    }


def _degradation_classification(
    terminal_status: str,
    degradation: Mapping[str, Any],
    reasons: Sequence[str],
    ordering: Mapping[str, Any] | None,
) -> str:
    if terminal_status == "insufficient_evidence":
        return (
            "refusal"
            if degradation.get("reason") in {"no_results", "no_context_evidence"}
            else "insufficient_evidence"
        )
    if terminal_status == "insufficient_retrieval":
        if "no_knowledge_scope" in reasons or not degradation.get("unavailableChannels"):
            return "empty_scope"
        return "retrieval_outage"
    if terminal_status == "provider_error":
        return "provider_error"
    if terminal_status == "cancelled":
        return "cancelled"
    if terminal_status == "completed":
        source = (ordering or {}).get("source")
        reason = (ordering or {}).get("reason")
        if source == "dedicated_rerank":
            return "rerank_dedicated"
        if reason == "not_configured":
            return "rerank_not_configured"
        if reason == "unavailable" or any(
            _is_degradation_failure(item) for item in reasons
        ):
            return "rerank_failure"
        return "completed"
    return terminal_status or "unknown"


def _degradation_row(
    planned: Mapping[str, Any], record: Mapping[str, Any]
) -> dict:
    agent = record.get("agent")
    agent = agent if isinstance(agent, Mapping) else {}
    evidence = _degradation_sample_evidence(record)
    reasons = evidence["stage_reasons"]
    ordering = evidence["ordering"]
    degradation = evidence["degradation"]
    terminal_status = evidence["terminal_status"]

    failures: list[str] = []
    retrieval_degraded = any(_is_degradation_failure(item) for item in reasons) or (
        (ordering or {}).get("reason") == "unavailable"
    )
    if terminal_status == "completed" and retrieval_degraded:
        if degradation.get("status") != "partial":
            failures.append("silent_degradation")
    if (
        terminal_status == "completed"
        and (ordering or {}).get("source") == "dedicated_rerank"
        and any(_is_degradation_failure(item) for item in reasons)
    ):
        failures.append("silent_degradation")
    if (
        terminal_status == "provider_error"
        and degradation.get("reason") == "no_cited_claims"
    ):
        failures.append("provider_failure_mislabelled")

    return {
        "sample_id": planned.get("sample_id"),
        "case_id": planned.get("case_id"),
        "request": _redact(agent.get("request") or {}),
        "terminal_status": terminal_status,
        "degradation": _redact(degradation),
        "stage_reasons": list(reasons),
        "ordering": _redact(ordering),
        "classification": _degradation_classification(
            terminal_status, degradation, reasons, ordering
        ),
        "offline": {
            "status": "observed" if evidence["observed"] else "not_observed",
            "degraded": retrieval_degraded,
            "failures": failures,
        },
        "online": {
            # DR-22-AC03: real online rerank status is owned by the performance
            # ticket. Until it runs, this column can only be pending.
            "status": "pending",
            "evidence": None,
        },
    }


def _degradation_status_matrix(
    planned: Sequence[Mapping[str, Any]],
    records: Mapping[str, Mapping[str, Any]],
) -> dict:
    rows: list[dict] = []
    for item in planned:
        record = records.get(item.get("sample_id"))
        if not isinstance(record, Mapping):
            continue
        rows.append(_degradation_row(item, record))

    observed = [row for row in rows if row["offline"]["status"] == "observed"]
    failed_rows = [
        row
        for row in rows
        if any(
            kind in {"silent_degradation", "provider_failure_mislabelled"}
            for kind in row["offline"]["failures"]
        )
    ]
    silent_ids = [
        row["sample_id"]
        for row in rows
        if "silent_degradation" in row["offline"]["failures"]
    ]
    gate_reasons = [
        {
            "kind": kind,
            "sample_id": row["sample_id"],
            "detail": (
                "the answer's retrieval degraded but the terminal reported no "
                "degradation"
                if kind == "silent_degradation"
                else "a provider failure was labelled as a citation failure"
            ),
        }
        for row in failed_rows
        for kind in row["offline"]["failures"]
        if kind in {"silent_degradation", "provider_failure_mislabelled"}
    ]
    if not observed:
        gate_status = "incomplete"
    elif gate_reasons:
        gate_status = "failed"
    else:
        gate_status = "passed"
    return {
        "schema": DEGRADATION_MATRIX_SCHEMA,
        "offline": {
            "status": "controlled",
            "results": rows,
            "counted_as_pass": False,
        },
        "online": {
            "status": "not_run",
            "results": [],
            "counted_as_pass": False,
            "detail": (
                "real online rerank/provider status is pending and is owned by "
                "the performance ticket; it is never inferred from this run"
            ),
        },
        "silent_degradation": {
            "failed": bool(silent_ids),
            "sample_ids": silent_ids,
        },
        "gate": {
            "status": gate_status,
            "passed": gate_status == "passed",
            "counted_as_pass": False,
            "reasons": gate_reasons,
        },
        "counted_as_pass": False,
    }


def build_report(
    *,
    manifest: Mapping[str, Any],
    environment: Mapping[str, Any],
    planned: Sequence[Mapping[str, Any]],
    records: Mapping[str, Mapping[str, Any]],
    scan: Mapping[str, Any],
    baseline: bool = False,
    capabilities: Mapping[str, Any] | None = None,
    rubric: Mapping[str, Any] | None = None,
    judge_configuration: Mapping[str, Any] | None = None,
) -> dict:
    """Build the complete report from the frozen plan and raw sample records."""
    baseline = bool(baseline or (manifest.get("run") or {}).get("baseline"))
    metadata_by_id = {
        item.get("sample_id"): item.get("metadata") or {} for item in planned
    }
    scan_by_id = {
        item.get("sample_id"): item for item in scan.get("samples") or []
    }

    sample_projections: list[dict] = []
    case_order: "OrderedDict[str, dict]" = OrderedDict()
    for item in planned:
        sample_id = item.get("sample_id")
        case_id = item.get("case_id")
        metadata = metadata_by_id.get(sample_id) or {}
        scan_item = scan_by_id.get(sample_id) or {}
        status = scan_item.get("status") or "not_started"
        record = records.get(sample_id)
        if status in {"scored", "agent_error", "judge_error", "pending_judge", "skipped"}:
            pass
        elif record is None:
            status = "not_started" if sample_id in (scan.get("missing") or []) else status
        sample = _sample_projection(item, record, status)
        contract_error = _metric_contract_error(
            item, record, rubric, baseline=baseline, status=status
        )
        sample["metric_contract_valid"] = contract_error is None
        if contract_error:
            sample["metric_contract_error"] = contract_error
        sample["behaviour_failures"] = (
            (_behaviour_for(record, metadata, status).get("failures") or [])
        )
        sample["judge_metrics"] = (
            _judge_projection(record, status).get("metrics") or []
        )
        sample_projections.append(sample)

        case = case_order.setdefault(
            case_id,
            {
                "case_id": case_id,
                "hard": bool(metadata.get("hard")),
                "kind": metadata.get("kind"),
                "scope": item.get("scope"),
                "samples": [],
            },
        )
        case["samples"].append(sample)

    cases: list[dict] = []
    for case in case_order.values():
        samples = case["samples"]
        behaviour = _case_behaviour(samples)
        judge = _case_judge(samples)
        durations = [
            float(sample["agent_duration_ms"])
            for sample in samples
            if isinstance(sample.get("agent_duration_ms"), (int, float))
        ]
        cases.append(
            {
                **case,
                "behaviour": behaviour,
                "judge": judge,
                "errors": [
                    sample["error"] for sample in samples if sample.get("error")
                ],
                "latency_ms": durations,
                "retest": {"selected": False, "reasons": []},
            }
        )

    # Counts: sample-level denominators plus metric-level applicability.
    metrics = [
        item
        for sample in sample_projections
        for item in sample.get("judge_metrics") or []
    ]
    applicable_metrics = [
        item for item in metrics if item.get("applicability") == "applicable"
    ]
    scored_metrics = [
        item for item in applicable_metrics if _is_score(item.get("score"))
    ]
    metric_errors = [
        item
        for item in applicable_metrics
        if item.get("error") is not None or not _is_score(item.get("score"))
    ]
    not_applicable = sum(
        1 for item in metrics if item.get("applicability") == "not_applicable"
    )
    statuses = [sample["status"] for sample in sample_projections]
    counts = {
        "planned": len(planned),
        "attempted": sum(
            1
            for status in statuses
            if status in {"scored", "agent_error", "judge_error", "pending_judge"}
        ),
        "scored": sum(1 for status in statuses if status == "scored"),
        "error": sum(
            1
            for status in statuses
            if status in {"agent_error", "judge_error", "pending_judge", "corrupt"}
        ),
        "skipped": sum(1 for status in statuses if status == "skipped"),
        "not_applicable": not_applicable,
        "not_started": sum(1 for status in statuses if status == "not_started"),
        "persisted": sum(1 for status in statuses if status != "not_started"),
        "cases": len(cases),
        "hard_cases": sum(1 for case in cases if case["hard"]),
        "other_cases": sum(1 for case in cases if not case["hard"]),
        "error_breakdown": {
            "agent": sum(1 for status in statuses if status == "agent_error"),
            "judge": sum(1 for status in statuses if status == "judge_error"),
            "pending": sum(1 for status in statuses if status == "pending_judge"),
            "corrupt": sum(1 for status in statuses if status == "corrupt"),
        },
        "metric_results": {
            "applicable": len(applicable_metrics),
            "scored": len(scored_metrics),
            "error": len(metric_errors),
            "not_applicable": not_applicable,
        },
    }

    # Behaviour thresholds over unique cases.
    hard = [case for case in cases if case["hard"]]
    others = [case for case in cases if not case["hard"]]
    passed_hard = sum(1 for case in hard if case["behaviour"]["passed"] is True)
    passed_others = sum(1 for case in others if case["behaviour"]["passed"] is True)
    passed_overall = passed_hard + passed_others
    thresholds_evaluated = bool(baseline and len(cases) == 20 and len(hard) == 6)
    thresholds = {
        "evaluated": thresholds_evaluated,
        "hard": {
            "required": HARD_REQUIRED,
            "total": len(hard),
            "passed": passed_hard,
            "met": passed_hard == HARD_REQUIRED and len(hard) == HARD_REQUIRED,
        },
        "others": {
            "required": OTHERS_REQUIRED,
            "total": len(others),
            "passed": passed_others,
            "met": passed_others >= OTHERS_REQUIRED and len(others) == 14,
        },
        "overall": {
            "required": OVERALL_REQUIRED,
            "total": len(cases),
            "passed": passed_overall,
            "met": passed_overall >= OVERALL_REQUIRED and len(cases) == 20,
        },
        "judge_threshold": JUDGE_THRESHOLD,
        "retest_trigger": RETEST_TRIGGER,
    }

    # Retest selection: preselected cases, behaviour failures and first-round
    # applicable Task Resolution/Grounding below 0.7. DR-09 executes repeats.
    for case in cases:
        reasons: list[str] = []
        if any(
            case["case_id"] == prefix or case["case_id"].startswith(prefix + "-")
            for prefix in PRESELECTED_RETEST
        ):
            reasons.append("preselected by the parent spec")
        if case["behaviour"]["passed"] is not True:
            reasons.append("behaviour did not pass")
        for metric in case["samples"]:
            for entry in metric.get("judge_metrics") or []:
                if entry.get("metric") not in {"Task Resolution", "Grounding"}:
                    continue
                if entry.get("applicability") != "applicable":
                    continue
                score = entry.get("score")
                if _is_score(score) and float(score) < RETEST_TRIGGER:
                    reasons.append(
                        f"{entry['metric']} {float(score):.3f} below {RETEST_TRIGGER}"
                    )
        case["retest"] = {"selected": bool(reasons), "reasons": reasons}

    # Snapshot: rubric/model/config/scope/dataset/environment.
    projected_rubric = dict(rubric) if isinstance(rubric, Mapping) else None
    if projected_rubric is None:
        for record in records.values():
            projected_rubric = _rubric_from_record(record)
            if projected_rubric is not None:
                break
    model = None
    if isinstance(judge_configuration, Mapping):
        model = {
            "model": judge_configuration.get("model"),
            "model_source": judge_configuration.get("model_source"),
            "base_url": ledger.safe_url(
                judge_configuration.get("base_url") or ""
            ),
            "threshold": judge_configuration.get("threshold"),
        }
    if model is None:
        for record in records.values():
            model = _model_from_record(record)
            if model is not None:
                break
    dataset = dict(manifest.get("dataset") or {})
    configuration = dict(environment.get("configuration") or {})
    budgets = configuration.get("budgets") or {}
    config_snapshot = {
        "suite_version": environment.get("suite_version"),
        "baseline": baseline,
        "base_url": ledger.safe_url(configuration.get("base_url") or ""),
        "judge": (manifest.get("run") or {}).get("judge"),
        "workers": (manifest.get("run") or {}).get("workers"),
        "chat_timeout_s": (manifest.get("run") or {}).get("chat_timeout_s"),
        "budgets": budgets,
        "cache": _cache_snapshot(environment),
        "models": _redact(configuration.get("models") or {}),
        "dataset_sha256": dataset.get("sha256") or configuration.get("dataset_sha256"),
        "evidence_scope": (manifest.get("run") or {}).get(
            "evidence_scope", configuration.get("evidence_scope")
        ),
    }
    snapshots = {
        "dataset": _redact(dataset),
        "rubric": _redact(projected_rubric),
        "model": _redact(model),
        "config": _redact(config_snapshot),
        "scope": {
            "selection": _redact(dict(manifest.get("selection") or {})),
            "cases": [
                {
                    "case_id": case["case_id"],
                    "scope": case["scope"],
                    "hard": case["hard"],
                    "kind": case["kind"],
                }
                for case in cases
            ],
        },
        "environment": _redact(
            {
                "interpreter": environment.get("interpreter"),
                "packages": environment.get("packages"),
                "platform": environment.get("platform"),
                "run_version": environment.get("run_version"),
                "requirements_lock": environment.get("requirements_lock"),
            }
        ),
    }

    # DR-22: the state matrix is projected from retained sample records only.
    # It keeps the original request, the terminal state and the stage reasons,
    # and it lists the offline controlled results separately from the online
    # column (which stays pending/not_run).
    degradation_status = _degradation_status_matrix(planned, records)

    # Incomplete is driven by real execution/record problems, not by product
    # failures. Missing required behaviour, rubric or metric records are also
    # record problems for a baseline.
    reasons = _failure_reasons(scan)
    reasons.extend(degradation_status["gate"]["reasons"])
    if baseline:
        for sample in sample_projections:
            if sample["behaviour_status"] in {"missing", "not_started", "corrupt", "error", "skipped"}:
                reasons.append(
                    {
                        "kind": "behaviour_missing",
                        "sample_id": sample["sample_id"],
                        "detail": f"behaviour status {sample['behaviour_status']}",
                    }
                )
            if sample["status"] == "scored" and sample["metric_count"] == 0:
                reasons.append(
                    {
                        "kind": "metric_records_missing",
                        "sample_id": sample["sample_id"],
                        "detail": "a scored sample has no per-metric record",
                    }
                )
        if projected_rubric is None:
            reasons.append(
                {"kind": "rubric_missing", "detail": "no rubric snapshot was recorded"}
            )
    for sample in sample_projections:
        if not sample["metric_contract_valid"]:
            reasons.append({"kind": "metric_contract_invalid", "sample_id": sample["sample_id"],
                            "detail": sample.get("metric_contract_error")})
    incomplete = bool(scan.get("incomplete")) or any(
        reason.get("kind")
        in {
            "behaviour_missing",
            "metric_records_missing",
            "metric_contract_invalid",
            "rubric_missing",
        }
        for reason in reasons
    )
    judge_gate = bool(cases) and all(
        case["judge"]["passed"] for case in cases
    ) and counts["scored"] == counts["planned"]
    behaviour_gate = (
        thresholds["hard"]["met"]
        and thresholds["others"]["met"]
        and thresholds["overall"]["met"]
        if thresholds_evaluated
        else None
    )
    degradation_failed = degradation_status["gate"]["status"] == "failed"
    if incomplete:
        status = "incomplete"
    elif baseline:
        status = (
            "passed"
            if behaviour_gate and judge_gate and not degradation_failed
            else "failed"
        )
    elif degradation_failed:
        # DR-22: a silent degradation is a failure, never a green run.
        status = "failed"
    else:
        status = "complete"
    gate = {
        "status": status,
        "passed": status == "passed",
        "incomplete": incomplete,
        "score": None if incomplete else scan.get("score"),
        "behaviour_passed": behaviour_gate,
        "judge_passed": judge_gate if counts["planned"] else None,
        "degradation_passed": degradation_status["gate"]["passed"],
        "reasons": reasons,
    }

    # Sections keep execution, behaviour, judge, capability and latency facts
    # separate; no single "pass" hides another dimension.
    facts = []
    citations = []
    isolation = []
    for case in cases:
        behaviour = case.get("behaviour") or {}
        checks = {}
        for sample in case["samples"]:
            record = records.get(sample["sample_id"]) or {}
            raw_behaviour = record.get("behaviour") if isinstance(record, Mapping) else None
            if isinstance(raw_behaviour, Mapping):
                checks.update(raw_behaviour.get("checks") or {})
        entry = {
            "case_id": case["case_id"],
            "kind": case["kind"],
            "status": behaviour.get("status"),
            "passed": behaviour.get("passed"),
            "failures": _redact(behaviour.get("failures") or []),
            "checks": _redact(
                {key: checks[key] for key in FACT_CHECKS if key in checks}
            ),
        }
        facts.append(entry)
        citations.append(
            {
                "case_id": case["case_id"],
                "reference_count": sum(
                    sample.get("reference_count") or 0 for sample in case["samples"]
                ),
                "checks": _redact(
                    {key: checks[key] for key in CITATION_CHECKS if key in checks}
                ),
            }
        )
        if checks and any(key in checks for key in ISOLATION_CHECKS):
            isolation.append(
                {
                    "case_id": case["case_id"],
                    "kind": case["kind"],
                    "checks": _redact(
                        {key: checks[key] for key in ISOLATION_CHECKS if key in checks}
                    ),
                }
            )

    latency_values = [
        float(sample["agent_duration_ms"])
        for sample in sample_projections
        if isinstance(sample.get("agent_duration_ms"), (int, float))
    ]
    latency = {
        "scope": (
            "Agent chat request wall time only (agent.duration_ms); judge time "
            "is excluded from every latency statistic"
        ),
        "judge_excluded": True,
        **_latency_stats(latency_values),
        "missing": sum(
            1
            for sample in sample_projections
            if sample.get("agent_duration_ms") is None
        ),
        "cases": [
            {
                "case_id": case["case_id"],
                "chat_ms": (
                    case["latency_ms"][0] if case["latency_ms"] else None
                ),
            }
            for case in cases
        ],
    }

    capabilities_section = _capabilities(
        environment, capabilities, planned=planned, records=records
    )
    capabilities_section["judge"] = _redact(
        {
            "model": (model or {}).get("model"),
            "model_source": (model or {}).get("model_source"),
            "threshold": JUDGE_THRESHOLD,
        }
    )

    report = {
        "schema": SCHEMA,
        "report_version": REPORT_VERSION,
        "ticket": TICKET,
        "run_id": manifest.get("run_id"),
        "generated_at": ledger.utc_now(),
        "baseline": baseline,
        "counts": counts,
        "thresholds": thresholds,
        "gate": gate,
        "sections": {
            "facts": {"cases": facts},
            "citations": {"cases": citations},
            "isolation": {"cases": isolation},
            "judge": {
                "threshold": JUDGE_THRESHOLD,
                "retest_trigger": RETEST_TRIGGER,
                "metrics": _redact(
                    [
                        {
                            "sample_id": sample["sample_id"],
                            "case_id": sample["case_id"],
                            **entry,
                        }
                        for sample in sample_projections
                        for entry in sample.get("judge_metrics") or []
                    ]
                ),
                "cases": [
                    {
                        "case_id": case["case_id"],
                        **case["judge"],
                    }
                    for case in cases
                ],
                "retest_plan": [
                    {
                        "case_id": case["case_id"],
                        "reasons": case["retest"]["reasons"],
                    }
                    for case in cases
                    if case["retest"]["selected"]
                ],
            },
            "capabilities": capabilities_section,
            "latency": latency,
            "degradation_status": degradation_status,
        },
        "cases": [
            {
                "case_id": case["case_id"],
                "hard": case["hard"],
                "kind": case["kind"],
                "scope": case["scope"],
                "behaviour": _redact(case["behaviour"]),
                "judge": _redact(case["judge"]),
                "errors": _redact(case["errors"]),
                "latency_ms": case["latency_ms"],
                "retest": _redact(case["retest"]),
                "samples": [sample["sample_id"] for sample in case["samples"]],
            }
            for case in cases
        ],
        "snapshots": snapshots,
        "raw": {
            "samples_dir": str(Path(scan.get("run_dir") or "").resolve())
            if scan.get("run_dir")
            else None,
            "samples": _redact(sample_projections),
            "metric_results": _redact(project_metric_results(records.values())),
            "unexpected": list(scan.get("unexpected") or []),
        },
    }
    return report


def render_markdown(report: Mapping[str, Any]) -> str:
    """Human-readable summary of the same JSON report."""
    counts = report.get("counts") or {}
    gate = report.get("gate") or {}
    thresholds = report.get("thresholds") or {}
    degradation = report.get("sections", {}).get("degradation_status") or {}
    lines = [
        f"# Evaluation baseline report {report.get('run_id')}",
        "",
        f"- status: **{gate.get('status')}**",
        f"- incomplete: {gate.get('incomplete')}",
        f"- score: {gate.get('score')}",
        f"- baseline: {report.get('baseline')}",
        "",
        "## Counts",
        "",
        "| planned | attempted | scored | error | skipped | not_applicable | not_started |",
        "|---|---|---|---|---|---|---|",
        "| {planned} | {attempted} | {scored} | {error} | {skipped} | "
        "{not_applicable} | {not_started} |".format(**counts),
        "",
        "## Behaviour thresholds",
        "",
        f"- evaluated: {thresholds.get('evaluated')}",
        f"- hard: {thresholds.get('hard', {}).get('passed')}/"
        f"{thresholds.get('hard', {}).get('total')} "
        f"(required {thresholds.get('hard', {}).get('required')})",
        f"- others: {thresholds.get('others', {}).get('passed')}/"
        f"{thresholds.get('others', {}).get('total')} "
        f"(required {thresholds.get('others', {}).get('required')})",
        f"- overall: {thresholds.get('overall', {}).get('passed')}/"
        f"{thresholds.get('overall', {}).get('total')} "
        f"(required {thresholds.get('overall', {}).get('required')})",
        f"- judge threshold: {thresholds.get('judge_threshold')}; "
        f"retest trigger: {thresholds.get('retest_trigger')}",
        "",
        "## Cases",
        "",
        "| case | hard | behaviour | judge | chat ms | retest |",
        "|---|---|---|---|---|---|",
    ]
    for case in report.get("cases") or []:
        behaviour = case.get("behaviour") or {}
        judge = case.get("judge") or {}
        latency = case.get("latency_ms") or []
        lines.append(
            "| {case} | {hard} | {behaviour} | {judge} | {latency} | {retest} |".format(
                case=case.get("case_id"),
                hard=case.get("hard"),
                behaviour=behaviour.get("status"),
                judge=judge.get("status"),
                latency=latency[0] if latency else "",
                retest=", ".join(case.get("retest", {}).get("reasons") or []),
            )
        )
    lines.extend(
        [
            "",
            "## Capabilities",
            "",
            json.dumps(report.get("sections", {}).get("capabilities") or {}, ensure_ascii=False),
            "",
            "## Degradation status",
            "",
            f"- offline controlled: {degradation.get('gate', {}).get('status')}",
            f"- online: {degradation.get('online', {}).get('status')}",
            "",
            "| case | terminal | classification | stage reasons |",
            "|---|---|---|---|",
        ]
    )
    for row in degradation.get("offline", {}).get("results") or []:
        lines.append(
            "| {case} | {terminal} | {classification} | {reasons} |".format(
                case=row.get("case_id"),
                terminal=row.get("terminal_status"),
                classification=row.get("classification"),
                reasons=", ".join(row.get("stage_reasons") or []),
            )
        )
    lines.extend(
        [
            "",
            "## Incomplete reasons",
            "",
        ]
    )
    for reason in gate.get("reasons") or []:
        lines.append(f"- {reason.get('kind')}: {reason.get('sample_id') or ''} "
                     f"{reason.get('detail') or ''}".rstrip())
    return "\n".join(lines) + "\n"


def write_report(run_dir: str | Path, report: Mapping[str, Any]) -> dict:
    """Write report.json/report.md atomically and read the JSON back."""
    directory = Path(run_dir)
    directory.mkdir(parents=True, exist_ok=True)
    json_path = directory / "report.json"
    markdown_path = directory / "report.md"
    payload = dict(report)
    encoded = json.dumps(payload, ensure_ascii=False, indent=2)
    tmp = json_path.with_name(json_path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(encoded)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, json_path)
    markdown_path.write_text(render_markdown(payload), encoding="utf-8")
    reread = json.loads(json_path.read_text(encoding="utf-8"))
    if reread != payload:
        raise OSError(f"report at {json_path} did not read back intact")
    return {
        "json": str(json_path),
        "markdown": str(markdown_path),
        "sha256": ledger.sha256_file(json_path),
    }
