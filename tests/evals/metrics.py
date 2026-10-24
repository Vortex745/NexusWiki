"""Shared DeepEval metric lists for the NexusRAG eval suite.

All metrics are Jev-native (JevEval): the judge is TypeSafe's jev model via
TYPESAFE_API_KEY, not an OpenAI-style LLM judge. No OpenAI metric
credentials are needed; the app backend itself still uses its own OPENAI_*
chat/embedding config at runtime.

Keep metric instances here, not inline in the eval test file, so the test
stays focused on app execution.
"""

from deepeval.metrics import JevEval
from deepeval.metrics.jev_eval import Choice, Noul, Score
from deepeval.test_case import SingleTurnParams

# Covers "did the assistant do what the gate case demands" — answer, refuse,
# or answer-without-citing-memory. EXPECTED_OUTPUT carries the gate's
# behavior rule; ACTUAL_OUTPUT is materialized from the traced app reply.
TASK_RESOLUTION = JevEval(
    name="Task Resolution",
    evaluation_params=[
        SingleTurnParams.INPUT,
        SingleTurnParams.ACTUAL_OUTPUT,
        SingleTurnParams.EXPECTED_OUTPUT,
    ],
    questions=[
        Noul(
            "The assistant's reply satisfies what the expected behavior "
            "requires for this input — an answer where one is required, or "
            "an honest refusal or handoff where the expected behavior allows it."
        ),
        Score(
            "How fully does the reply settle the input?",
            levels=[
                "Not addressed",
                "Partly settled",
                "Fully resolved or appropriately handed off",
            ],
            weight=2,
        ),
        Choice(
            "What best describes the reply?",
            options={
                "answered": 1.0,
                "correctly_refused_or_admitted_gap": 1.0,
                "asked_targeted_clarification": 0.7,
                "deflected": 0.2,
                "ignored_or_fabricated": 0.0,
            },
        ),
    ],
    threshold=0.5,
)

# Covers "is the reply grounded in what was actually retrieved". The bridge
# publishes the app's references as trace retrieval_context, so Jev compares
# the reply against evidence instead of guessing from the reply alone. The
# 'no_knowledge_needed' option keeps refusal and chit-chat cases out of a
# grounding judgment that does not apply to them.
GROUNDING = JevEval(
    name="Grounding",
    evaluation_params=[
        SingleTurnParams.INPUT,
        SingleTurnParams.ACTUAL_OUTPUT,
        SingleTurnParams.RETRIEVAL_CONTEXT,
    ],
    questions=[
        Noul(
            "The reply's factual claims (numbers, names, policies, "
            "procedures) are supported by the retrieval context."
        ),
        Choice(
            "How does the reply handle the limits of its knowledge?",
            options={
                "answers_from_evidence": 1.0,
                "admits_gap_or_refuses": 0.8,
                "hedges_without_answering": 0.4,
                "invents_details": 0.0,
                "no_knowledge_needed": None,
            },
            weight=2,
        ),
    ],
    threshold=0.5,
)

# Covers single-turn conduct: relevance and what the reply does with vague
# input. The 'input_was_clear' option keeps well-specified cases out of the
# clarification judgment.
RESPONSE_CONDUCT = JevEval(
    name="Response Conduct",
    evaluation_params=[
        SingleTurnParams.INPUT,
        SingleTurnParams.ACTUAL_OUTPUT,
    ],
    questions=[
        Noul(
            "The reply engages with the input request — answering, refusing "
            "with a reason, or asking a targeted clarification — rather than "
            "ignoring or deflecting it."
        ),
        Choice(
            "If the input was vague or underspecified, what did the reply do?",
            options={
                "asks_targeted_clarification": 1.0,
                "handed_off_or_refused_with_reason": 0.8,
                "states_a_safe_assumption": 0.6,
                "guesses_silently": 0.2,
                "ignores_the_ambiguity": 0.0,
                "input_was_clear": None,
            },
        ),
    ],
    threshold=0.5,
)

SINGLE_TURN_TRACE_METRICS = [
    TASK_RESOLUTION,
    GROUNDING,
    RESPONSE_CONDUCT,
]
