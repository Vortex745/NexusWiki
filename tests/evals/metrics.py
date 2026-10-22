"""Per-case DeepEval metrics with explicit standard-answer questions (DR-06).

All metrics remain Jev-native (``JevEval`` with ``Noul`` / ``Score`` /
``Choice`` and the unchanged 0.5 threshold). The judge is TypeSafe's jev
model via ``TYPESAFE_API_KEY``; no OpenAI-style LLM judge is involved.

A metric instance holds its last score, reason and breakdown, so it must
never be shared across cases. ``build_case_metrics`` therefore creates a
fresh set of ``JevEval`` objects for every case and returns the case's
applicability policy alongside them:

  * answer cases carry explicit questions for (a) coverage of every real
    standard answer point, (b) contradiction with the standard answer and
    (c) conclusions asserted as fact that the cited evidence does not
    support;
  * refuse cases distinguish an honest refusal / coverage-gap admission
    from a generic clarification, while a targeted clarification for truly
    missing parameters is judged by its own conduct rule;
  * a pure memory view (``memory-not-cited`` with no document facts) marks
    document Grounding ``not_applicable``. No retrieval_context is
    fabricated for it and it is neither a zero nor a pass; an answer with
    document facts always keeps its applicable Grounding metric.

Evidence boundary: Grounding compares the reply with the returned reference
titles and bounded excerpts (up to 600 characters per reference, published by
the bridge as trace retrieval context). Those excerpts are cited-evidence
summaries, not the full generation context, so Grounding can only speak to
support-by-cited-evidence.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any, Iterable, Mapping, Sequence

from deepeval.metrics import JevEval
from deepeval.metrics.jev_eval import Choice, Noul, Score
from deepeval.test_case import SingleTurnParams

RUBRIC_VERSION = "dr-06.2"
DEFAULT_THRESHOLD = 0.5

TASK_RESOLUTION = "Task Resolution"
GROUNDING = "Grounding"
RESPONSE_CONDUCT = "Response Conduct"

EVIDENCE_SCOPE = (
    "retrieval excerpts are cited-evidence summaries: bounded reference "
    "titles and excerpts (up to 600 characters per reference), not the full "
    "generation context. Grounding judges support against these cited "
    "excerpts only."
)

# Rubric question openers. The controlled judge in test_judge_contract.py
# matches these prefixes; keeping them public keeps the rubric contract
# inspectable without reaching into JevEval internals.
COVERAGE_QUESTION_PREFIX = (
    "The reply covers every standard answer point for this case. "
    "Standard answer points (标准答案要点（须全部出现）): "
)
CONTRADICTION_QUESTION_PREFIX = (
    "The reply does not contradict the standard answer. A different number, "
    "a different unit, a reversed negation or an opposite policy is a "
    "contradiction. Standard answer points: "
)
UNSUPPORTED_QUESTION_PREFIX = (
    "The reply does not assert any conclusion as fact that the cited evidence "
    "does not support. A plausible inference that goes beyond the returned "
    "reference excerpts (for example an unstated consequence of an "
    "unconfigured component) is an unsupported conclusion. Cited evidence "
    "means the bounded reference excerpts, not the full generation context. "
)
REFUSAL_QUESTION_PREFIX = (
    "The reply refuses to answer or explicitly admits a coverage gap for "
    "this clear, out-of-domain question. A generic clarification-only reply "
    "does not qualify as a correct refusal."
)
MEMORY_QUESTION_PREFIX = (
    "The reply answers the owner's memory view request, or hands off "
    "honestly. Repeating the owner's own long-term memory is allowed and "
    "requires no document citation."
)

GENERIC_TASK_QUESTION = (
    "The assistant's reply substantively addresses the input request - answering "
    "it, refusing it with a reason, or asking a targeted clarification - rather "
    "than ignoring, deflecting or fabricating an answer."
)
ENGAGEMENT_QUESTION = (
    "The reply engages with the input request - answering, refusing with a "
    "reason, or asking a targeted clarification - rather than ignoring or "
    "deflecting it."
)
CLARIFICATION_CONDUCT_QUESTION = (
    "The reply does not substitute a generic clarification for a clear "
    "question. Only a targeted clarification for truly missing parameters may "
    "earn clarification credit, and it is judged by its own option."
)

BEHAVIOR_OPTIONS = {
    "answered_or_refused_with_source_support": 1.0,
    "asked_targeted_clarification_for_missing_parameters": 0.7,
    "generic_clarification_for_a_clear_question": 0.0,
    "deflected_or_ignored": 0.0,
}
ANSWER_BEHAVIOR_OPTIONS = {
    "answered": 1.0,
    "correctly_refused_or_admitted_gap": 1.0,
    "asked_targeted_clarification_for_missing_parameters": 0.7,
    "generic_clarification_for_a_clear_question": 0.0,
    "deflected_or_ignored": 0.0,
}
GROUNDING_OPTIONS = {
    "answers_from_evidence": 1.0,
    "admits_gap_or_refuses": 0.8,
    "hedges_without_answering": 0.4,
    "invents_details": 0.0,
}
SETTLE_LEVELS = [
    "Not addressed",
    "Partly settled",
    "Fully resolved or appropriately handed off",
]
COVERAGE_LEVELS = [
    "No standard answer point covered",
    "Some standard answer points covered",
    "All standard answer points covered",
]
REFUSAL_LEVELS = [
    "No honest refusal or coverage-gap admission",
    "Vague or partial refusal",
    "Clear refusal or coverage-gap admission",
]


@dataclass(frozen=True)
class MetricApplicability:
    """Whether one metric applies to a case, and why."""

    metric: str
    status: str  # "applicable" | "not_applicable"
    reason: str

    def as_dict(self) -> dict:
        return {"metric": self.metric, "status": self.status, "reason": self.reason}


@dataclass(frozen=True)
class CaseMetricPlan:
    """Fresh metrics plus the applicability/rubric facts for one case."""

    case_id: str | None
    kind: str | None
    metrics: tuple[JevEval, ...]
    applicability: tuple[MetricApplicability, ...]
    rubric_version: str
    rubric_digest: str
    plan_digest: str
    evidence_scope: str = EVIDENCE_SCOPE

    def applicability_map(self) -> dict[str, str]:
        return {item.metric: item.status for item in self.applicability}

    def describe(self) -> dict:
        """Serializable rubric/coverage snapshot; no Jev object internals."""
        entries: dict[str, dict] = {
            item.metric: {
                "applicability": item.status,
                "reason": item.reason,
                "threshold": None,
                "questions": [],
            }
            for item in self.applicability
        }
        for metric in self.metrics:
            entries[metric.name] = {
                "applicability": "applicable",
                "reason": entries.get(metric.name, {}).get("reason", ""),
                "threshold": metric.threshold,
                "questions": [
                    _question_description(question) for question in metric.questions
                ],
            }
        return {
            "case_id": self.case_id,
            "kind": self.kind,
            "rubric_version": self.rubric_version,
            "rubric_digest": self.rubric_digest,
            "plan_digest": self.plan_digest,
            "evidence_scope": self.evidence_scope,
            "metrics": entries,
        }


def _question_description(question: Any) -> dict:
    if isinstance(question, Noul):
        return {"type": "noul", "text": question.text, "weight": question.weight}
    if isinstance(question, Score):
        return {
            "type": "score",
            "text": question.text,
            "levels": list(question.levels),
            "weight": question.weight,
        }
    if isinstance(question, Choice):
        return {
            "type": "choice",
            "text": question.text,
            "options": dict(question.options),
            "weight": question.weight,
        }
    return {"type": type(question).__name__, "text": getattr(question, "text", "")}


def _question_spec(question: Any) -> dict:
    description = _question_description(question)
    return {
        "type": description["type"],
        "text": description["text"],
        "weight": description["weight"],
        **(
            {"levels": description["levels"]}
            if description["type"] == "score"
            else {}
        ),
        **(
            {"options": description["options"]}
            if description["type"] == "choice"
            else {}
        ),
    }


def _build_question(spec: Mapping[str, Any]) -> Any:
    if spec["type"] == "noul":
        return Noul(spec["text"], weight=spec["weight"])
    if spec["type"] == "score":
        return Score(spec["text"], levels=list(spec["levels"]), weight=spec["weight"])
    if spec["type"] == "choice":
        return Choice(spec["text"], options=dict(spec["options"]), weight=spec["weight"])
    raise ValueError(f"unsupported question type {spec['type']!r}")


def _noul(text: str, weight: float = 1.0) -> dict:
    return {"type": "noul", "text": text, "weight": weight}


def _score(text: str, levels: Sequence[str], weight: float = 1.0) -> dict:
    return {"type": "score", "text": text, "levels": list(levels), "weight": weight}


def _choice(text: str, options: Mapping[str, float | None], weight: float = 1.0) -> dict:
    return {"type": "choice", "text": text, "options": dict(options), "weight": weight}


def _format_points(points: Iterable[str]) -> str:
    return " | ".join(f'"{point}"' for point in points)


def _answer_point_list(metadata: Mapping[str, Any]) -> list[str]:
    points = metadata.get("answer_points")
    if not isinstance(points, (list, tuple)):
        return []
    return [point for point in points if isinstance(point, str) and point.strip()]


def _prohibited_list(metadata: Mapping[str, Any]) -> list[str]:
    assertions = metadata.get("prohibited_assertions")
    if not isinstance(assertions, (list, tuple)):
        return []
    return [item for item in assertions if isinstance(item, str) and item.strip()]


def _has_document_facts(metadata: Mapping[str, Any]) -> bool:
    """Answer points are the reviewed document facts. Memory-only has none."""
    if _answer_point_list(metadata):
        return True
    return metadata.get("kind") != "memory-not-cited"


def _task_resolution_questions(
    kind: str | None, metadata: Mapping[str, Any]
) -> list[dict]:
    if kind == "answer":
        points = _answer_point_list(metadata)
        prohibited = _prohibited_list(metadata)
        unsupported = (
            UNSUPPORTED_QUESTION_PREFIX
            + "Standard answer points: "
            + _format_points(points)
            + "."
        )
        if prohibited:
            unsupported += (
                " Known unsupported inference(s) for this case: "
                + _format_points(prohibited)
                + "."
            )
        return [
            _noul(GENERIC_TASK_QUESTION, 1.0),
            _noul(
                COVERAGE_QUESTION_PREFIX
                + _format_points(points)
                + ".",
                2.0,
            ),
            _noul(
                CONTRADICTION_QUESTION_PREFIX + _format_points(points) + ".",
                2.0,
            ),
            _noul(unsupported, 2.0),
            _score(
                "How fully does the reply cover the standard answer points?",
                COVERAGE_LEVELS,
                2.0,
            ),
            _score("How fully does the reply settle the input?", SETTLE_LEVELS, 2.0),
            _choice(
                "What best describes the reply?",
                ANSWER_BEHAVIOR_OPTIONS,
                1.0,
            ),
        ]
    if kind == "refuse":
        return [
            _noul(GENERIC_TASK_QUESTION, 1.0),
            _noul(REFUSAL_QUESTION_PREFIX, 2.0),
            _noul(
                "The reply does not invent an answer where the knowledge scope "
                "has no coverage.",
                2.0,
            ),
            _score(
                "How clearly does the reply refuse or admit the coverage gap?",
                REFUSAL_LEVELS,
                2.0,
            ),
            _choice("What best describes the reply?", BEHAVIOR_OPTIONS, 1.0),
        ]
    if kind == "memory-not-cited":
        return [
            _noul(GENERIC_TASK_QUESTION, 1.0),
            _noul(MEMORY_QUESTION_PREFIX, 2.0),
            _noul(
                "The reply does not present long-term memory as retrieved "
                "document evidence and does not attach document citations to it.",
                2.0,
            ),
            _score("How fully does the reply settle the input?", SETTLE_LEVELS, 2.0),
            _choice("What best describes the reply?", BEHAVIOR_OPTIONS, 1.0),
        ]
    return [_noul(GENERIC_TASK_QUESTION, 1.0)]


def _grounding_questions() -> list[dict]:
    return [
        _noul(
            "The reply's factual claims (numbers, names, policies, procedures) "
            "are supported by the cited evidence excerpts - "
            + EVIDENCE_SCOPE,
            1.0,
        ),
        _noul(
            "Any conclusion the reply states as fact is supported by the cited "
            "evidence excerpts; a plausible inference the excerpts do not state "
            "is unsupported.",
            2.0,
        ),
        _choice(
            "Does the reply introduce any detail or conclusion that the cited "
            "evidence does not support? Judge invention by the source-support "
            "relationship: the words 虚构 or 演示数据 appearing in the source or "
            "the reply are not by themselves invention; only an unsupported "
            "claim is. " + EVIDENCE_SCOPE,
            GROUNDING_OPTIONS,
            2.0,
        ),
    ]


def _conduct_questions() -> list[dict]:
    return [
        _noul(ENGAGEMENT_QUESTION, 1.0),
        _noul(CLARIFICATION_CONDUCT_QUESTION, 2.0),
        _choice(
            "What did the reply do with the input? A generic clarification for "
            "a clear question earns nothing; a targeted clarification for truly "
            "missing parameters is judged by its own option.",
            BEHAVIOR_OPTIONS,
            1.0,
        ),
    ]


def _metric_specs(metadata: Mapping[str, Any]) -> list[dict]:
    kind = metadata.get("kind")
    if kind not in {"answer", "refuse", "memory-not-cited"}:
        # Outside the v2 dataset there is no case kind or answer point to ask
        # about; keep the DR-05 single-question compatibility plan.
        return [
            {
                "name": TASK_RESOLUTION,
                "applicability": "applicable",
                "reason": "single-question compatibility plan for a case without v2 metadata",
                "evaluation_params": [
                    SingleTurnParams.INPUT,
                    SingleTurnParams.ACTUAL_OUTPUT,
                ],
                "questions": [_noul(GENERIC_TASK_QUESTION, 1.0)],
            }
        ]

    specs = [
        {
            "name": TASK_RESOLUTION,
            "applicability": "applicable",
            "reason": "every case is judged for task resolution",
            "evaluation_params": [
                SingleTurnParams.INPUT,
                SingleTurnParams.ACTUAL_OUTPUT,
                SingleTurnParams.EXPECTED_OUTPUT,
                # The unsupported-addition question compares the reply with
                # the cited evidence, so answer cases expose its bounded
                # excerpts to Task Resolution as well.
                *(
                    [SingleTurnParams.RETRIEVAL_CONTEXT]
                    if kind == "answer"
                    else []
                ),
            ],
            "questions": _task_resolution_questions(kind, metadata),
        }
    ]
    if _has_document_facts(metadata):
        specs.append(
            {
                "name": GROUNDING,
                "applicability": "applicable",
                "reason": (
                    "the case asserts document facts; grounded against bounded "
                    "cited-evidence excerpts"
                ),
                "evaluation_params": [
                    SingleTurnParams.INPUT,
                    SingleTurnParams.ACTUAL_OUTPUT,
                    SingleTurnParams.RETRIEVAL_CONTEXT,
                ],
                "questions": _grounding_questions(),
            }
        )
    else:
        specs.append(
            {
                "name": GROUNDING,
                "applicability": "not_applicable",
                "reason": (
                    "owner memory view: no document facts are asserted, no "
                    "retrieval_context is fabricated, and document Grounding is "
                    "neither a zero nor a pass"
                ),
                "evaluation_params": [],
                "questions": [],
            }
        )
    specs.append(
        {
            "name": RESPONSE_CONDUCT,
            "applicability": "applicable",
            "reason": "single-turn conduct, including clarification vs refusal",
            "evaluation_params": [
                SingleTurnParams.INPUT,
                SingleTurnParams.ACTUAL_OUTPUT,
            ],
            "questions": _conduct_questions(),
        }
    )
    return specs


def rubric_definition() -> dict:
    """The frozen, case-independent rubric facts used for the digest."""
    return {
        "version": RUBRIC_VERSION,
        "threshold": DEFAULT_THRESHOLD,
        "evidence_scope": EVIDENCE_SCOPE,
        "answer_question_prefixes": {
            "coverage": COVERAGE_QUESTION_PREFIX,
            "contradiction": CONTRADICTION_QUESTION_PREFIX,
            "unsupported": UNSUPPORTED_QUESTION_PREFIX,
        },
        "refusal_question": REFUSAL_QUESTION_PREFIX,
        "memory_question": MEMORY_QUESTION_PREFIX,
        "behavior_options": BEHAVIOR_OPTIONS,
        "answer_behavior_options": ANSWER_BEHAVIOR_OPTIONS,
        "grounding_options": GROUNDING_OPTIONS,
        "question_types": {
            TASK_RESOLUTION: ["noul", "score", "choice"],
            GROUNDING: ["noul", "choice"],
            RESPONSE_CONDUCT: ["noul", "choice"],
        },
    }


def _canonical_digest(payload: Any) -> str:
    canonical = json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def rubric_digest() -> str:
    """Stable digest of the frozen rubric (same across runs/processes)."""
    return _canonical_digest(rubric_definition())


def _plan_specs(metadata: Mapping[str, Any]) -> list[dict]:
    return _metric_specs(metadata)


def _serializable_specs(specs: Iterable[Mapping[str, Any]]) -> list[dict]:
    serializable = []
    for spec in specs:
        item = {key: value for key, value in spec.items() if key != "evaluation_params"}
        item["evaluation_params"] = [
            getattr(param, "value", param) for param in spec["evaluation_params"]
        ]
        serializable.append(item)
    return serializable


def build_case_metrics(
    metadata: Mapping[str, Any] | None, *, case_id: str | None = None
) -> CaseMetricPlan:
    """Build fresh, case-specific metrics and the applicability policy.

    Never returns a shared ``JevEval`` instance: metric objects hold the last
    score/reason, so every case must get its own.
    """
    metadata = dict(metadata or {})
    kind = metadata.get("kind")
    specs = _plan_specs(metadata)
    job = {
        "rubric_digest": rubric_digest(),
        "case_id": case_id,
        "kind": kind,
        "specs": _serializable_specs(specs),
    }
    plan_digest = _canonical_digest(job)

    built: list[JevEval] = []
    applicability: list[MetricApplicability] = []
    for spec in specs:
        applicability.append(
            MetricApplicability(
                metric=spec["name"],
                status=spec["applicability"],
                reason=spec["reason"],
            )
        )
        if spec["applicability"] != "applicable":
            continue
        built.append(
            JevEval(
                name=spec["name"],
                evaluation_params=list(spec["evaluation_params"]),
                questions=[_build_question(question) for question in spec["questions"]],
                threshold=DEFAULT_THRESHOLD,
                async_mode=False,
            )
        )
    return CaseMetricPlan(
        case_id=case_id,
        kind=kind,
        metrics=tuple(built),
        applicability=tuple(applicability),
        rubric_version=RUBRIC_VERSION,
        rubric_digest=job["rubric_digest"],
        plan_digest=plan_digest,
    )
