"""Deterministic v2 answer/citation/refusal/memory checks (DR-03).

These checks run on the RAW chat result (the live HTTP JSON reply, its
terminal status and returned references) BEFORE any semantic judge. They
implement the same v2 standard as ``scripts/release-quality-gate.ts``:

  * normalization: Unicode NFKC, lowercase, collapse whitespace runs to one
    space; numbers, units and negation are never removed;
  * answer: every v2 answer point present, at least one exactly parseable
    inline ``[cite:<id>]`` resolving to a returned reference, every reviewed
    prohibited assertion absent, forbidden reference content absent;
  * refuse: honest refusal or coverage-gap evidence. A generic
    clarification-only reply does not satisfy a clear, answerable case
    (hard-05). An explicit empty scope also forbids any reference or inline
    citation - there is no knowledge context at all (hard-03);
  * memory-not-cited: the long-term memory content never appears in the
    references. The owner viewing their own memory is allowed: the reply may
    repeat it and no citation is required.

Honesty boundary: substring containment over normalized text cannot prove
general semantics. Only the FINITE, reviewed v2 ``prohibited_assertions``
are checked here; every other contradiction remains the judge's job. Do not
report these checks as a general semantic proof.

Run one saved live result through the same gate:
  python tests/evals/contracts.py --case hard-04 --result <raw-reply.json>
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import unicodedata
from collections.abc import Mapping
from pathlib import Path
from typing import Any

SCHEMA = "eval-deterministic-result"
CONTRACT_VERSION = 2
RESULT_SUFFIX = ".deterministic.json"

CITE_EXACT = re.compile(r"\[cite:([^\[\]\s]+)\]")
CITE_MARKER = re.compile(r"\[cite:")
CITE_LOOSE = re.compile(r"\[cite:[^\]]*\]?")

REFUSAL_MARKERS = (
    "未找到相关证据",
    "无法生成可靠回答",
    "无法回答",
    "无法作答",
    "证据不足",
    "未能找到",
    "根据现有知识库",
)

# Reviewed clarification-only expressions. They are not refusals: for a
# clear question with a non-empty scope the gap is in the corpus, not in the
# user's input (hard-05).
CLARIFICATION_MARKERS = (
    "请提供更多",
    "请补充",
    "请说明",
    "请明确",
    "能否提供",
    "需要更多信息",
    "需要进一步信息",
    "请问您想",
)

GAP_STATUSES = frozenset(
    {"insufficient_retrieval", "insufficient_evidence", "rejected"}
)
NON_ANSWER_STATUSES = frozenset(
    {
        "clarification_required",
        "insufficient_retrieval",
        "insufficient_evidence",
        "invalid_citation",
        "provider_error",
        "cancelled",
        "handoff_required",
        "rejected",
    }
)
MAX_REFUSAL_CHARS = 1200


class DeterministicContractFailure(AssertionError):
    """Raised before the judge when the deterministic contract fails."""

    def __init__(self, verdict: Mapping[str, Any]) -> None:
        failures = verdict.get("failures") or ["unknown deterministic failure"]
        super().__init__(
            f"deterministic contract failed for {verdict.get('caseId')}: "
            + "; ".join(str(item) for item in failures)
        )
        self.verdict = verdict


def normalize(text: str) -> str:
    """The exact normalization used by scripts/release-quality-gate.ts."""
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", text).lower())


def contains_normalized(haystack: str, needle: str) -> bool:
    """Substring containment over normalized text. Not a semantic proof."""
    return normalize(needle) in normalize(haystack)


def _check(passed: bool, detail: str) -> dict:
    return {"passed": bool(passed), "detail": detail}


def _reference_text(reference: Mapping[str, Any]) -> str:
    parts = []
    for key in ("content", "excerpt", "title"):
        value = reference.get(key)
        if isinstance(value, str):
            parts.append(value)
    return " ".join(parts)


def _reference_id(reference: Mapping[str, Any]) -> str | None:
    value = reference.get("id")
    return value if isinstance(value, str) and value else None


def inspect_inline_citations(
    reply: str, references: list[Mapping[str, Any]]
) -> dict:
    """Return exact ids, malformed tokens and ids that do not resolve."""
    exact = [match.group(1) for match in CITE_EXACT.finditer(reply)]
    marker_count = len(CITE_MARKER.findall(reply))
    malformed: list[str] = []
    if marker_count != len(exact):
        for match in CITE_LOOSE.finditer(reply):
            token = match.group(0)
            if CITE_EXACT.fullmatch(token) is None:
                malformed.append(token)
        if not malformed:
            malformed.append("[cite:...]")

    reference_ids = {
        reference_id
        for reference in references
        if (reference_id := _reference_id(reference)) is not None
    }
    unresolved = sorted({citation for citation in exact if citation not in reference_ids})
    return {
        "present": bool(exact),
        "ids": exact,
        "malformed": malformed,
        "unresolved": unresolved,
    }


def _case_id(case: Mapping[str, Any]) -> str:
    for key in ("gate_id", "case_id", "name"):
        value = case.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return "<unnamed>"


def _reply_sha256(reply: str) -> str:
    return hashlib.sha256(reply.encode("utf-8")).hexdigest()


def _base_verdict(
    case: Mapping[str, Any],
    result: Mapping[str, Any],
    reply: str,
    references: list,
) -> dict:
    return {
        "schema": SCHEMA,
        "contractVersion": CONTRACT_VERSION,
        "caseId": _case_id(case),
        "kind": case.get("kind"),
        "passed": False,
        "terminalStatus": result.get("status") if isinstance(result.get("status"), str) else None,
        "referenceCount": len(references),
        "referenceIds": [
            reference_id
            for reference in references
            if (reference_id := _reference_id(reference)) is not None
        ],
        "replySha256": _reply_sha256(reply),
        "replyChars": len(reply),
        "checks": {},
        "failures": [],
    }


def _finish(verdict: dict) -> dict:
    verdict["passed"] = not verdict["failures"]
    return verdict


def _common_contract_checks(
    case: Mapping[str, Any], verdict: dict
) -> None:
    version = case.get("contract_version")
    version_ok = version == CONTRACT_VERSION
    verdict["checks"]["contract_version"] = _check(
        version_ok,
        f"contract version {version!r} (expected {CONTRACT_VERSION})",
    )
    if not version_ok:
        verdict["failures"].append(
            f"invalid case: contract_version must be {CONTRACT_VERSION}, found {version!r}"
        )

    if "scope" in case:
        scope_ok = isinstance(case["scope"], list) and all(
            isinstance(entry, str) for entry in case["scope"]
        )
        verdict["checks"]["scope_shape"] = _check(
            scope_ok, "scope must be an array of strings when present"
        )
        if not scope_ok:
            verdict["failures"].append(
                "invalid case: scope must be an array of strings"
            )


def _evaluate_answer(case: Mapping[str, Any], verdict: dict, reply: str, references: list) -> None:
    points = case.get("answer_points")
    points_ok = (
        isinstance(points, list)
        and len(points) > 0
        and all(isinstance(point, str) and point.strip() for point in points)
    )
    verdict["checks"]["answer_points_configured"] = _check(
        points_ok,
        "non-empty answer_points are required; an empty set cannot pass"
        if not points_ok
        else f"{len(points)} reviewed answer point(s)",
    )
    if not points_ok:
        verdict["failures"].append(
            "invalid case: an answer case requires non-empty answer_points"
        )
        return

    normalized_reply = normalize(reply)
    missing = [
        point for point in points if normalize(point) not in normalized_reply
    ]
    verdict["checks"]["answer_points"] = _check(
        not missing,
        f"all {len(points)} answer point(s) present"
        if not missing
        else f"missing answer point(s): {' | '.join(missing)}",
    )
    if missing:
        verdict["failures"].append(
            f"missing answer point(s): {' | '.join(missing)}"
        )

    status = (verdict["terminalStatus"] or "").lower()
    status_ok = status not in NON_ANSWER_STATUSES
    verdict["checks"]["terminal_status"] = _check(
        status_ok,
        f"terminal status {status or 'none'} allows an answer"
        if status_ok
        else f"expected an answer, got terminal status {status}",
    )
    if not status_ok:
        verdict["failures"].append(
            f"expected an answer, got terminal status {status}"
        )

    citations = inspect_inline_citations(reply, references)
    verdict["checks"]["inline_citation_present"] = _check(
        citations["present"],
        "inline [cite:<id>] present"
        if citations["present"]
        else "no inline [cite:<id>] in the reply",
    )
    if not citations["present"] and not citations["malformed"]:
        verdict["failures"].append("no inline [cite:<id>] in the reply")

    verdict["checks"]["inline_citation_parseable"] = _check(
        not citations["malformed"],
        "every [cite:...] token is exactly [cite:<id>]"
        if not citations["malformed"]
        else f"malformed inline citation(s): {' | '.join(citations['malformed'])}",
    )
    if citations["malformed"]:
        verdict["failures"].append(
            f"malformed inline citation(s): {' | '.join(citations['malformed'])}"
        )

    verdict["checks"]["inline_citation_resolved"] = _check(
        not citations["unresolved"],
        f"{len(citations['ids'])} inline citation id(s) resolve to returned references"
        if not citations["unresolved"]
        else "inline citation id(s) not in the returned references: "
        + " | ".join(citations["unresolved"]),
    )
    if citations["unresolved"]:
        verdict["failures"].append(
            "inline citation id(s) not in the returned references: "
            + " | ".join(citations["unresolved"])
        )

    prohibited_configured = case.get("prohibited_assertions", [])
    prohibited_shape_ok = isinstance(prohibited_configured, list) and all(
        isinstance(assertion, str) and assertion.strip()
        for assertion in prohibited_configured
    )
    verdict["checks"]["prohibited_assertions_configured"] = _check(
        prohibited_shape_ok,
        "prohibited_assertions is an array of non-empty strings"
        if prohibited_shape_ok
        else "prohibited_assertions must be an array of non-empty strings",
    )
    if not prohibited_shape_ok:
        verdict["failures"].append(
            "invalid case: prohibited_assertions must be an array of non-empty strings"
        )
        prohibited_configured = []

    prohibited = [
        assertion
        for assertion in prohibited_configured
        if contains_normalized(reply, assertion)
    ]
    verdict["checks"]["prohibited_assertions"] = _check(
        not prohibited,
        f"{len(prohibited_configured)} reviewed prohibition(s) absent"
        if not prohibited
        else f"prohibited assertion(s) present: {' | '.join(prohibited)}",
    )
    if prohibited:
        verdict["failures"].append(
            f"prohibited assertion(s) present: {' | '.join(prohibited)}"
        )

    forbidden = case.get("forbidden_reference_content")
    forbidden_absent = forbidden is None
    forbidden_shape_ok = forbidden_absent or (
        isinstance(forbidden, str) and bool(forbidden.strip())
    )
    verdict["checks"]["forbidden_reference_content_configured"] = _check(
        forbidden_shape_ok,
        "forbidden_reference_content is absent or a non-empty string"
        if forbidden_shape_ok
        else "forbidden_reference_content must be a non-empty string when present",
    )
    if not forbidden_shape_ok:
        verdict["failures"].append(
            "invalid case: forbidden_reference_content must be a non-empty string when present"
        )
    elif forbidden_absent:
        verdict["checks"]["forbidden_reference_content"] = _check(
            True, "no forbidden reference content configured"
        )
    else:
        hit = any(
            contains_normalized(_reference_text(reference), forbidden)
            for reference in references
        )
        verdict["checks"]["forbidden_reference_content"] = _check(
            not hit,
            "forbidden reference content absent"
            if not hit
            else "forbidden reference content appeared in the references",
        )
        if hit:
            verdict["failures"].append(
                "forbidden reference content appeared in the references"
            )


def _evaluate_refuse(case: Mapping[str, Any], verdict: dict, reply: str, references: list) -> None:
    status = (verdict["terminalStatus"] or "").lower()
    normalized_reply = normalize(reply)
    gap_marker = any(
        normalize(marker) in normalized_reply for marker in REFUSAL_MARKERS
    )
    gap_status = status in GAP_STATUSES
    clarification_marker = any(
        normalize(marker) in normalized_reply
        for marker in CLARIFICATION_MARKERS
    )
    clarification_only = status == "clarification_required" or (
        clarification_marker and not gap_marker
    )

    gap_ok = gap_marker or gap_status
    verdict["checks"]["honest_refusal"] = _check(
        gap_ok,
        "honest refusal or coverage-gap evidence present"
        if gap_ok
        else f"expected an honest refusal or coverage-gap admission, got status {status or 'none'}",
    )
    if not gap_ok:
        verdict["failures"].append(
            "expected an honest refusal or coverage-gap admission, got status "
            f"{status or 'none'}"
        )

    verdict["checks"]["clarification_is_not_refusal"] = _check(
        not clarification_only,
        "no generic clarification-only reply"
        if not clarification_only
        else "generic clarification-only reply present (not a refusal)",
    )
    if clarification_only:
        verdict["failures"].append(
            "generic clarification-only reply does not satisfy a clear, answerable refusal case"
        )

    scope = case.get("scope")
    if isinstance(scope, list) and len(scope) == 0:
        cites_inline = bool(CITE_MARKER.search(reply))
        empty_ok = len(references) == 0 and not cites_inline
        verdict["checks"]["empty_scope"] = _check(
            empty_ok,
            "explicit empty scope returned no knowledge context"
            if empty_ok
            else "explicit empty scope must not return references or inline citations",
        )
        if not empty_ok:
            verdict["failures"].append(
                "explicit empty scope must not return references or inline citations"
            )
    else:
        verdict["checks"]["empty_scope"] = _check(
            True, "scope is non-empty or omitted (default scope)"
        )

    length_ok = len(reply) < MAX_REFUSAL_CHARS
    verdict["checks"]["reply_length"] = _check(
        length_ok,
        f"refusal reply is {len(reply)} characters (< {MAX_REFUSAL_CHARS})"
        if length_ok
        else "refusal reply is too long to be an honest refusal",
    )
    if not length_ok:
        verdict["failures"].append(
            "refusal reply is too long to be an honest refusal"
        )


def _evaluate_memory(case: Mapping[str, Any], verdict: dict, reply: str, references: list) -> None:
    forbidden = case.get("forbidden_reference_content")
    forbidden_ok = isinstance(forbidden, str) and bool(forbidden.strip())
    verdict["checks"]["memory_constraint_configured"] = _check(
        forbidden_ok,
        "forbidden_reference_content is required for memory-not-cited"
        if not forbidden_ok
        else "forbidden memory content is configured",
    )
    if not forbidden_ok:
        verdict["failures"].append(
            "invalid case: memory-not-cited requires forbidden_reference_content"
        )
        return

    hit = any(
        contains_normalized(_reference_text(reference), forbidden)
        for reference in references
    )
    verdict["checks"]["memory_not_in_references"] = _check(
        not hit,
        "long-term memory content is absent from the references"
        if not hit
        else "the long-term memory content appeared in the references",
    )
    if hit:
        verdict["failures"].append(
            "the long-term memory content appeared in the references"
        )

    # The owner may view their own memory: repeating it in the reply is not a
    # violation, and no document citation is required for this kind.
    verdict["checks"]["owner_viewing_allowed"] = _check(
        True, "owner memory viewing is allowed; no citation is required"
    )


def evaluate_case(case: Mapping[str, Any], result: Mapping[str, Any]) -> dict:
    """Evaluate one v2 case against one raw chat result; never raises."""
    if not isinstance(case, Mapping):
        case = {}
    if not isinstance(result, Mapping):
        result = {}
    reply = result.get("reply")
    references = result.get("references")
    if not isinstance(reply, str):
        reply = ""
    if not isinstance(references, list):
        references = []
    references = [reference for reference in references if isinstance(reference, dict)]

    verdict = _base_verdict(case, result, reply, references)

    status_value = result.get("status")
    status_shape_ok = status_value is None or isinstance(status_value, str)
    result_shape_ok = (
        isinstance(result.get("reply"), str)
        and isinstance(result.get("references", []), list)
        and status_shape_ok
    )
    verdict["checks"]["result_shape"] = _check(
        result_shape_ok,
        "reply is a string, status is a string when present and references is an array"
        if result_shape_ok
        else "reply must be a string, status a string when present and references an array",
    )
    if not result_shape_ok:
        verdict["failures"].append(
            "invalid result: reply must be a string, status a string when present "
            "and references must be an array"
        )

    _common_contract_checks(case, verdict)

    kind = case.get("kind")
    if kind == "answer":
        _evaluate_answer(case, verdict, reply, references)
    elif kind == "refuse":
        _evaluate_refuse(case, verdict, reply, references)
    elif kind == "memory-not-cited":
        _evaluate_memory(case, verdict, reply, references)
    else:
        verdict["checks"]["kind"] = _check(False, f"unknown kind {kind!r}")
        verdict["failures"].append(f"invalid case: unknown kind {kind!r}")

    return _finish(verdict)


def require_passed(verdict: Mapping[str, Any]) -> None:
    """Fail before the judge when the deterministic contract did not pass."""
    if verdict.get("schema") != SCHEMA:
        raise DeterministicContractFailure(
            {"caseId": verdict.get("caseId"), "failures": ["unknown verdict schema"]}
        )
    if verdict.get("passed") is not True:
        raise DeterministicContractFailure(verdict)


def result_path(directory: str | os.PathLike[str], case_id: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9._-]+", "-", case_id).strip("-") or "case"
    return Path(directory) / f"{safe}{RESULT_SUFFIX}"


def _write_json_atomic(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)


def write_case_result(
    verdict: Mapping[str, Any], directory: str | os.PathLike[str]
) -> Path:
    """Persist one deterministic result so it survives a judge failure."""
    path = result_path(directory, str(verdict.get("caseId") or "case"))
    _write_json_atomic(path, verdict)
    return path


def load_case_result(
    directory: str | os.PathLike[str], case_id: str
) -> dict:
    return json.loads(result_path(directory, case_id).read_text(encoding="utf-8"))


def evaluate_and_record(
    case: Mapping[str, Any],
    result: Mapping[str, Any],
    directory: str | os.PathLike[str],
) -> tuple[dict, Path]:
    verdict = evaluate_case(case, result)
    return verdict, write_case_result(verdict, directory)


def _load_golden(dataset_path: Path, case_id: str) -> dict:
    dataset = json.loads(dataset_path.read_text(encoding="utf-8"))
    goldens = dataset if isinstance(dataset, list) else dataset.get("goldens", [])
    for golden in goldens:
        if golden.get("name") == case_id:
            return golden.get("additional_metadata") or {}
    raise SystemExit(f"case {case_id!r} not found in {dataset_path}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Apply the deterministic v2 gate to a saved raw chat reply"
    )
    parser.add_argument("--dataset", default=str(EVAL_DATASET))
    parser.add_argument("--case", required=True, help="golden name / gate id")
    parser.add_argument("--result", required=True, help="raw chat JSON response")
    parser.add_argument(
        "--out",
        default=None,
        help="directory for <case>.deterministic.json (default: beside --result)",
    )
    args = parser.parse_args(argv)

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    case = _load_golden(Path(args.dataset).resolve(), args.case)
    raw = json.loads(Path(args.result).read_text(encoding="utf-8"))
    out_dir = Path(args.out).resolve() if args.out else Path(args.result).resolve().parent
    verdict, path = evaluate_and_record(case, raw, out_dir)
    print(json.dumps(verdict, ensure_ascii=False, indent=2, sort_keys=True))
    print(f"deterministic result written to {path}", file=sys.stderr)
    return 0 if verdict["passed"] else 1


EVAL_DATASET = Path(__file__).resolve().parent / ".dataset.json"


if __name__ == "__main__":
    raise SystemExit(main())
