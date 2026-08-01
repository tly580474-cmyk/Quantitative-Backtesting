"""Fixed M4 cross-sectional calculator.

This worker accepts one JSON document on stdin or an orchestrator-owned input file and emits
one RebalancePlan on stdout or an output file.
It does not execute user code and intentionally has no cash, order, position or equity logic.
"""

from __future__ import annotations

import hashlib
import json
import sys
import os
import math
from datetime import date
from typing import Any


ENGINE_VERSION = "python-cross-sectional-v1"
MULTI_FACTOR_ENGINE_VERSION = "python-cross-sectional-composite-v1"


def apply_resource_limits() -> None:
    """Best-effort POSIX limits; Node still enforces timeout and output limits on every OS."""
    try:
        import resource
        memory_mb = max(128, int(os.environ.get("MULTI_ASSET_PYTHON_MAX_MEMORY_MB", "1024")))
        cpu_seconds = max(1, int(os.environ.get("MULTI_ASSET_PYTHON_MAX_CPU_SECONDS", "120")))
        resource.setrlimit(resource.RLIMIT_AS, (memory_mb * 1024 * 1024, memory_mb * 1024 * 1024))
        resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds))
        resource.setrlimit(resource.RLIMIT_NOFILE, (32, 32))
    except (ImportError, OSError, ValueError):
        pass


def canonical_hash(value: Any) -> str:
    payload = json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def period_key(value: str, frequency: str) -> str:
    parsed = date.fromisoformat(value)
    if frequency == "monthly":
        return f"{parsed.year:04d}-{parsed.month:02d}"
    iso_year, iso_week, _ = parsed.isocalendar()
    return f"{iso_year:04d}-{iso_week:02d}"


def is_member(row: dict[str, Any], decision_date: str) -> bool:
    return row["memberFrom"] <= decision_date and (
        row["memberTo"] is None or row["memberTo"] >= decision_date
    )


def cap_and_redistribute(weights: list[float], cap: float, gross: float) -> list[float]:
    output = [0.0 for _ in weights]
    open_indexes = set(range(len(weights)))
    remaining = gross
    while open_indexes and remaining > 1e-12:
        source_total = sum(weights[index] for index in open_indexes)
        capped = False
        for index in sorted(open_indexes):
            proposed = (
                remaining * weights[index] / source_total
                if source_total > 0
                else remaining / len(open_indexes)
            )
            if proposed >= cap - 1e-12:
                output[index] = cap
                remaining -= cap
                open_indexes.remove(index)
                capped = True
        if not capped:
            for index in open_indexes:
                output[index] = (
                    remaining * weights[index] / source_total
                    if source_total > 0
                    else remaining / len(open_indexes)
                )
            break
    return output


def target_weights(plan: dict[str, Any], selected: list[dict[str, Any]]) -> list[float]:
    portfolio = plan["portfolioPlan"]
    gross = min(portfolio["maxGrossExposure"], 1 - portfolio["minCashWeight"])
    cap = portfolio["maxSingleWeight"]
    if plan["signalPlan"]["weighting"] == "equal":
        weight = min(gross / len(selected), cap)
        return [weight for _ in selected]
    direction = "higher" if plan.get("factorPlan") else plan["featurePlan"]["direction"]
    values = [
        row["featureValue"] if direction == "higher" else -row["featureValue"]
        for row in selected
    ]
    floor = min(values)
    strengths = [value - floor + 1e-12 for value in values]
    total = sum(strengths)
    preliminary = [gross * value / total for value in strengths]
    return cap_and_redistribute(preliminary, cap, gross)


def quantile(values: list[float], percentile: float) -> float:
    ordered = sorted(values)
    position = (len(ordered) - 1) * percentile
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def percentile_rank(values: list[tuple[str, float]]) -> dict[str, float]:
    ordered = sorted(values, key=lambda item: (item[1], item[0]))
    output: dict[str, float] = {}
    start = 0
    while start < len(ordered):
        end = start
        while end + 1 < len(ordered) and ordered[end + 1][1] == ordered[start][1]:
            end += 1
        rank = 0.5 if len(ordered) == 1 else ((start + end) / 2) / (len(ordered) - 1)
        for index in range(start, end + 1):
            output[ordered[index][0]] = rank
        start = end + 1
    return output


def normalize_factor(
    source: list[dict[str, Any]], factor: dict[str, Any]
) -> dict[str, float]:
    raw = [(row["instrumentKey"], row.get("factorValues", {}).get(factor["factorId"])) for row in source]
    available = [value for _, value in raw if value is not None]
    if not available:
        return {}
    fill = quantile(available, 0.5)
    completed = [
        (key, value if value is not None else fill)
        for key, value in raw
        if value is not None or factor["missing"] == "cross_sectional_median"
    ]
    winsor = factor.get("winsorization")
    if winsor:
        low = quantile([value for _, value in completed], winsor["lower"])
        high = quantile([value for _, value in completed], winsor["upper"])
        completed = [(key, min(high, max(low, value))) for key, value in completed]
    directed = [
        (key, value if factor["direction"] == "higher" else -value)
        for key, value in completed
    ]
    if factor["normalization"] == "percentile":
        return percentile_rank(directed)
    mean = sum(value for _, value in directed) / len(directed)
    deviation = math.sqrt(sum((value - mean) ** 2 for _, value in directed) / len(directed))
    return {key: 0.0 if deviation == 0 else (value - mean) / deviation for key, value in directed}


def rank_multi_factor(plan: dict[str, Any], source: list[dict[str, Any]]) -> list[dict[str, Any]]:
    factor_plan = plan["factorPlan"]
    factors = sorted(factor_plan["factors"], key=lambda factor: factor["factorId"])
    raw_weights = [1.0 if factor_plan["weighting"] == "equal" else factor["weight"] for factor in factors]
    scale = sum(abs(weight) for weight in raw_weights)
    if scale <= 0:
        raise ValueError("MULTI_FACTOR_WEIGHT_SUM_ZERO")
    weights = [weight / scale for weight in raw_weights]
    normalized = {factor["factorId"]: normalize_factor(source, factor) for factor in factors}
    scored = []
    for row in source:
        key = row["instrumentKey"]
        if any(key not in normalized[factor["factorId"]] for factor in factors):
            continue
        vector = {factor["factorId"]: normalized[factor["factorId"]][key] for factor in factors}
        score = sum(vector[factor["factorId"]] * weights[index] for index, factor in enumerate(factors))
        scored.append({**row, "featureValue": score, "normalizedFactors": vector})
    return sorted(scored, key=lambda row: (-row["featureValue"], row["instrumentKey"]))


def generate(payload: dict[str, Any]) -> dict[str, Any]:
    if set(payload) != {"plan", "rows"}:
        raise ValueError("payload must contain only plan and rows")
    plan = payload["plan"]
    rows = payload["rows"]
    if not rows:
        raise ValueError("POINT_IN_TIME_FEATURE_ROWS_REQUIRED")

    dates_by_period: dict[str, str] = {}
    for row in rows:
        decision_date = row["decisionDate"]
        if is_member(row, decision_date) and row["featureValue"] is not None:
            key = period_key(decision_date, plan["rebalancePolicy"]["frequency"])
            dates_by_period[key] = max(dates_by_period.get(key, decision_date), decision_date)
    selected_dates = sorted(dates_by_period.values())
    if not selected_dates:
        raise ValueError("NO_ELIGIBLE_POINT_IN_TIME_FEATURE_ROWS")

    decisions: list[dict[str, Any]] = []
    for decision_date in selected_dates:
        source = [row for row in rows if row["decisionDate"] == decision_date and is_member(row, decision_date)]
        executable_dates = {row["executableFrom"] for row in source}
        if len(executable_dates) != 1:
            raise ValueError("INCONSISTENT_EXECUTABLE_DATE")
        eligible_universe = sorted({row["instrumentKey"] for row in source})
        if plan.get("factorPlan"):
            ranked = rank_multi_factor(plan, source)
            ranked_by_key = {row["instrumentKey"]: row for row in ranked}
            feature_evidence = []
            for row in sorted(source, key=lambda item: item["instrumentKey"]):
                composite = ranked_by_key.get(row["instrumentKey"])
                evidence = {
                    "instrumentKey": row["instrumentKey"],
                    "featureValue": composite["featureValue"] if composite else None,
                    "factorValues": row.get("factorValues", {}),
                }
                if composite:
                    evidence["normalizedFactors"] = composite["normalizedFactors"]
                    evidence["compositeScore"] = composite["featureValue"]
                evidence["evidenceHash"] = canonical_hash(evidence)
                feature_evidence.append(evidence)
        else:
            feature_evidence = sorted(
                [{"instrumentKey": row["instrumentKey"], "featureValue": row["featureValue"]} for row in source],
                key=lambda item: item["instrumentKey"],
            )
            ranked = [row for row in source if row["featureValue"] is not None]
            reverse = plan["featurePlan"]["direction"] == "higher"
            ranked.sort(key=lambda row: row["instrumentKey"])
            ranked.sort(key=lambda row: row["featureValue"], reverse=reverse)
        selected = ranked[: plan["signalPlan"]["topN"]]
        weights = target_weights(plan, selected)
        targets = [
            {
                "instrumentKey": row["instrumentKey"],
                "rank": index + 1,
                "score": row["featureValue"],
                "targetWeight": weights[index],
                "reasonCodes": ([
                    f'{factor["factorId"]}@{factor["factorVersion"]}'
                    for factor in sorted(plan["factorPlan"]["factors"], key=lambda item: item["factorId"])
                ] if plan.get("factorPlan") else [
                    f'{plan["featurePlan"]["featureId"]}@{plan["featurePlan"]["featureVersion"]}'
                ]) + [f"rank:{index + 1}"],
            }
            for index, row in enumerate(selected)
        ]
        decisions.append(
            {
                "decisionDate": decision_date,
                "executableFrom": next(iter(executable_dates)),
                "eligibleUniverse": eligible_universe,
                "universeHash": canonical_hash(
                    {"decisionDate": decision_date, "members": eligible_universe}
                ),
                "featureEvidence": feature_evidence,
                "featureHash": canonical_hash(feature_evidence),
                "targets": targets,
            }
        )

    output = {
        "protocolVersion": "1.1" if plan.get("factorPlan") else "1.0",
        "snapshotId": plan["snapshotId"],
        "featureEngineVersion": MULTI_FACTOR_ENGINE_VERSION if plan.get("factorPlan") else ENGINE_VERSION,
        "sourcePlanHash": canonical_hash(plan),
        "decisions": decisions,
    }
    output["planHash"] = canonical_hash(output)
    return output


def main() -> int:
    try:
        apply_resource_limits()
        input_stream = open(sys.argv[1], "r", encoding="utf-8") if len(sys.argv) >= 2 else sys.stdin
        output_stream = open(sys.argv[2], "w", encoding="utf-8") if len(sys.argv) >= 3 else sys.stdout
        payload = json.load(input_stream)
        result = generate(payload)
        json.dump(result, output_stream, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        output_stream.write("\n")
        if input_stream is not sys.stdin:
            input_stream.close()
        if output_stream is not sys.stdout:
            output_stream.close()
        return 0
    except Exception as error:  # fixed worker boundary: one structured error line
        sys.stderr.write(f"{type(error).__name__}: {error}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
