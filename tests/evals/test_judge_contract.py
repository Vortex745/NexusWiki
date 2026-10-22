"""Per-case judge contract: explicit questions, applicability and isolation (DR-06).

The real 20-case v2 dataset is the source of the answer points, refusal
rules and memory metadata. Jev itself is replaced by a controlled, offline
``DeepEvalBaseSystemOneModel`` that answers each question from the rubric
text plus the test-case state; there is no online calibration claim here
(DR-07 owns live calibration). What is proven:

  * every answer plan asks for answer-point coverage, contradiction with the
    standard answer and conclusions the cited evidence does not support, and
    the real answer points appear in those questions
  * pure memory views mark document Grounding ``not_applicable`` without
    fabricating a retrieval_context; document-fact answers still run it
  * sequential and interleaved/concurrent cases never share metric state, and
    a previous case's score, reason or error cannot change a later case
  * invention is judged by source support: "虚构"/"演示数据" in the source or
    reply is not by itself ``invents_details``; an unsupported claim is
  * a full controlled run through ``run_suite`` emits per-case, per-metric
    applicability/score/reason, with the bounded cited-evidence scope stated
"""

from __future__ import annotations

import copy
import hashlib
import json
import re
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

EVAL_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(EVAL_DIR))

import judge_runtime  # noqa: E402
import metrics  # noqa: E402
import run_suite  # noqa: E402
from test_ledger import read_json, stub_backend, write_dataset  # noqa: E402

from deepeval.models.base_model import DeepEvalBaseSystemOneModel  # noqa: E402
from deepeval.models.system_one.schema import (  # noqa: E402
    ChoiceAnswer,
    ChoiceQuestion,
    NoulAnswer,
    NoulQuestion,
    ScoreAnswer,
    ScoreQuestion,
    SystemOneAnswers,
)

DATASET = json.loads((EVAL_DIR / ".dataset.json").read_text(encoding="utf-8"))
CASES = {golden["name"]: golden for golden in DATASET}

REFUSAL_MARKERS = (
    "未找到相关证据",
    "无法回答",
    "无法生成可靠回答",
    "证据不足",
    "未能找到",
)
GENERIC_CLARIFICATION_MARKERS = (
    "请提供更多",
    "请补充",
    "请说明",
    "请明确",
    "能否提供",
    "需要更多信息",
    "请问您想",
)
TARGETED_CLARIFICATION_MARKERS = ("请提供工号", "请提供订单号")
DEFLECTION_MARKERS = ("自己查", "不清楚，去问")

CLAIM_TOKEN = re.compile(
    r"\d+(?:\.\d+)?\s*(?:个自然日|个工作日|个?天|个?月|周|小时|分钟|%|元)"
)
UNSUPPORTED_CONCLUSIONS = ("未配置重排因此不会精排", "因此不会精排", "所以不会精排")


def golden_metadata(name: str) -> dict:
    return copy.deepcopy(CASES[name]["additional_metadata"])


def answer_points(expected_output: str) -> list[str]:
    marker = "标准答案要点（须全部出现）："
    if marker not in expected_output:
        return []
    tail = expected_output.split(marker, 1)[1]
    points = []
    for chunk in tail.split("禁止断言", 1)[0].split("。"):
        chunk = chunk.strip()
        if chunk:
            points.append(chunk)
    return points


def _is_refusal(reply: str) -> bool:
    return any(marker in reply for marker in REFUSAL_MARKERS)


def _is_generic_clarification(reply: str) -> bool:
    return any(marker in reply for marker in GENERIC_CLARIFICATION_MARKERS)


def _is_targeted_clarification(reply: str) -> bool:
    return any(marker in reply for marker in TARGETED_CLARIFICATION_MARKERS)


def _unsupported_claims(reply: str, evidence: str) -> bool:
    return any(token not in evidence for token in CLAIM_TOKEN.findall(reply))


def _unsupported_conclusion(reply: str, evidence: str) -> bool:
    return any(
        marker in reply and marker not in evidence
        for marker in UNSUPPORTED_CONCLUSIONS
    )


def _contradicts_points(reply: str, points: list[str]) -> bool:
    for point in points:
        if point in reply:
            continue
        number = re.match(r"[\d.]+", point)
        if number is None:
            continue
        if number.group(0) in reply:
            return True
        # Same unit family, different value: "30 个自然日" vs "45 天".
        if "自然日" in point and re.search(r"\d+(?:\.\d+)?\s*天", reply):
            return True
    return False


class ControlledJev(DeepEvalBaseSystemOneModel):
    """An offline fake Jev that applies the rubric text to the test case.

    It is deliberately mechanical: it reads the actual reply, the expected
    output (standard answer points) and the cited-evidence excerpts, and
    returns calibrated-style probabilities. It exists to prove the judge
    wiring, applicability and isolation contracts, not to be a calibration.
    """

    def __init__(
        self,
        recorder: list | None = None,
        barrier: threading.Barrier | None = None,
        fail: bool = False,
    ) -> None:
        self.name = "controlled-jev"
        self.model = None
        self._recorder = recorder
        self._barrier = barrier
        self._fail = fail

    def load_model(self, *args, **kwargs):  # noqa: D401 - base class hook
        return None

    def get_model_name(self, *args, **kwargs) -> str:
        return "controlled-jev (offline)"

    def decide(self, state, questions):
        if self._recorder is not None:
            self._recorder.append(copy.deepcopy(state))
        if self._barrier is not None:
            self._barrier.wait(timeout=15)
        if self._fail:
            raise RuntimeError("controlled judge outage")

        test_case = state.get("test_case", {})
        reply = str(test_case.get("actual_output") or "")
        expected = str(test_case.get("expected_output") or "")
        retrieval = test_case.get("retrieval_context") or []
        if isinstance(retrieval, str):
            retrieval = [retrieval]
        evidence = "\n".join(str(item) for item in retrieval)
        points = answer_points(expected)

        answers = SystemOneAnswers()
        for key, question in questions.items():
            if isinstance(question, NoulQuestion):
                answers.nouls[key] = NoulAnswer(
                    probability=self._noul(
                        str(question.instructions), reply, evidence, points
                    )
                )
            elif isinstance(question, ChoiceQuestion):
                chosen = self._choice(question, reply, evidence)
                answers.choices[key] = ChoiceAnswer(
                    choice=chosen,
                    probabilities={chosen: 1.0},
                    confidence=1.0,
                )
            elif isinstance(question, ScoreQuestion):
                index = self._score_index(
                    str(question.instructions), reply, points, len(question.levels)
                )
                answers.scores[key] = ScoreAnswer(
                    score=float(index),
                    probabilities={index: 1.0},
                    confidence=1.0,
                )
        return answers, None

    async def a_decide(self, state, questions):
        return self.decide(state, questions)

    # -- rubric emulation ------------------------------------------------
    @staticmethod
    def _noul(instructions: str, reply: str, evidence: str, points: list[str]) -> float:
        if instructions.startswith(metrics.COVERAGE_QUESTION_PREFIX):
            return 1.0 if points and all(point in reply for point in points) else 0.0
        if instructions.startswith(metrics.CONTRADICTION_QUESTION_PREFIX):
            return 0.0 if _contradicts_points(reply, points) else 1.0
        if instructions.startswith(metrics.UNSUPPORTED_QUESTION_PREFIX):
            return (
                0.0
                if _unsupported_conclusion(reply, evidence)
                or _unsupported_claims(reply, evidence)
                else 1.0
            )
        if instructions.startswith(metrics.REFUSAL_QUESTION_PREFIX):
            return 1.0 if _is_refusal(reply) else 0.0
        if instructions.startswith(metrics.MEMORY_QUESTION_PREFIX):
            return 1.0 if "记忆" in reply else 0.0
        return 1.0

    @staticmethod
    def _choice(question: ChoiceQuestion, reply: str, evidence: str):
        options = question.options
        if "invents_details" in options:
            if _unsupported_claims(reply, evidence) or _unsupported_conclusion(
                reply, evidence
            ):
                return "invents_details"
            if not evidence.strip() and _is_refusal(reply):
                return "admits_gap_or_refuses"
            return "answers_from_evidence"
        if "generic_clarification_for_a_clear_question" in options:
            if _is_targeted_clarification(reply):
                return "asked_targeted_clarification_for_missing_parameters"
            if _is_generic_clarification(reply):
                return "generic_clarification_for_a_clear_question"
            if _is_refusal(reply):
                return "answered_or_refused_with_source_support"
            if any(marker in reply for marker in DEFLECTION_MARKERS):
                return "deflected_or_ignored"
            return "answered_or_refused_with_source_support"
        if "correctly_refused_or_admitted_gap" in options:
            if _is_refusal(reply):
                return "correctly_refused_or_admitted_gap"
            if _is_generic_clarification(reply):
                return "generic_clarification_for_a_clear_question"
            if _is_targeted_clarification(reply):
                return "asked_targeted_clarification_for_missing_parameters"
            return "answered"
        return next(iter(options))

    @staticmethod
    def _score_index(instructions: str, reply: str, points: list[str], levels: int) -> int:
        top = levels - 1
        if "standard answer point" in instructions:
            if not points:
                return top
            covered = sum(1 for point in points if point in reply)
            return 0 if covered == 0 else (top if covered == len(points) else top // 2)
        if "settle" in instructions:
            if _is_generic_clarification(reply) and not _is_refusal(reply):
                return top // 2
            return top
        return top


def make_record(
    case_id: str,
    question: str,
    answer: str,
    metadata: dict,
    expected: str,
    references: list[dict] | None = None,
) -> dict:
    return {
        "sample_id": f"{case_id}-s0",
        "case_id": case_id,
        "sample_index": 0,
        "status": "pending_judge",
        "agent": {
            "answer": answer,
            "references": list(references or []),
            "request": {"message": question},
        },
        "planned": {
            "input_sha256": hashlib.sha256(question.encode("utf-8")).hexdigest(),
            "scope": metadata.get("scope"),
            "metadata": copy.deepcopy(metadata),
            "expected_output": expected,
        },
    }


def make_judge(
    *,
    recorder: list | None = None,
    barrier: threading.Barrier | None = None,
    fail_first: bool = False,
):
    lock = threading.Lock()
    state = {"calls": 0, "failed": False}
    local = threading.local()

    def factory():
        with lock:
            state["calls"] += 1
            fail = fail_first and not state["failed"]
            if fail:
                state["failed"] = True
        # Only the first metric of each case waits on the barrier, so two
        # cases enter their first judgement at the same time.
        first_in_thread = not getattr(local, "seen", False)
        local.seen = True
        return ControlledJev(
            recorder=recorder,
            barrier=barrier if first_in_thread else None,
            fail=fail,
        )

    return judge_runtime.Judge(model_factory=factory)


def metric_entry(result: dict, name: str) -> dict:
    return next(item for item in result["metrics"] if item["metric"] == name)


# ---------------------------------------------------------------------------
# Explicit questions and real answer points
# ---------------------------------------------------------------------------


def test_every_answer_case_plan_asks_coverage_contradiction_and_unsupported() -> None:
    answer_names = [name for name, golden in CASES.items()
                    if golden["additional_metadata"]["kind"] == "answer"]
    assert len(answer_names) == 15

    for name in answer_names:
        metadata = golden_metadata(name)
        plan = metrics.build_case_metrics(metadata, case_id=name)
        described = plan.describe()["metrics"]["Task Resolution"]
        assert described["applicability"] == "applicable"
        texts = [question["text"] for question in described["questions"]]
        joined = "\n".join(texts)

        assert any(text.startswith(metrics.COVERAGE_QUESTION_PREFIX) for text in texts)
        assert any(
            text.startswith(metrics.CONTRADICTION_QUESTION_PREFIX) for text in texts
        )
        assert any(
            text.startswith(metrics.UNSUPPORTED_QUESTION_PREFIX) for text in texts
        )
        points = metadata["answer_points"]
        assert points, name
        for point in points:
            assert point in joined, (name, point)
        assert plan.metrics and all(
            metric.threshold == metrics.DEFAULT_THRESHOLD for metric in plan.metrics
        )

    # The case-specific prohibition is an explicit question target, not a
    # generic warning.
    case_10 = metrics.build_case_metrics(
        golden_metadata("case-10-fusion-rerank"), case_id="case-10-fusion-rerank"
    )
    unsupported = next(
        question["text"]
        for question in case_10.describe()["metrics"]["Task Resolution"]["questions"]
        if question["text"].startswith(metrics.UNSUPPORTED_QUESTION_PREFIX)
    )
    assert "未配置重排因此不会精排" in unsupported


def test_plan_digest_is_stable_and_tracks_answer_point_changes() -> None:
    metadata = golden_metadata("hard-04-faq-exact-answer")
    first = metrics.build_case_metrics(metadata, case_id="hard-04-faq-exact-answer")
    second = metrics.build_case_metrics(metadata, case_id="hard-04-faq-exact-answer")
    assert first.rubric_version == second.rubric_version == metrics.RUBRIC_VERSION
    assert first.rubric_digest == second.rubric_digest == metrics.rubric_digest()
    assert first.plan_digest == second.plan_digest

    changed = copy.deepcopy(metadata)
    changed["answer_points"] = ["30 个工作日"]
    third = metrics.build_case_metrics(changed, case_id="hard-04-faq-exact-answer")
    assert third.plan_digest != first.plan_digest


def test_rubric_states_bounded_cited_evidence_not_full_generation_context() -> None:
    for text in (metrics.EVIDENCE_SCOPE, run_suite.EVIDENCE_SCOPE):
        assert "cited-evidence" in text
        assert "not the full generation context" in text
        assert "bounded" in text
    plan = metrics.build_case_metrics(
        golden_metadata("hard-04-faq-exact-answer"),
        case_id="hard-04-faq-exact-answer",
    )
    grounding_text = "\n".join(
        question["text"]
        for question in plan.describe()["metrics"]["Grounding"]["questions"]
    )
    assert "cited-evidence" in grounding_text
    assert "not the full generation context" in grounding_text


# ---------------------------------------------------------------------------
# Applicability: memory-only vs document facts
# ---------------------------------------------------------------------------


def test_memory_view_marks_document_grounding_not_applicable() -> None:
    plan = metrics.build_case_metrics(
        golden_metadata("hard-06-memory-never-cited"),
        case_id="hard-06-memory-never-cited",
    )
    described = plan.describe()["metrics"]
    assert described["Grounding"]["applicability"] == "not_applicable"
    assert described["Grounding"]["questions"] == []
    assert described["Grounding"]["reason"].startswith("owner memory view")
    assert plan.applicability_map()["Grounding"] == "not_applicable"
    assert all(metric.name != "Grounding" for metric in plan.metrics)


def test_document_fact_answer_still_runs_grounding() -> None:
    plan = metrics.build_case_metrics(
        golden_metadata("hard-04-faq-exact-answer"),
        case_id="hard-04-faq-exact-answer",
    )
    assert plan.applicability_map()["Grounding"] == "applicable"
    assert any(metric.name == "Grounding" for metric in plan.metrics)


def test_memory_case_judge_never_sends_fabricated_retrieval_context() -> None:
    metadata = golden_metadata("hard-06-memory-never-cited")
    question = CASES["hard-06-memory-never-cited"]["input"]
    expected = CASES["hard-06-memory-never-cited"]["expected_output"]
    recorder: list[dict] = []
    judge = make_judge(recorder=recorder)

    result = judge(
        make_record(
            "hard-06-memory-never-cited",
            question,
            "你让我记住的是：演示记忆显示周五发布。",
            metadata,
            expected,
            references=[],
        ),
        {},
    )

    ground = metric_entry(result, "Grounding")
    assert ground["applicability"] == "not_applicable"
    assert ground["score"] is None and ground["error"] is None
    assert ground["reason"]
    assert all("retrieval_context" not in state["test_case"] for state in recorder)
    assert result["applicability"]["Grounding"]["status"] == "not_applicable"


# ---------------------------------------------------------------------------
# Isolation
# ---------------------------------------------------------------------------


def _answer_record(case_id: str, reply: str, *, references=None) -> dict:
    golden = CASES[case_id]
    return make_record(
        case_id,
        golden["input"],
        reply,
        golden_metadata(case_id),
        golden["expected_output"],
        references=references
        or [
            {
                "id": "faq-1",
                "title": "退货政策 FAQ",
                "excerpt": "退货期限为 30 个自然日。",
            }
        ],
    )


CORRECT_REPLY = "退货期限为 30 个自然日 [cite:faq-1]。"
WRONG_REPLY = "退货期限为 45 天，从签收日开始计算。"


def test_fresh_metric_instances_per_case() -> None:
    first = metrics.build_case_metrics(
        golden_metadata("hard-04-faq-exact-answer"), case_id="hard-04-faq-exact-answer"
    )
    second = metrics.build_case_metrics(
        golden_metadata("hard-04-faq-exact-answer"), case_id="hard-04-faq-exact-answer"
    )
    assert [id(metric) for metric in first.metrics] != [
        id(metric) for metric in second.metrics
    ]
    for left, right in zip(first.metrics, second.metrics):
        assert left is not right


def test_sequential_cases_have_isolated_metric_state() -> None:
    judge = make_judge()
    first = judge(_answer_record("hard-04-faq-exact-answer", WRONG_REPLY), {})
    snapshot = copy.deepcopy(first)
    second = judge(_answer_record("hard-04-faq-exact-answer", CORRECT_REPLY), {})

    assert first == snapshot
    assert first["score"] < metrics.DEFAULT_THRESHOLD
    assert second["score"] >= metrics.DEFAULT_THRESHOLD
    assert second["reason"] != first["reason"]
    second_ground = metric_entry(second, "Grounding")
    assert second_ground["score"] >= metrics.DEFAULT_THRESHOLD
    assert all(item["score"] is not None for item in second["metrics"]
               if item["applicability"] == "applicable")


def test_interleaved_concurrent_cases_have_isolated_metric_state() -> None:
    barrier = threading.Barrier(2, timeout=30)
    judge = make_judge(barrier=barrier)
    right = _answer_record("hard-04-faq-exact-answer", CORRECT_REPLY)
    left = _answer_record("case-16-policy-expense", "住宿标准为每晚 999 元。", references=[
        {"id": "policy-1", "title": "差旅政策", "excerpt": "住宿标准为每晚 600 元。"}
    ])

    with ThreadPoolExecutor(max_workers=2) as pool:
        correct_future = pool.submit(judge, right, {})
        wrong_future = pool.submit(judge, left, {})
        correct = correct_future.result(timeout=60)
        wrong = wrong_future.result(timeout=60)

    assert correct["score"] >= metrics.DEFAULT_THRESHOLD
    assert wrong["score"] < metrics.DEFAULT_THRESHOLD
    assert "30 个自然日" not in wrong["reason"]
    assert "999 元" not in correct["reason"]
    # Replaying the same cases sequentially gives the same verdicts: the
    # interleaving did not leak state between the two metric sets.
    replay_judge = make_judge()
    replay_correct = replay_judge(right, {})
    replay_wrong = replay_judge(left, {})
    assert replay_correct["score"] == pytest.approx(correct["score"])
    assert replay_wrong["score"] == pytest.approx(wrong["score"])
    assert replay_correct["reason"] == correct["reason"]
    assert replay_wrong["reason"] == wrong["reason"]


def test_previous_case_error_does_not_change_a_later_case() -> None:
    judge = make_judge(fail_first=True)
    with pytest.raises(judge_runtime.JudgeFailure) as failure:
        judge(_answer_record("hard-04-faq-exact-answer", CORRECT_REPLY), {})
    details = failure.value.details
    assert details["metrics"][0]["error"]
    assert details["metrics"][0]["applicability"] == "applicable"

    later = judge(_answer_record("hard-04-faq-exact-answer", CORRECT_REPLY), {})
    assert later["score"] >= metrics.DEFAULT_THRESHOLD
    assert all(item["error"] is None for item in later["metrics"])


# ---------------------------------------------------------------------------
# Invention: source-support relationship, not trigger words
# ---------------------------------------------------------------------------


def _fiction_record(reply: str) -> dict:
    metadata = golden_metadata("hard-04-faq-exact-answer")
    return make_record(
        "hard-04-faq-exact-answer",
        CASES["hard-04-faq-exact-answer"]["input"],
        reply,
        metadata,
        CASES["hard-04-faq-exact-answer"]["expected_output"],
        references=[
            {
                "id": "faq-1",
                "title": "退货政策 FAQ",
                "excerpt": "引用虚构政策文档：退货期限为 30 个自然日。",
            }
        ],
    )


def test_fictional_demo_wording_is_not_invention_but_unsupported_claim_is() -> None:
    judge = make_judge()
    supported = "引用虚构政策文档中的条款，退货期限为 30 个自然日 [cite:faq-1]。"
    result = judge(_fiction_record(supported), {})
    ground = metric_entry(result, "Grounding")
    choice = next(
        item for item in ground["breakdown"] if item["type"] == "choice"
    )
    assert choice["probabilities"]["invents_details"] == 0.0
    assert choice["probabilities"]["answers_from_evidence"] == 1.0
    assert result["score"] >= metrics.DEFAULT_THRESHOLD

    fabricated = "引用虚构政策文档中的条款，退货期限为 45 个自然日 [cite:faq-1]。"
    bad = judge(_fiction_record(fabricated), {})
    bad_ground = metric_entry(bad, "Grounding")
    bad_choice = next(
        item for item in bad_ground["breakdown"] if item["type"] == "choice"
    )
    assert bad_choice["probabilities"]["invents_details"] == 1.0
    assert bad["score"] < metrics.DEFAULT_THRESHOLD


# ---------------------------------------------------------------------------
# Refusal conduct: generic clarification is not a correct refusal
# ---------------------------------------------------------------------------


def test_generic_clarification_is_not_a_correct_refusal_and_targeted_is_its_own_rule() -> None:
    metadata = golden_metadata("hard-05-no-fabrication")
    golden = CASES["hard-05-no-fabrication"]
    judge = make_judge()

    def run(reply: str) -> dict:
        return judge(
            make_record(
                "hard-05-no-fabrication",
                golden["input"],
                reply,
                metadata,
                golden["expected_output"],
                references=[],
            ),
            {},
        )

    refused = run("根据现有知识库未找到相关证据，无法回答该问题。")
    generic = run("请问您想了解哪方面的信息？")
    targeted = run("请提供工号，我才能为你查询。")

    refused_task = metric_entry(refused, "Task Resolution")
    generic_task = metric_entry(generic, "Task Resolution")
    targeted_task = metric_entry(targeted, "Task Resolution")

    generic_choice = next(
        item for item in generic_task["breakdown"] if item["type"] == "choice"
    )
    targeted_choice = next(
        item for item in targeted_task["breakdown"] if item["type"] == "choice"
    )
    assert generic_choice["probabilities"]["generic_clarification_for_a_clear_question"] == 1.0
    assert targeted_choice["probabilities"][
        "asked_targeted_clarification_for_missing_parameters"
    ] == 1.0
    assert generic_task["score"] < refused_task["score"]
    assert generic_task["score"] < targeted_task["score"]


# ---------------------------------------------------------------------------
# Full controlled run through run_suite
# ---------------------------------------------------------------------------


def test_controlled_run_emits_per_case_metrics_applicability_and_reasons(
    tmp_path: Path,
) -> None:
    selected = [
        "hard-04-faq-exact-answer",
        "hard-05-no-fabrication",
        "hard-06-memory-never-cited",
    ]
    dataset = write_dataset(
        tmp_path / "dataset.json", [CASES[name] for name in selected]
    )
    replies = {
        CASES["hard-04-faq-exact-answer"]["input"]:
            "退货期限为 30 个自然日 [cite:faq-1]。",
        CASES["hard-05-no-fabrication"]["input"]:
            "根据现有知识库未找到相关证据，无法回答该问题。",
        CASES["hard-06-memory-never-cited"]["input"]:
            "你让我记住的是：演示记忆显示周五发布。",
    }
    references = {
        CASES["hard-04-faq-exact-answer"]["input"]: [
            {"id": "faq-1", "title": "退货政策 FAQ",
             "excerpt": "退货期限为 30 个自然日。"}
        ],
        CASES["hard-05-no-fabrication"]["input"]: [],
        CASES["hard-06-memory-never-cited"]["input"]: [],
    }
    judge = make_judge()

    with stub_backend(replies, references=references) as backend:
        outcome = run_suite.execute_run(
            tmp_path / "runs",
            dataset_path=dataset,
            judge=judge,
            base_url=backend.base_url,
            password="stub-password",
        )

    assert outcome.exit_code == 0, outcome.error
    assert outcome.incomplete is False
    payload = outcome.public_payload()
    assert payload["scored"] == 3
    assert payload["rubric"]["version"] == metrics.RUBRIC_VERSION
    assert payload["rubric"]["digest"] == metrics.rubric_digest()
    assert "cited-evidence" in payload["evidence_scope"]

    by_case: dict[str, list[dict]] = {}
    for item in payload["metrics"]:
        by_case.setdefault(item["case_id"], []).append(item)
    assert set(by_case) == set(selected)
    for case_id, entries in by_case.items():
        assert {item["metric"] for item in entries} == {
            "Task Resolution",
            "Grounding",
            "Response Conduct",
        }, case_id
        assert all(item["reason"] for item in entries), case_id

    memory_ground = next(
        item for item in by_case["hard-06-memory-never-cited"]
        if item["metric"] == "Grounding"
    )
    assert memory_ground["applicability"] == "not_applicable"
    assert memory_ground["score"] is None
    assert memory_ground["error"] is None

    answer_ground = next(
        item for item in by_case["hard-04-faq-exact-answer"]
        if item["metric"] == "Grounding"
    )
    assert answer_ground["applicability"] == "applicable"
    assert answer_ground["score"] >= metrics.DEFAULT_THRESHOLD

    refuse_entries = by_case["hard-05-no-fabrication"]
    assert all(item["applicability"] == "applicable" for item in refuse_entries)

    environment = read_json(outcome.run_dir / "environment.json")
    assert "cited-evidence" in json.dumps(environment, ensure_ascii=False)
    assert "not the full generation context" in json.dumps(environment, ensure_ascii=False)
