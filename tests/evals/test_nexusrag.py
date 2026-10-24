"""Single-turn tracing evals for NexusRAG (Jev-as-judge).

Why single-turn tracing instead of multi-turn simulation: the provider
available for the simulator's user model (Zhipu glm-5.3-flash) cannot do
structured output, which ConversationSimulator requires, so simulation is
not a viable path here. The 20 gate cases are already complete single-shot
behavior probes (answer / refuse / memory-not-cited, each with its retrieval
scope), and each eval runs the real app inside a DeepEval trace span.

Dataset: tests/evals/.dataset.json holds Goldens converted from the
live-aligned release gate (golden/demo-release-cases.v1.json, 20 cases over
the deterministic demo corpus). Conversion provenance:
tests/evals/convert_demo_gate.mts. No hand-written goldens.

Metrics: SINGLE_TURN_TRACE_METRICS from metrics.py — all JevEval
(Jev-native), so every judgment comes from jev, never an LLM verdict.

Run:
  $env:NEXUSRAG_SMOKE_IDS = 'hard-04,hard-01'
  deepeval test run tests/evals/test_nexusrag.py --identifier "smoke-1"
  deepeval test run tests/evals/test_nexusrag.py --num-processes 5 --identifier "round-1"
"""

import os
import sys
from importlib import import_module
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from deepeval import assert_test
from deepeval.dataset import EvaluationDataset, Golden

from metrics import SINGLE_TURN_TRACE_METRICS

ai_app = import_module("ai_app")

EVAL_DIR = Path(__file__).resolve().parent

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


@pytest.mark.parametrize("golden", goldens, ids=[g.name or g.input[:24] for g in goldens])
def test_nexusrag(golden: Golden):
    ai_app.run_traced_ai_app(golden)
    assert_test(golden=golden, metrics=SINGLE_TURN_TRACE_METRICS)
