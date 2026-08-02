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


def round_cross_runtime(value: float) -> float:
    # Match ECMAScript Math.round (ties move toward +infinity), including negatives.
    return math.floor(value * 100_000_000 + 0.5) / 100_000_000


def round_optimizer(value: float) -> float:
    return math.floor(value * 10_000_000_000 + 0.5) / 10_000_000_000


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
        rank = round_cross_runtime(0.5 if len(ordered) == 1 else ((start + end) / 2) / (len(ordered) - 1))
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
    return {key: round_cross_runtime(0.0 if deviation == 0 else (value - mean) / deviation)
            for key, value in directed}


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
        score = round_cross_runtime(sum(
            vector[factor["factorId"]] * weights[index] for index, factor in enumerate(factors)
        ))
        scored.append({**row, "featureValue": score, "normalizedFactors": vector})
    return sorted(scored, key=lambda row: (-row["featureValue"], row["instrumentKey"]))


def optimizer_turnover(weights: list[float], previous: list[float]) -> float:
    return sum(abs(weight - previous[index]) for index, weight in enumerate(weights))


def optimizer_exposure(
    candidates: list[dict[str, Any]], weights: list[float]
) -> dict[str, float]:
    result: dict[str, float] = {}
    for index, candidate in enumerate(candidates):
        code = candidate["industryCode"] or "UNKNOWN"
        result[code] = result.get(code, 0.0) + weights[index]
    return result


def optimizer_benchmark_exposure(
    candidates: list[dict[str, Any]], gross: float
) -> dict[str, float]:
    counts: dict[str, int] = {}
    for candidate in candidates:
        code = candidate["industryCode"] or "UNKNOWN"
        counts[code] = counts.get(code, 0) + 1
    return {code: gross * count / len(candidates) for code, count in counts.items()}


def industry_deviation_margin(
    actual: dict[str, float], benchmark: dict[str, float], maximum: float | None
) -> float:
    if maximum is None:
        return 1.0
    codes = set(actual) | set(benchmark)
    largest = max([0.0] + [abs(actual.get(code, 0.0) - benchmark.get(code, 0.0)) for code in codes])
    return maximum - largest


def optimizer_cap_and_redistribute(weights: list[float], cap: float, gross: float) -> list[float]:
    if not weights:
        return []
    output = [max(0.0, weight) for weight in weights]
    for _ in range(len(weights) + 2):
        total = sum(output)
        if total <= 0:
            output = [gross / len(output) for _ in output]
        else:
            output = [weight * gross / total for weight in output]
        excess = sum(max(0.0, weight - cap) for weight in output)
        output = [min(cap, weight) for weight in output]
        if excess <= 1e-12:
            break
        open_indexes = [index for index, weight in enumerate(output) if weight < cap - 1e-12]
        room = sum(cap - output[index] for index in open_indexes)
        if room <= 0:
            break
        for index in open_indexes:
            output[index] += excess * (cap - output[index]) / room
    return output


def optimizer_floor_cap_and_redistribute(
    weights: list[float], floor: float, cap: float, gross: float
) -> list[float]:
    if floor <= 0:
        return optimizer_cap_and_redistribute(weights, cap, gross)
    residual_gross = gross - floor * len(weights)
    if residual_gross < -1e-12:
        return list(weights)
    residual = optimizer_cap_and_redistribute(
        [max(0.0, weight - floor) for weight in weights], cap - floor, max(0.0, residual_gross)
    )
    return [weight + floor for weight in residual]


def neutralize_industries(
    candidates: list[dict[str, Any]], input_weights: list[float], gross: float,
    spec: dict[str, Any], cap: float
) -> tuple[list[float], int, list[str]]:
    weights = list(input_weights)
    benchmark = optimizer_benchmark_exposure(candidates, gross)
    groups: dict[str, list[int]] = {}
    for index, candidate in enumerate(candidates):
        code = candidate["industryCode"] or "UNKNOWN"
        groups.setdefault(code, []).append(index)
    if not spec["allowUnknown"] and "UNKNOWN" in groups:
        return weights, 0, ["UNKNOWN_INDUSTRY_NOT_ALLOWED"]
    tolerance = spec["solverTolerance"]
    absolute_bounds = spec.get("absoluteBounds", {})
    bounds: dict[str, dict[str, float]] = {}
    for code, indexes in groups.items():
        absolute = absolute_bounds.get(code, {})
        minimum = max(0.0, benchmark.get(code, 0.0) - spec["maxActiveDeviation"], absolute.get("min", 0.0))
        maximum = min(gross, benchmark.get(code, 0.0) + spec["maxActiveDeviation"], absolute.get("max", gross))
        bounds[code] = {"minimum": minimum, "maximum": maximum}
        if minimum > maximum + tolerance:
            return weights, 0, [f"INDUSTRY_BOUND_CONFLICT:{code}"]
        if len(indexes) * cap + tolerance < minimum:
            return weights, 0, [f"INDUSTRY_LOWER_BOUND_INFEASIBLE:{code}"]
    if (sum(bound["minimum"] for bound in bounds.values()) > gross + tolerance or
            sum(bound["maximum"] for bound in bounds.values()) + tolerance < gross):
        return weights, 0, ["INDUSTRY_AGGREGATE_BOUNDS_INFEASIBLE"]
    iterations = 0
    for iterations in range(spec["maxIterations"]):
        current = optimizer_exposure(candidates, weights)
        changed = False
        for code, indexes in groups.items():
            upper = bounds[code]["maximum"]
            value = current.get(code, 0.0)
            if value <= upper + tolerance:
                continue
            scale = upper / value
            for index in indexes:
                weights[index] *= scale
            changed = True
        after_upper = optimizer_exposure(candidates, weights)
        for code, indexes in groups.items():
            deficit = bounds[code]["minimum"] - after_upper.get(code, 0.0)
            if deficit <= tolerance:
                continue
            receiving_room = sum(max(0.0, cap - weights[index]) for index in indexes)
            cash_available = max(0.0, gross - sum(weights))
            transfer_required = max(0.0, deficit - cash_available)
            donors: list[dict[str, float | int]] = []
            for donor_code, donor_indexes in groups.items():
                if donor_code == code:
                    continue
                removable = max(0.0, after_upper.get(donor_code, 0.0) - bounds[donor_code]["minimum"])
                donor_total = sum(weights[index] for index in donor_indexes)
                donors.extend({"index": index, "room": removable * weights[index] / donor_total if donor_total > 0 else 0.0}
                              for index in donor_indexes)
            donor_room = sum(float(donor["room"]) for donor in donors)
            if receiving_room + tolerance < deficit or donor_room + tolerance < transfer_required:
                return weights, iterations, [f"INDUSTRY_LOWER_BOUND_INFEASIBLE:{code}"]
            if transfer_required > 0:
                for donor in donors:
                    index = int(donor["index"])
                    weights[index] -= transfer_required * float(donor["room"]) / donor_room
            for index in indexes:
                weights[index] += deficit * max(0.0, cap - weights[index]) / receiving_room
            changed = True
        remaining = gross - sum(weights)
        if remaining > tolerance:
            room = [max(0.0, cap - weight) for weight in weights]
            room_total = sum(room)
            if room_total + tolerance < remaining:
                return weights, iterations, ["INDUSTRY_REDISTRIBUTION_INFEASIBLE"]
            weights = [weight + remaining * room[index] / room_total for index, weight in enumerate(weights)]
            changed = True
        margin = industry_deviation_margin(
            optimizer_exposure(candidates, weights), benchmark, spec["maxActiveDeviation"]
        )
        projected = optimizer_exposure(candidates, weights)
        absolute_satisfied = all(
            projected.get(code, 0.0) >= bound["minimum"] - tolerance and
            projected.get(code, 0.0) <= bound["maximum"] + tolerance
            for code, bound in bounds.items()
        )
        if not changed or (margin >= -tolerance and absolute_satisfied):
            break
    margin = industry_deviation_margin(
        optimizer_exposure(candidates, weights), benchmark, spec["maxActiveDeviation"]
    )
    final_exposure = optimizer_exposure(candidates, weights)
    absolute_violation = any(
        final_exposure.get(code, 0.0) < bound["minimum"] - tolerance or
        final_exposure.get(code, 0.0) > bound["maximum"] + tolerance
        for code, bound in bounds.items()
    )
    return (weights, iterations, []) if margin >= -tolerance and not absolute_violation else (
        weights, iterations, ["INDUSTRY_NEUTRALITY_NOT_CONVERGED"]
    )


def solve_optimizer(
    plan: dict[str, Any], decision_date: str, selected: list[dict[str, Any]],
    source_by_key: dict[str, dict[str, Any]], previous_weights: dict[str, float]
) -> dict[str, Any]:
    spec = plan["optimizerSpec"]
    candidates = sorted(
        [{
            "instrumentKey": row["instrumentKey"],
            "expectedReturn": row["featureValue"],
            "riskProxy": source_by_key[row["instrumentKey"]].get("riskProxy", 0.0),
            "previousWeight": previous_weights.get(row["instrumentKey"], 0.0),
            "industryCode": source_by_key[row["instrumentKey"]].get("industryEvidence", {}).get("level1Code"),
        } for row in selected],
        key=lambda item: (-item["expectedReturn"], item["instrumentKey"]),
    )[:spec["maxHoldings"]]
    portfolio = plan["portfolioPlan"]
    gross = min(portfolio["maxGrossExposure"], 1 - portfolio["minCashWeight"])
    cap = portfolio["maxSingleWeight"]
    minimum_weight = spec.get("minPositionWeight", 0.0)
    conflicts: list[str] = []
    if not candidates:
        conflicts.append("NO_OPTIMIZER_CANDIDATES")
    if len(candidates) * cap + spec["solver"]["tolerance"] < gross:
        conflicts.append("HOLDING_CAP_CANNOT_REACH_GROSS")
    if len(candidates) * minimum_weight > gross + spec["solver"]["tolerance"]:
        conflicts.append("MINIMUM_POSITION_WEIGHT_EXCEEDS_GROSS")
    neutral = spec.get("industryNeutral")
    if neutral and not neutral["allowUnknown"] and any(candidate["industryCode"] is None for candidate in candidates):
        conflicts.append("UNKNOWN_INDUSTRY_NOT_ALLOWED")
    input_hash = canonical_hash({
        "decisionDate": decision_date, "candidates": candidates, "spec": spec,
        "limits": {"grossExposure": portfolio["maxGrossExposure"],
                   "maxSingleWeight": cap, "minCashWeight": portfolio["minCashWeight"]},
    })
    solver = {**spec["solver"], "iterations": 0}
    if conflicts:
        result = {"protocolVersion": "1.0", "status": "infeasible", "solver": solver,
                  "weights": [], "objective": None, "comparison": None,
                  "turnover": 0.0, "grossExposure": 0.0,
                  "constraintMargins": {}, "conflicts": conflicts, "inputHash": input_hash}
        result["resultHash"] = canonical_hash(result)
        return result

    baseline = [round_optimizer(value) for value in optimizer_floor_cap_and_redistribute(
        [gross / len(candidates)] * len(candidates), minimum_weight, cap, gross
    )]
    adjusted = [candidate["expectedReturn"] - spec["riskAversion"] * candidate["riskProxy"]
                + spec["turnoverPenalty"] * candidate["previousWeight"] for candidate in candidates]
    minimum = min(adjusted)
    strengths = [max(1e-12, value - minimum + 1e-6) for value in adjusted]
    strength_total = sum(strengths)
    weights = baseline if spec["mode"] == "baseline" else optimizer_floor_cap_and_redistribute(
        [gross * value / strength_total for value in strengths], minimum_weight, cap, gross
    )
    iterations = 1
    previous = [candidate["previousWeight"] for candidate in candidates]
    raw_turnover = optimizer_turnover(weights, previous)
    if raw_turnover > spec["maxTurnover"]:
        scale = spec["maxTurnover"] / raw_turnover
        weights = [previous[index] + (weight - previous[index]) * scale for index, weight in enumerate(weights)]
        weights = optimizer_floor_cap_and_redistribute(
            weights, minimum_weight, cap, min(gross, sum(weights))
        )
        iterations += 1
    if neutral:
        neutral_spec = {**neutral, "solverTolerance": spec["solver"]["tolerance"],
                        "maxIterations": spec["solver"]["maxIterations"]}
        constrained_gross = sum(weights)
        weights, neutral_iterations, conflicts = neutralize_industries(
            candidates, weights, constrained_gross, neutral_spec, cap
        )
        iterations += neutral_iterations
        if conflicts:
            result = {"protocolVersion": "1.0", "status": "infeasible",
                      "solver": {**spec["solver"], "iterations": 0}, "weights": [],
                      "objective": None, "comparison": None,
                      "turnover": 0.0, "grossExposure": 0.0,
                      "constraintMargins": {}, "conflicts": conflicts, "inputHash": input_hash}
            result["resultHash"] = canonical_hash(result)
            return result
    weights = [round_optimizer(value) for value in weights]
    if any(weight > spec["solver"]["tolerance"] and
           weight < minimum_weight - spec["solver"]["tolerance"] for weight in weights):
        result = {"protocolVersion": "1.0", "status": "infeasible",
                  "solver": {**spec["solver"], "iterations": 0}, "weights": [],
                  "objective": None, "comparison": None, "turnover": 0.0, "grossExposure": 0.0,
                  "constraintMargins": {}, "conflicts": ["MINIMUM_POSITION_WEIGHT_NOT_SATISFIED"],
                  "inputHash": input_hash}
        result["resultHash"] = canonical_hash(result)
        return result
    final_turnover = round_optimizer(optimizer_turnover(weights, previous))
    industry_exposure = {key: round_optimizer(value) for key, value in
                         optimizer_exposure(candidates, weights).items()}
    baseline_industry_exposure = {key: round_optimizer(value) for key, value in
                                  optimizer_exposure(candidates, baseline).items()}
    benchmark_exposure = {key: round_optimizer(value) for key, value in
                          optimizer_benchmark_exposure(candidates, sum(weights)).items()}
    expected_return = round_optimizer(sum(
        candidate["expectedReturn"] * weights[index] for index, candidate in enumerate(candidates)
    ))
    risk_penalty = round_optimizer(spec["riskAversion"] * sum(
        candidate["riskProxy"] * weights[index] ** 2 for index, candidate in enumerate(candidates)
    ))
    turnover_penalty = round_optimizer(spec["turnoverPenalty"] * final_turnover)
    def portfolio_metrics(portfolio_weights: list[float]) -> dict[str, float]:
        return {
            "expectedReturn": round_optimizer(sum(
                candidate["expectedReturn"] * portfolio_weights[index]
                for index, candidate in enumerate(candidates)
            )),
            "riskProxy": round_optimizer(sum(
                candidate["riskProxy"] * portfolio_weights[index] ** 2
                for index, candidate in enumerate(candidates)
            )),
            "turnover": round_optimizer(optimizer_turnover(portfolio_weights, previous)),
            "concentration": round_optimizer(sum(weight ** 2 for weight in portfolio_weights)),
        }
    result = {
        "protocolVersion": "1.0", "status": "solved",
        "solver": {**spec["solver"], "iterations": iterations},
        "weights": [{**candidate, "baselineWeight": baseline[index],
                     "optimizedWeight": weights[index]} for index, candidate in enumerate(candidates)],
        "objective": {"expectedReturn": expected_return, "riskPenalty": risk_penalty,
                      "turnoverPenalty": turnover_penalty,
                      "value": round_optimizer(expected_return - risk_penalty - turnover_penalty)},
        "comparison": {"baseline": portfolio_metrics(baseline), "optimized": portfolio_metrics(weights)},
        "turnover": final_turnover, "grossExposure": round_optimizer(sum(weights)),
        "industryExposure": industry_exposure,
        "baselineIndustryExposure": baseline_industry_exposure,
        "benchmarkIndustryExposure": benchmark_exposure,
        "constraintMargins": {
            "gross": round_optimizer(gross - sum(weights)),
            "singleWeight": round_optimizer(cap - max(weights)),
            "turnover": round_optimizer(spec["maxTurnover"] - final_turnover),
            "industryDeviation": round_optimizer(industry_deviation_margin(
                industry_exposure, benchmark_exposure,
                neutral["maxActiveDeviation"] if neutral else None,
            )),
        },
        "conflicts": [], "inputHash": input_hash,
    }
    result["resultHash"] = canonical_hash(result)
    return result


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
    previous_weights: dict[str, float] = {}
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
                if row.get("fundamentalEvidence") is not None:
                    evidence["fundamentalEvidence"] = row["fundamentalEvidence"]
                if row.get("industryEvidence") is not None:
                    evidence["industryEvidence"] = row["industryEvidence"]
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
        optimizer_result = None
        if plan.get("optimizerSpec"):
            source_by_key = {row["instrumentKey"]: row for row in source}
            optimizer_result = solve_optimizer(
                plan, decision_date, selected, source_by_key, previous_weights
            )
            if optimizer_result["status"] != "solved":
                raise ValueError(
                    f'OPTIMIZER_{optimizer_result["status"].upper()}:'
                    + ",".join(optimizer_result["conflicts"])
                )
            optimized = {
                item["instrumentKey"]: item["optimizedWeight"]
                for item in optimizer_result["weights"]
            }
            weights = [optimized[row["instrumentKey"]] for row in selected]
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
        decision = {
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
        if optimizer_result is not None:
            decision["optimizerResult"] = optimizer_result
        decisions.append(decision)
        previous_weights = {target["instrumentKey"]: target["targetWeight"] for target in targets}

    output = {
        "protocolVersion": "1.3" if plan.get("planVersion") == "1.3" else (
            "1.2" if plan.get("planVersion") == "1.2" else (
                "1.1" if plan.get("factorPlan") else "1.0"
            )
        ),
        "snapshotId": plan["snapshotId"],
        "featureEngineVersion": "ml-model-cross-sectional-v1" if plan.get("mlModelPlan") else (
            MULTI_FACTOR_ENGINE_VERSION if plan.get("factorPlan") else ENGINE_VERSION
        ),
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
