"""Single-turn tracing evals for NexusRAG (Jev-as-judge).

Why single-turn tracing instead of multi-turn simulation: the provider
available for the simulator's user model (Zhipu glm-5.3-flash) cannot do
structured output, which ConversationSimulator requires, so simulation is
not a viable path here. The 20 gate cases are already complete single-shot
behavior probes (answer / refuse / memory-not-cited, each with its retrieval
scope), and each eval runs the real app inside a DeepEval trace span.

Dataset: tests/evals/.dataset.json holds Goldens converted from the
live-aligned release gate (golden/demo-release-cases.v2.json, 20 cases over
the deterministic demo corpus). Conversion provenance:
tests/evals/convert_demo_gate.mts. No hand-written goldens.

Deterministic gate: every real HTTP reply is first checked by
tests/evals/contracts.py (v2 answer points, inline citations, finite
prohibited assertions, refusal/coverage-gap and memory rules). The per-case
verdict is written under EVAL_DETERMINISTIC_DIR (default .tmp/eval-deterministic)
BEFORE assert_test, so a deterministic failure remains visible when the judge
errors and cannot be erased by a high judge score. The judge only adds the
semantic judgment; it does not replace the deterministic result.

Metrics: per-case plans from metrics.build_case_metrics — every case gets
fresh JevEval instances (Noul/Score/Choice, threshold 0.5) with explicit
standard-answer questions. Applicability is recorded before judging, so a
pure memory view reports document Grounding as not_applicable instead of a
zero or a pass; such a metric is never passed to assert_test.

Run:
  $env:NEXUSRAG_SMOKE_IDS = 'hard-04,hard-01'
  deepeval test run tests/evals/test_nexusrag.py --identifier "smoke-1"
  deepeval test run tests/evals/test_nexusrag.py --num-processes 5 --identifier "round-1"
"""

import json
import os
import sys
from importlib import import_module
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from deepeval import assert_test
from deepeval.dataset import EvaluationDataset, Golden

import contracts
from metrics import build_case_metrics

ai_app = import_module("ai_app")

EVAL_DIR = Path(__file__).resolve().parent
REPO_ROOT = EVAL_DIR.parent.parent

# Per-case deterministic results are written here after the real HTTP reply
# and before the judge runs. A deterministic failure survives a judge error
# and cannot be erased by a high judge score.
DETERMINISTIC_DIR = Path(
    os.environ.get(
        "EVAL_DETERMINISTIC_DIR", str(REPO_ROOT / ".tmp" / "eval-deterministic")
    )
).resolve()

# Optional smoke subset: NEXUSRAG_SMOKE_IDS="hard-04,hard-01" runs only
# matching goldens. Unset (or empty) runs the full dataset.
SMOKE_IDS = [
    s.strip() for s in os.environ.get("NEXUSRAG_SMOKE_IDS", "").split(",") if s.strip()
]

dataset = EvaluationDataset()
dataset.add_goldens_from_json_file(file_path=str(EVAL_DIR / ".dataset.json"))

goldens = list(dataset.goldens)
if SMOKE_IDS:
    goldens = [g for g in goldens if any(s in (g.name or "") for s in SMOKE_IDS)]
    print(f"[evals] smoke subset: {len(goldens)} golden(s) for {SMOKE_IDS}")


def _run_and_capture_raw(golden: Golden) -> tuple[str, dict]:
    """Run the traced app and keep the raw HTTP JSON it observed.

    ai_app owns the HTTP bridge and is not modified here (DR-04/DR-06 own
    it); wrapping its single post function for this turn is the smallest
    way to give the deterministic contract the actual reply, terminal
    status and reference objects.
    """
    captured: dict = {}
    original = ai_app._post_chat

    def capture(*args, **kwargs):
        payload = original(*args, **kwargs)
        captured["payload"] = payload
        return payload

    ai_app._post_chat = capture
    try:
        reply = ai_app.run_traced_ai_app(golden)
    finally:
        ai_app._post_chat = original
    payload = captured.get("payload")
    if not isinstance(payload, dict):
        raise RuntimeError(
            f"no structured chat result was captured for {golden.name!r}"
        )
    if payload.get("reply") != reply:
        raise RuntimeError(
            f"captured raw reply differs from the traced reply for {golden.name!r}"
        )
    return reply, payload


def _write_metric_plan(plan, directory: Path) -> Path:
    """Persist the applicability/rubric plan before any judge request."""
    safe = "".join(
        char if char.isalnum() or char in "._-" else "-"
        for char in str(plan.case_id or "case")
    ).strip("-") or "case"
    path = directory / f"{safe}.metrics-plan.json"
    payload = plan.describe()
    directory.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)
    return path


@pytest.mark.parametrize("golden", goldens, ids=[g.name or g.input[:24] for g in goldens])
def test_nexusrag(golden: Golden):
    _, payload = _run_and_capture_raw(golden)
    metadata = getattr(golden, "additional_metadata", None) or {}

    # Independent deterministic result first: answer points, inline
    # citations, prohibited assertions, refusal/coverage-gap and memory
    # rules. It is persisted before any judge request, so a judge error
    # cannot erase it and a high judge score cannot override it.
    verdict, result_path = contracts.evaluate_and_record(
        metadata,
        payload,
        DETERMINISTIC_DIR,
    )
    status = "PASS" if verdict["passed"] else "FAIL"
    print(
        f"[eval-deterministic] {status} {golden.name} "
        f"({verdict['kind']}) — {result_path}"
    )
    contracts.require_passed(verdict)

    # Fresh metric instances per case; a not_applicable metric is recorded
    # as such and is never sent to the judge (so it is neither a zero nor a
    # pass). A deterministic failure above has already stopped this test.
    plan = build_case_metrics(metadata, case_id=golden.name)
    plan_path = _write_metric_plan(plan, DETERMINISTIC_DIR)
    for item in plan.applicability:
        print(
            f"[eval-metrics] {golden.name} {item.metric}: {item.status} — "
            f"{item.reason} ({plan_path.name}, rubric {plan.rubric_version} "
            f"{plan.rubric_digest[:12]})"
        )
    assert plan.metrics, f"{golden.name}: no applicable metric"
    assert all(
        metric.threshold == 0.5 for metric in plan.metrics
    ), "per-case metrics must keep the 0.5 threshold"

    assert_test(golden=golden, metrics=list(plan.metrics))
