"""Deterministic v2 answer/citation/refusal/memory contracts (DR-03).

Seam: ``tests/evals/contracts.py``, the same checks the eval hook runs after
the real HTTP reply and BEFORE any judge. The release gate
(``scripts/release-quality-gate.ts``) applies the same standard. The shared
``fixtures/normalization.json`` is the independent source of truth for both
languages.

No judge, network or model call is made here.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

EVAL_DIR = Path(__file__).resolve().parent
REPO_ROOT = EVAL_DIR.parent.parent
sys.path.insert(0, str(EVAL_DIR))

import contracts  # noqa: E402  (path inserted above)

FIXTURE_PATH = EVAL_DIR / "fixtures" / "normalization.json"
DATASET_PATH = EVAL_DIR / ".dataset.json"
V2_PATH = REPO_ROOT / "golden" / "demo-release-cases.v2.json"


def _read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


FIXTURE = _read_json(FIXTURE_PATH)
DATASET = _read_json(DATASET_PATH)
V2 = _read_json(V2_PATH)
GOLDENS = {golden["name"]: golden for golden in DATASET}
V2_CASES = {case["id"]: case for case in V2["cases"]}


def meta(gate_id: str) -> dict:
    return dict(GOLDENS[gate_id]["additional_metadata"])


def reference(
    ref_id: str = "ev_test",
    *,
    content: str | None = None,
    excerpt: str = "",
    title: str = "",
) -> dict:
    item = {"id": ref_id, "excerpt": excerpt, "title": title}
    if content is not None:
        item["content"] = content
    return item


def chat_result(reply: str, status: str = "completed", references=None) -> dict:
    return {
        "reply": reply,
        "status": status,
        "references": list(references or []),
    }


def synthetic_case(
    *,
    kind: str = "answer",
    points=None,
    prohibited=None,
    forbidden: str | None = None,
    scope=None,
    contract_version: int = 2,
    case_id: str = "synthetic-case",
) -> dict:
    case = {
        "gate_id": case_id,
        "kind": kind,
        "hard": False,
        "prohibited_assertions": list(prohibited or []),
        "contract_version": contract_version,
    }
    if points is not None:
        case["answer_points"] = list(points)
    if forbidden is not None:
        case["forbidden_reference_content"] = forbidden
    if scope is not None:
        case["scope"] = list(scope)
    return case


def answer_reply(points, *, cite: str = "ev_test") -> str:
    return f"{'；'.join(points)} [cite:{cite}]"


def assert_failure(verdict: dict, fragment: str) -> None:
    assert verdict["passed"] is False, verdict
    assert any(fragment in failure for failure in verdict["failures"]), verdict


# --- DR-03-AC01: shared normalization fixture -----------------------------


def test_the_shared_fixture_is_versioned_and_paired() -> None:
    assert FIXTURE["schema"] == "eval-normalization-examples"
    assert FIXTURE["version"] == 1
    assert len(FIXTURE["normalize"]) >= 10
    assert len(FIXTURE["contains"]) >= 10
    assert any("数字" in item["name"] or "digits" in item["name"] for item in FIXTURE["normalize"])
    assert any("unit" in item["name"] for item in FIXTURE["normalize"])
    assert any("negation" in item["name"] for item in FIXTURE["normalize"])


def test_python_normalization_matches_the_shared_fixture() -> None:
    for item in FIXTURE["normalize"]:
        assert contracts.normalize(item["input"]) == item["expected"], item["name"]


def test_python_containment_matches_the_shared_fixture() -> None:
    for item in FIXTURE["contains"]:
        assert (
            contracts.contains_normalized(item["haystack"], item["needle"])
            is item["expected"]
        ), item["name"]


def test_numbers_units_and_negation_survive_normalization() -> None:
    assert contracts.normalize("３０ 个自然日") == "30 个自然日"
    assert contracts.normalize("24 小时") == "24 小时"
    assert contracts.normalize("不影响") == "不影响"
    assert contracts.normalize("不会精排") == "不会精排"
    assert not contracts.contains_normalized("30 个工作日", "30 个自然日")
    assert not contracts.contains_normalized("会影响功能", "不影响")


# --- DR-03-AC05: the v2 standard reaches every answer case -----------------


def test_goldens_carry_the_v2_standard_for_every_answer_case() -> None:
    answer_goldens = [
        golden
        for golden in DATASET
        if golden["additional_metadata"]["kind"] == "answer"
    ]
    assert len(answer_goldens) == 15
    assert len(DATASET) == 20
    for golden in DATASET:
        meta_ = golden["additional_metadata"]
        source = V2_CASES[golden["name"]]
        assert meta_["contract_version"] == 2, golden["name"]
        assert meta_["kind"] == source["kind"], golden["name"]
        assert meta_["scope"] == source["knowledgeBaseIds"], golden["name"]
        assert meta_["prohibited_assertions"] == (
            source.get("prohibitedAssertions") or []
        ), golden["name"]
        if source.get("forbiddenReferenceContent") is not None:
            assert (
                meta_["forbidden_reference_content"]
                == source["forbiddenReferenceContent"]
            ), golden["name"]
    for golden in answer_goldens:
        meta_ = golden["additional_metadata"]
        source = V2_CASES[golden["name"]]
        assert meta_["answer_points"] == source["answerPoints"], golden["name"]

    hard04 = meta("hard-04-faq-exact-answer")
    assert hard04["answer_points"] == ["30 个自然日"]


def test_all_15_answer_cases_are_actually_judged() -> None:
    answer_goldens = [
        golden
        for golden in DATASET
        if golden["additional_metadata"]["kind"] == "answer"
    ]
    assert len(answer_goldens) == 15
    for golden in answer_goldens:
        meta_ = golden["additional_metadata"]
        points = meta_["answer_points"]
        positive = contracts.evaluate_case(
            meta_,
            chat_result(
                answer_reply(points), references=[reference("ev_test")]
            ),
        )
        assert positive["passed"] is True, (golden["name"], positive)
        assert positive["checks"]["answer_points"]["passed"] is True
        assert str(len(points)) in positive["checks"]["answer_points"]["detail"]

        dropped = (
            answer_reply(points[:-1])
            if len(points) > 1
            else "复述了相关内容但没有给出标准要点 [cite:ev_test]"
        )
        negative = contracts.evaluate_case(
            meta_,
            chat_result(dropped, references=[reference("ev_test")]),
        )
        assert negative["passed"] is False, golden["name"]
        assert any(
            "missing answer point" in failure for failure in negative["failures"]
        ), (golden["name"], negative)


# --- DR-03-AC02: paired answer samples ------------------------------------


def test_missing_point_wrong_number_wrong_unit_and_negation_are_rejected() -> None:
    meta_ = synthetic_case(points=["30 个自然日", "7 个工作日"])
    good = (
        "标准商品自签收之日起 30 个自然日内可申请退货，"
        "退款在验收后 7 个工作日内原路退回 [cite:ev_test]。"
    )
    assert contracts.evaluate_case(
        meta_, chat_result(good, references=[reference("ev_test")])
    )["passed"] is True

    missing = "标准商品自签收之日起 30 个自然日内可申请退货 [cite:ev_test]。"
    assert_failure(
        contracts.evaluate_case(
            meta_, chat_result(missing, references=[reference("ev_test")])
        ),
        "missing answer point",
    )

    wrong_number = "标准商品自签收之日起 31 个自然日内可申请退货，退款 7 个工作日内原路退回 [cite:ev_test]。"
    assert_failure(
        contracts.evaluate_case(
            meta_, chat_result(wrong_number, references=[reference("ev_test")])
        ),
        "missing answer point",
    )

    wrong_unit = "标准商品自签收之日起 30 个工作日内可申请退货，退款 7 个工作日内原路退回 [cite:ev_test]。"
    assert_failure(
        contracts.evaluate_case(
            meta_, chat_result(wrong_unit, references=[reference("ev_test")])
        ),
        "missing answer point",
    )

    negation_meta = synthetic_case(points=["不影响"])
    affirmative = "未配置 Langfuse 会影响功能 [cite:ev_test]。"
    assert_failure(
        contracts.evaluate_case(
            negation_meta,
            chat_result(affirmative, references=[reference("ev_test")]),
        ),
        "missing answer point",
    )
    negated = "未配置 Langfuse 不影响任何功能 [cite:ev_test]。"
    assert contracts.evaluate_case(
        negation_meta, chat_result(negated, references=[reference("ev_test")])
    )["passed"] is True


def test_hard_04_requires_30_natural_days_and_a_resolving_inline_citation() -> None:
    meta_ = meta("hard-04-faq-exact-answer")

    good = (
        "标准商品自签收之日起 30 个自然日内可申请退货 [cite:ev_faq]。"
    )
    assert contracts.evaluate_case(
        meta_, chat_result(good, references=[reference("ev_faq")])
    )["passed"] is True

    # The live FAQ path returns the versioned standard answer but no inline
    # citation: DR-03 must expose that defect, not excuse it.
    live_shaped = "标准商品自签收之日起 30 个自然日内可申请退货（演示标准答案，引用虚构政策文档）。"
    verdict = contracts.evaluate_case(
        meta_,
        chat_result(
            live_shaped,
            references=[
                reference(
                    "ev_faq",
                    title="FAQ：退货期限是多久？",
                    excerpt="标准答案：标准商品自签收之日起 30 个自然日内可申请退货。",
                )
            ],
        ),
    )
    assert_failure(verdict, "no inline [cite:<id>]")

    wrong_unit = "标准商品自签收之日起 30 个工作日内可申请退货 [cite:ev_faq]。"
    assert_failure(
        contracts.evaluate_case(
            meta_, chat_result(wrong_unit, references=[reference("ev_faq")])
        ),
        "missing answer point",
    )


def test_case_10_reviewed_inference_is_rejected_and_correct_sample_passes() -> None:
    meta_ = meta("case-10-fusion-rerank")

    correct = (
        "四路结果经 RRF 融合后，如配置了专用重排模型则再做一次精排 "
        "[cite:ev_rerank]。文档未说明未配置时的行为，故此处不作推断。"
    )
    assert contracts.evaluate_case(
        meta_, chat_result(correct, references=[reference("ev_rerank")])
    )["passed"] is True

    for assertion in V2_CASES["case-10-fusion-rerank"]["prohibitedAssertions"]:
        bad = f"四路结果融合后还会精排 [cite:ev_rerank]。{assertion}。"
        verdict = contracts.evaluate_case(
            meta_, chat_result(bad, references=[reference("ev_rerank")])
        )
        assert_failure(verdict, "prohibited assertion")


def test_inline_citations_must_be_exact_and_resolve() -> None:
    meta_ = synthetic_case(points=["精排"])
    refs = [reference("ev_1")]

    assert contracts.evaluate_case(
        meta_, chat_result("精排 [cite:ev_1]", references=refs)
    )["passed"] is True

    assert_failure(
        contracts.evaluate_case(
            meta_, chat_result("精排 [cite:ev_missing]", references=refs)
        ),
        "not in the returned references",
    )
    assert_failure(
        contracts.evaluate_case(
            meta_, chat_result("精排 [cite: ev_1]", references=refs)
        ),
        "malformed inline citation",
    )
    assert_failure(
        contracts.evaluate_case(meta_, chat_result("精排 [cite:]", references=refs)),
        "malformed inline citation",
    )
    assert_failure(
        contracts.evaluate_case(meta_, chat_result("精排", references=refs)),
        "no inline [cite:<id>]",
    )
    # A references list alone does not satisfy the v2 inline-citation rule.
    assert_failure(
        contracts.evaluate_case(
            meta_,
            chat_result("精排（见右侧参考资料）", references=refs),
        ),
        "no inline [cite:<id>]",
    )


def test_forbidden_reference_content_is_checked_for_answers_too() -> None:
    meta_ = synthetic_case(points=["精排"], forbidden="演示记忆")
    verdict = contracts.evaluate_case(
        meta_,
        chat_result(
            "精排 [cite:ev_1]",
            references=[reference("ev_1", excerpt="演示记忆：这一段不得成为引用")],
        ),
    )
    assert_failure(verdict, "forbidden reference content")


# --- DR-03-AC04: refusal, coverage gap and clarification -------------------


def test_a_marker_refusal_passes_every_refuse_case() -> None:
    for gate_id in (
        "hard-01-isolation-policy-blocked",
        "hard-02-isolation-project-blocked",
        "hard-03-empty-scope-refuse",
        "hard-05-no-fabrication",
    ):
        verdict = contracts.evaluate_case(
            meta(gate_id),
            chat_result("未找到相关证据，无法回答该问题。"),
        )
        assert verdict["passed"] is True, (gate_id, verdict)


def test_generic_clarification_does_not_pass_hard_05() -> None:
    meta_ = meta("hard-05-no-fabrication")
    assert meta_["scope"], "hard-05 is a non-empty-scope, clearly answerable case"

    verdict = contracts.evaluate_case(
        meta_,
        chat_result(
            "请提供更多信息：您指的是哪家公司，或在哪个交易所上市？",
            status="clarification_required",
        ),
    )
    assert_failure(verdict, "clarification-only")

    # A clarification-terminal run is not a refusal even when it also uses a
    # soft refusal phrase.
    assert_failure(
        contracts.evaluate_case(
            meta_,
            chat_result(
                "无法回答，请提供更多信息后我再继续。",
                status="clarification_required",
            ),
        ),
        "clarification-only",
    )

    # A clarification phrase with a completed status is the same failure.
    assert_failure(
        contracts.evaluate_case(
            meta_,
            chat_result(
                "请补充公司全称，我才能继续。",
                status="completed",
            ),
        ),
        "clarification-only",
    )

    # An honest coverage-gap refusal is not a clarification.
    assert contracts.evaluate_case(
        meta_,
        chat_result("知识库中没有该公司股票代码的信息，无法回答。"),
    )["passed"] is True


def test_a_fabricated_answer_does_not_pass_a_refusal_case() -> None:
    assert_failure(
        contracts.evaluate_case(
            meta("hard-05-no-fabrication"),
            chat_result("公司的股票代码是 600000。", status="completed"),
        ),
        "expected an honest refusal",
    )


def test_empty_scope_forbids_references_and_inline_citations() -> None:
    meta_ = meta("hard-03-empty-scope-refuse")
    assert meta_["scope"] == []

    assert contracts.evaluate_case(
        meta_, chat_result("未找到相关证据，无法回答。", references=[])
    )["passed"] is True

    assert_failure(
        contracts.evaluate_case(
            meta_,
            chat_result(
                "未找到相关证据，无法回答。",
                references=[reference("ev_test")],
            ),
        ),
        "explicit empty scope",
    )
    assert_failure(
        contracts.evaluate_case(
            meta_,
            chat_result("未找到相关证据 [cite:ev_test]。", references=[]),
        ),
        "explicit empty scope",
    )


def test_non_empty_scope_allows_a_refusal_with_a_returned_reference() -> None:
    assert contracts.evaluate_case(
        meta("hard-01-isolation-policy-blocked"),
        chat_result(
            "未找到相关证据，无法回答。",
            references=[reference("ev_other_base")],
        ),
    )["passed"] is True


def test_a_relaxed_status_alone_still_requires_gap_evidence() -> None:
    # provider_error/cancelled are execution outcomes, not honest refusals.
    assert_failure(
        contracts.evaluate_case(
            meta("hard-05-no-fabrication"),
            chat_result("模型服务暂时不可用。", status="provider_error"),
        ),
        "expected an honest refusal",
    )
    assert contracts.evaluate_case(
        meta("hard-05-no-fabrication"),
        chat_result("知识库中没有相关信息。", status="insufficient_retrieval"),
    )["passed"] is True


# --- memory-not-cited -----------------------------------------------------


def test_memory_content_in_references_fails_but_owner_viewing_passes() -> None:
    meta_ = meta("hard-06-memory-never-cited")

    assert_failure(
        contracts.evaluate_case(
            meta_,
            chat_result(
                "提醒如下。",
                references=[
                    reference(
                        "ev_memory",
                        excerpt="演示记忆：本演示的知识库包含虚构政策文档。",
                    )
                ],
            ),
        ),
        "long-term memory content appeared in the references",
    )

    # The owner may view their own memory; no citation is required.
    viewing = chat_result(
        "你的长期记忆里记录的是：演示记忆：本演示的知识库包含虚构政策文档。",
        references=[],
    )
    assert contracts.evaluate_case(meta_, viewing)["passed"] is True

    handoff = chat_result("已为你转人工处理。", references=[])
    assert contracts.evaluate_case(meta_, handoff)["passed"] is True


# --- fail-closed contracts ------------------------------------------------


def test_answer_case_without_non_empty_points_fails_closed() -> None:
    for points in (None, [], ["   "]):
        case = synthetic_case(points=None)
        if points is not None:
            case["answer_points"] = points
        verdict = contracts.evaluate_case(
            case, chat_result("任何回答 [cite:ev_test]", references=[reference()])
        )
        assert_failure(verdict, "requires non-empty answer_points")


def test_unknown_kind_wrong_version_and_bad_scope_fail_closed() -> None:
    unknown = synthetic_case(kind="chat", points=["要点"])
    assert_failure(
        contracts.evaluate_case(unknown, chat_result("要点 [cite:ev_test]")),
        "unknown kind",
    )

    wrong_version = synthetic_case(points=["要点"], contract_version=1)
    assert_failure(
        contracts.evaluate_case(wrong_version, chat_result("要点 [cite:ev_test]")),
        "contract_version",
    )

    bad_scope = synthetic_case(kind="refuse", scope=None)
    bad_scope["scope"] = "kb-demo-project"
    assert_failure(
        contracts.evaluate_case(
            bad_scope, chat_result("未找到相关证据，无法回答。")
        ),
        "scope must be an array",
    )


def test_malformed_result_and_memory_case_inputs_fail_closed() -> None:
    answer = synthetic_case(points=["要点"])
    assert_failure(
        contracts.evaluate_case(answer, {"reply": None, "references": []}),
        "reply must be a string",
    )
    assert_failure(
        contracts.evaluate_case(
            answer, {"reply": "要点 [cite:ev_test]", "references": "none"}
        ),
        "references must be an array",
    )
    memory = synthetic_case(kind="memory-not-cited")
    assert_failure(
        contracts.evaluate_case(memory, chat_result("好的。")),
        "requires forbidden_reference_content",
    )


def test_malformed_prohibited_or_forbidden_metadata_fails_closed() -> None:
    malformed_prohibited = synthetic_case(points=["要点"])
    malformed_prohibited["prohibited_assertions"] = "未配置重排因此不会精排"
    assert_failure(
        contracts.evaluate_case(
            malformed_prohibited,
            chat_result("要点 [cite:ev_test]", references=[reference()]),
        ),
        "prohibited_assertions must be an array",
    )

    malformed_forbidden = synthetic_case(points=["要点"])
    malformed_forbidden["forbidden_reference_content"] = 123
    assert_failure(
        contracts.evaluate_case(
            malformed_forbidden,
            chat_result("要点 [cite:ev_test]", references=[reference()]),
        ),
        "forbidden_reference_content must be a non-empty string",
    )


# --- DR-03-AC05: persistence and pre-judge ordering ------------------------


def test_deterministic_result_is_persisted_and_readable_without_a_judge(
    tmp_path: Path,
) -> None:
    meta_ = synthetic_case(points=["30 个自然日"])
    result = chat_result(
        "标准商品 30 个工作日内可退货 [cite:ev_test]",
        references=[reference("ev_test")],
    )
    verdict, path = contracts.evaluate_and_record(meta_, result, tmp_path)
    assert verdict["passed"] is False
    assert path.name == "synthetic-case.deterministic.json"

    # The judge is unavailable (or errors): the deterministic result is
    # already on disk and readable.
    with pytest.raises(RuntimeError, match="judge unavailable"):
        raise RuntimeError("judge unavailable")
    loaded = contracts.load_case_result(tmp_path, "synthetic-case")
    assert loaded == verdict
    assert loaded["passed"] is False

    # Re-evaluating the same input is byte-stable.
    again = contracts.write_case_result(
        contracts.evaluate_case(meta_, result), tmp_path
    )
    assert again.read_bytes() == path.read_bytes()


def test_a_high_judge_score_cannot_erase_a_deterministic_failure(
    tmp_path: Path,
) -> None:
    verdict, _ = contracts.evaluate_and_record(
        synthetic_case(points=["30 个自然日"]),
        chat_result("30 个工作日 [cite:ev_test]", references=[reference()]),
        tmp_path,
    )
    judge_score = 1.0
    assert judge_score == 1.0
    with pytest.raises(contracts.DeterministicContractFailure):
        contracts.require_passed(verdict)
    assert contracts.load_case_result(tmp_path, "synthetic-case")["passed"] is False


def test_eval_hook_runs_the_deterministic_gate_before_the_judge() -> None:
    source = (EVAL_DIR / "test_nexusrag.py").read_text(encoding="utf-8")
    assert "EVAL_DETERMINISTIC_DIR" in source
    assert "evaluate_and_record" in source
    assert source.index("evaluate_and_record") < source.index("assert_test(")
    assert source.index("run_traced_ai_app") < source.index("evaluate_and_record")
