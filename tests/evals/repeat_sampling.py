"""Frozen DR-09 repeat campaigns; Agent and fixed-answer judge stay separate."""
from __future__ import annotations

import math
import statistics
import argparse
import copy
import json
import time
import uuid
from pathlib import Path
from typing import Mapping, Sequence

import ledger
import run_suite


def metric_entries(record: Mapping) -> list[dict]:
    """Read the public per-metric verdict shape, including partial errors."""
    judge = record.get("judge") or {}
    entries = judge.get("metrics")
    if not isinstance(entries, list):
        entries = (judge.get("details") or {}).get("metrics")
    return [dict(entry) for entry in (entries or []) if isinstance(entry, Mapping)]


def select_retests(records: Sequence[Mapping]) -> list[dict]:
    """Select from the first frozen observation, retaining all trigger reasons."""
    selected = []
    for record in records:
        case_id = record["case_id"]
        reasons = []
        if any(case_id == prefix or case_id.startswith(prefix + "-")
               for prefix in ("hard-03", "hard-04", "hard-06", "case-16")):
            reasons.append("preselected")
        if (record.get("behaviour") or {}).get("passed") is False:
            reasons.append("behaviour_failed")
        for entry in metric_entries(record):
            score = entry.get("score")
            if (entry.get("metric") in {"Task Resolution", "Grounding"}
                    and entry.get("applicability") == "applicable"
                    and isinstance(score, (int, float)) and not isinstance(score, bool)
                    and 0 <= score < 0.7):
                reasons.append(f"{entry['metric']} < 0.7")
        if reasons:
            selected.append({"case_id": case_id, "reasons": reasons})
    return selected


def distribution(rows: Sequence[Mapping]) -> dict:
    """Describe planned metric observations without replacing any failure.

    Each row represents one planned observation. ``not_applicable`` is a
    terminal observation with no score; missing and pending rows stay incomplete.
    Execution errors and quality failures have independent denominators.
    """
    counts = dict.fromkeys(
        ("planned", "attempted", "scored", "error", "skipped",
         "not_applicable", "not_started"), 0
    )
    counts["planned"] = len(rows)
    values = []
    incomplete = False
    for row in rows:
        status = row.get("status", "not_started")
        if status in {"not_started", "missing", "corrupt"}:
            counts["not_started"] += 1
            incomplete = True
            continue
        if status == "skipped":
            counts["skipped"] += 1
            incomplete = True
            continue
        counts["attempted"] += 1
        if row.get("applicability") == "not_applicable":
            counts["not_applicable"] += 1
            continue
        score = row.get("score")
        valid = (isinstance(score, (int, float)) and not isinstance(score, bool)
                 and math.isfinite(score) and 0 <= score <= 1)
        if row.get("error") or status in {"error", "agent_error", "judge_error"}:
            counts["error"] += 1
            incomplete = True
        elif valid and status == "scored":
            counts["scored"] += 1
            values.append(float(score))
        else:
            incomplete = True
    n = len(values)
    failures = sum(score < 0.5 for score in values)
    return {
        **counts, "n": n, "values": values,
        "mean": statistics.mean(values) if n else None,
        "sample_variance": statistics.variance(values) if n >= 2 else None,
        "variance_reason": None if n >= 2 else "n < 2; sample variance requires two scored observations",
        "min": min(values) if n else None, "max": max(values) if n else None,
        "scoring_failures": failures,
        "scoring_failure_rate": failures / counts["scored"] if counts["scored"] else None,
        "execution_error_rate": counts["error"] / counts["attempted"] if counts["attempted"] else None,
        "unstable": bool(failures), "incomplete": incomplete,
    }


def _read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _checked_snapshot(directory, manifest, key):
    descriptor = manifest["snapshots"][key]
    path = directory / descriptor["file"]
    if ledger.sha256_file(path) != descriptor["sha256"]:
        raise ValueError(f"frozen {key} snapshot digest changed")
    return _read(path)


def _expected_metrics(item):
    expected = item.get("expected_metrics")
    if isinstance(expected, Mapping) and expected:
        return dict(expected)
    if not run_suite._is_v2_metadata(item.get("metadata")):
        return None
    try:
        import metrics
        return metrics.expected_metric_applicability(item.get("metadata") or {})
    except Exception:
        return None


def run_campaign(baseline_dir, out, *, judge, base_url=None, password=None,
                 chat_timeout_s=None):
    """Freeze first observations, then run two Agent and two fixed-answer repeats.

    The baseline observation counts as sample zero in each group. The new
    Agent sessions are independent; fixed-answer repeats read the byte-identical
    first response from durable storage and never invoke chat.
    """
    source = ledger.RunLedger.open(baseline_dir)
    if source.scan()["incomplete"] or not source.manifest.get("run", {}).get("baseline"):
        raise ValueError("repeat campaign requires a complete twenty-case baseline")
    planned = source.manifest["planned"]
    if len(planned) != 20 or len({item["case_id"] for item in planned}) != 20:
        raise ValueError("repeat campaign requires exactly twenty independent baseline cases")
    environment = _read(source.run_dir / "environment.json")
    if ledger.sha256_file(source.run_dir / "environment.json") != source.manifest["environment_sha256"]:
        raise ValueError("baseline environment digest changed")
    records = [source.read_sample(item["sample_id"]) for item in planned]
    selection = select_retests(records)
    fn, judge_name = run_suite.load_judge(judge)
    frozen_rubric = environment.get("configuration", {}).get("rubric")
    if frozen_rubric != run_suite.rubric_snapshot():
        raise ValueError("repeat rubric differs from the frozen baseline")
    baseline_run = source.manifest.get("run", {})
    baseline_base_url = baseline_run.get("base_url")
    if base_url is not None and ledger.safe_url(base_url) != baseline_base_url:
        raise ValueError("repeat base URL differs from the frozen baseline")
    active_base_url = baseline_base_url or base_url
    baseline_timeout = baseline_run.get("chat_timeout_s")
    if chat_timeout_s is not None:
        if not isinstance(baseline_timeout, (int, float)) or float(chat_timeout_s) != float(baseline_timeout):
            raise ValueError("repeat chat timeout differs from the frozen baseline")
    timeout_s = baseline_timeout
    scrubber = ledger.SecretScrubber.from_environment()
    configuration_fn = getattr(fn, "configuration", None)
    if not callable(configuration_fn):
        configuration_fn = getattr(fn, "__globals__", {}).get("configuration")
    judge_configuration = (run_suite._scrubbed_json(configuration_fn(), scrubber)
                           if callable(configuration_fn) else None)
    baseline_configuration = environment.get("configuration", {}).get("judge_configuration")
    configuration_comparison = "unknown"
    baseline_has_config = isinstance(baseline_configuration, Mapping)
    current_has_config = isinstance(judge_configuration, Mapping)
    if baseline_has_config != current_has_config:
        raise ValueError("repeat judge configuration availability differs from baseline")
    if baseline_has_config:
        if dict(baseline_configuration) != dict(judge_configuration):
            raise ValueError("repeat judge configuration differs from baseline")
        configuration_comparison = "verified"
    baseline_judge = baseline_run.get("judge")
    if baseline_judge and baseline_judge != judge_name:
        raise ValueError("repeat judge differs from baseline")
    baseline_models = environment.get("configuration", {}).get("models")
    model_comparison = "unknown"
    if isinstance(baseline_models, Mapping):
        if dict(baseline_models) != run_suite.model_snapshot():
            raise ValueError("repeat model configuration differs from baseline")
        model_comparison = "verified"
    baseline_budgets = environment.get("configuration", {}).get("budgets")
    budget_comparison = "unknown"
    if isinstance(baseline_budgets, Mapping):
        current_judge_budgets = run_suite.judge_budget_snapshot()
        if {key: baseline_budgets.get(key) for key in current_judge_budgets} != current_judge_budgets:
            raise ValueError("repeat judge budget differs from baseline")
        budget_comparison = "verified"
    baseline_capabilities = environment.get("configuration", {}).get("capabilities") or {}
    current_capabilities = run_suite.capability_snapshot()
    capability_comparison = "unknown"
    if isinstance(baseline_capabilities, Mapping):
        baseline_rerank = baseline_capabilities.get("rerank") or {}
        current_rerank = current_capabilities.get("rerank") or {}
        if isinstance(baseline_rerank, Mapping) and isinstance(current_rerank, Mapping):
            for key in ("status", "counted_as_pass"):
                if baseline_rerank.get(key) != current_rerank.get(key):
                    raise ValueError("repeat capabilities differ from baseline")
            capability_comparison = "verified"
    repeat_environment = ledger.build_environment_snapshot(
        suite_version="dr-09.1", base_url=active_base_url,
        budgets={"samples_per_group": 3, "new_agent_samples_per_case": 2,
                 "new_fixed_judge_samples_per_case": 2, "chat_timeout_s": timeout_s},
        configuration={"rubric": frozen_rubric, "judge": judge_name,
            "judge_configuration": judge_configuration,
            "judge_configuration_comparison": configuration_comparison,
            "model_comparison": model_comparison,
            "judge_budget_comparison": budget_comparison,
            "capability_comparison": capability_comparison,
            "dataset_sha256": source.manifest["dataset"]["sha256"],
            "baseline_manifest_sha256": source.manifest_digest,
            "cache": {"reading": "disabled", "writing": "disabled", "enabled": False},
            "capabilities": current_capabilities})
    destination = Path(out).resolve()
    destination.mkdir(parents=True, exist_ok=False)
    baseline = {"manifest": source.manifest, "environment": environment,
                "records": records, "source": str(source.run_dir),
                "source_manifest_sha256": source.manifest_digest}
    snapshots = {}
    for name, content in (("baseline", baseline), ("environment", repeat_environment)):
        path = destination / f"{name}.json"
        snapshots[name] = {"file": path.name, "sha256": ledger._atomic_write(path, content)}
    selected_ids = {item["case_id"] for item in selection}
    repeat_plan = []
    for item in planned:
        if item["case_id"] in selected_ids:
            for group in ("independent_agent", "fixed_answer_judge"):
                for index in (1, 2):
                    repeat_plan.append({**item, "sample_id": f"{group}-{item['case_id']}-s{index}",
                                        "sample_index": index, "group": group})
    observed = ledger.RunLedger.create(destination / "observations", planned=repeat_plan,
        manifest={"ticket": "DR-09", "judge": judge_name}, environment=repeat_environment)
    manifest = {"ticket": "DR-09", "schema": "repeat-campaign", "frozen": True,
                "created_at": ledger.utc_now(), "selection": selection, "snapshots": snapshots,
                "observations": str(observed.run_dir.relative_to(destination)),
                "observations_manifest_sha256": observed.manifest_digest,
                "groups": {name: {"samples_per_case": 3, "baseline_index": 0}
                           for name in ("independent_agent", "fixed_answer_judge")},
                "judge": judge_name, "planned": repeat_plan}
    ledger._atomic_write(destination / "manifest.json", manifest)
    baseline_by_case = {record["case_id"]: record for record in records}
    client = run_suite.ChatClient(active_base_url, timeout_s=timeout_s,
        password=password, scrubber=scrubber)
    for item in repeat_plan:
        if item["group"] == "independent_agent":
            session = str(uuid.uuid4())
            body = {"message": item["input"], "stream": False, "sessionId": session}
            if item.get("scope") is not None:
                body["knowledgeBaseIds"] = item["scope"]
            try:
                client.ensure_login()
                result = client.chat(item["input"], session, item["scope"])
                if not isinstance(result["payload"].get("reply"), str) or not result["payload"]["reply"].strip():
                    raise run_suite.ChatError("chat backend returned an empty reply")
                record = run_suite._agent_record(item, session, ledger.safe_url(client.base_url),
                    request_body=body, result=result)
            except run_suite.ChatError as exc:
                record = run_suite._agent_record(item, session, ledger.safe_url(client.base_url),
                    request_body=body, error=scrubber.scrub(exc))
        else:
            record = copy.deepcopy(baseline_by_case[item["case_id"]])
            record.update(sample_id=item["sample_id"], sample_index=item["sample_index"],
                          status="pending_judge", error=None,
                          judge={"status": "not_attempted", "score": None, "error": None})
        record["repeat_group"] = item["group"]
        stored = observed.write_sample(record)
        if stored["status"] == "agent_error":
            continue
        context = run_suite._judge_context(observed, item["sample_id"],
            metadata=item.get("metadata"), expected_output=item.get("expected_output"))
        started_at, started = ledger.utc_now(), time.monotonic()
        try:
            verdict = run_suite._judge_scored(fn(copy.deepcopy(stored), context), scrubber, judge_name)
            stored["status"] = "scored"
        except Exception as exc:
            verdict = {"status": "error", "score": None, "error": scrubber.scrub(exc),
                       "details": run_suite._scrubbed_json(getattr(exc, "details", {}), scrubber)}
            stored.update(status="judge_error", error=verdict["error"])
        verdict.update(started_at=started_at, finished_at=ledger.utc_now(),
                       duration_ms=int((time.monotonic() - started) * 1000))
        stored["judge"] = verdict
        observed.write_sample(stored)
    observed.finalize()
    return rebuild_campaign(destination)


def _metric_row(record, metric, metadata):
    if record is None:
        return {"status": "not_started"}
    entries = {entry.get("metric"): entry for entry in metric_entries(record)}
    entry = entries.get(metric)
    if entry is None:
        if metric == "Grounding" and metadata.get("kind") == "memory-not-cited":
            return {"status": record["status"], "applicability": "not_applicable"}
        return {"status": record["status"] if record["status"] != "scored" else "error",
                "error": record.get("error") or "missing metric result"}
    if (entry.get("score") is None and not entry.get("error")
            and entry.get("applicability") != "not_applicable"):
        # The judge preallocates all metric rows with attempted=True. A later
        # row with no score/termination/HTTP attempt did not run after an
        # earlier metric failed; do not count that placeholder as attempted.
        return {**entry, "status": "not_started"}
    return {**entry, "status": "error" if entry.get("error") else "scored"}


def _rebuild_campaign(out):
    """Recompute all statistics from the frozen first responses and raw repeats."""
    directory = Path(out).resolve()
    manifest = _read(directory / "manifest.json")
    baseline = _checked_snapshot(directory, manifest, "baseline")
    environment = _checked_snapshot(directory, manifest, "environment")
    observed = ledger.RunLedger.open(directory / manifest["observations"])
    if observed.manifest_digest != manifest["observations_manifest_sha256"]:
        raise ValueError("frozen observations manifest digest changed")
    if ledger.sha256_file(observed.run_dir / "environment.json") != observed.manifest["environment_sha256"]:
        raise ValueError("frozen observations environment digest changed")
    originals = {record["case_id"]: record for record in baseline["records"]}
    metadata = {item["case_id"]: item["metadata"] for item in baseline["manifest"]["planned"]}
    groups = {}
    incomplete = False
    product_failed = False
    plan_by_case = {item["case_id"]: item for item in baseline["manifest"]["planned"]}
    for group in manifest["groups"]:
        cases = {}
        for choice in manifest["selection"]:
            case_id = choice["case_id"]
            rows = [originals[case_id]]
            errors = []
            for item in manifest["planned"]:
                if item["group"] == group and item["case_id"] == case_id:
                    try:
                        record = observed.read_sample(item["sample_id"])
                        if group == "fixed_answer_judge" and record["agent"] != originals[case_id]["agent"]:
                            raise ValueError("fixed answer identity changed")
                        rows.append(record)
                    except (ledger.SampleReadError, ValueError) as exc:
                        rows.append(None)
                        errors.append(str(exc))
            expected_metrics = _expected_metrics(plan_by_case[case_id]) or {}
            metric_names = dict.fromkeys([*expected_metrics, "Task Resolution", "Grounding"] + [
                entry["metric"] for row in rows if row for entry in metric_entries(row)
                if isinstance(entry.get("metric"), str)])
            metric_integrity_errors = []
            for row in rows:
                if row is None or row.get("status") not in {"scored", "judge_error"}:
                    # Agent failures carry no judge rows; their own error and
                    # missing observation reasons keep the case incomplete.
                    continue
                entries = metric_entries(row)
                actual = {}
                for entry in entries:
                    name = entry.get("metric")
                    if not isinstance(name, str) or name in actual:
                        metric_integrity_errors.append("duplicate or invalid metric name")
                        continue
                    actual[name] = entry.get("applicability")
                if expected_metrics and actual != expected_metrics:
                    metric_integrity_errors.append("metric rows differ from frozen expected set")
            metrics = {name: distribution([_metric_row(row, name, metadata[case_id]) for row in rows])
                       for name in metric_names}
            failures = [{"sample_id": row["sample_id"], "verdict": row["behaviour"]}
                        for row in rows if row and (row.get("behaviour") or {}).get("passed") is False]
            missing = any(row is None or row["status"] != "scored" for row in rows)
            unstable = bool(failures) or any(value["unstable"] or value["error"] for value in metrics.values())
            cases[case_id] = {"selection_reasons": choice["reasons"], "metrics": metrics,
                "behaviour": {"failed_samples": failures}, "unstable": unstable,
                "incomplete": missing or bool(metric_integrity_errors) or any(value["incomplete"] for value in metrics.values()),
                "errors": errors + metric_integrity_errors, "samples": [
                    {"sample_id": row["sample_id"], "session_id": row.get("session_id"),
                     "answer_sha256": row["agent"].get("answer_sha256"),
                     "status": row["status"], "score": row["judge"].get("score")}
                    if row else {"status": "not_started"} for row in rows]}
            incomplete |= cases[case_id]["incomplete"]
            product_failed |= unstable
        groups[group] = {"cases": cases, "samples_per_case": 3}
    report = {"ticket": "DR-09", "manifest": str(directory / "manifest.json"),
        "baseline": baseline["source"], "groups": groups,
        "incomplete": incomplete,
        "product_gate": {"passed": not incomplete and not product_failed,
                         "deterministic_failures_preserved": True},
        "p0": {"status": "pending_evidence", "reason": "requires DR-01..08 evidence and live calibration"},
        "snapshots": {"config": environment.get("configuration", {}),
                      "environment": environment},
        "raw": {"baseline_snapshot": str(directory / "baseline.json"),
                "observation_ledger": str(observed.run_dir)}}
    ledger._atomic_write(directory / "report.json", report)
    return report


def rebuild_campaign(out):
    """Invalidate stale derived results if a frozen input cannot be verified."""
    directory = Path(out).resolve()
    try:
        return _rebuild_campaign(directory)
    except Exception as exc:
        if (directory / "manifest.json").is_file():
            ledger._atomic_write(directory / "report.json", {
                "ticket": "DR-09", "incomplete": True,
                "product_gate": {"passed": False},
                "p0": {"status": "blocked"},
                "error": ledger.redact_text(exc),
            })
        raise


def main(argv=None):
    parser = argparse.ArgumentParser(description="Freeze and run DR-09 Agent/fixed-answer judge repeats")
    parser.add_argument("--baseline")
    parser.add_argument("--out", required=True)
    parser.add_argument("--judge", default="judge_runtime:judge")
    parser.add_argument("--base-url")
    parser.add_argument("--timeout", type=float)
    parser.add_argument("--rebuild", action="store_true")
    args = parser.parse_args(argv)
    try:
        if args.rebuild:
            report = rebuild_campaign(args.out)
        else:
            if not args.baseline:
                parser.error("--baseline is required for a new campaign")
            report = run_campaign(args.baseline, args.out, judge=args.judge,
                                  base_url=args.base_url, chat_timeout_s=args.timeout)
        print(json.dumps({"report": str(Path(args.out).resolve() / "report.json"),
                          "incomplete": report["incomplete"], "product_gate": report["product_gate"]}))
        return 1 if report["incomplete"] else 0
    except Exception as exc:
        print(json.dumps({"incomplete": True, "error": ledger.redact_text(exc)}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
