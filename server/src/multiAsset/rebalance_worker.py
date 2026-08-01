"""Fixed M4 cross-sectional calculator.

This worker accepts one JSON document on stdin and emits one RebalancePlan on stdout.
It does not execute user code and intentionally has no cash, order, position or equity logic.
"""

from __future__ import annotations

import hashlib
import json
import sys
from datetime import date
from typing import Any


ENGINE_VERSION = "python-cross-sectional-v1"


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
    direction = plan["featurePlan"]["direction"]
    values = [
        row["featureValue"] if direction == "higher" else -row["featureValue"]
        for row in selected
    ]
    floor = min(values)
    strengths = [value - floor + 1e-12 for value in values]
    total = sum(strengths)
    preliminary = [gross * value / total for value in strengths]
    return cap_and_redistribute(preliminary, cap, gross)


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
        feature_evidence = sorted(
            [
                {"instrumentKey": row["instrumentKey"], "featureValue": row["featureValue"]}
                for row in source
            ],
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
                "reasonCodes": [
                    f'{plan["featurePlan"]["featureId"]}@{plan["featurePlan"]["featureVersion"]}',
                    f"rank:{index + 1}",
                ],
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
        "protocolVersion": "1.0",
        "snapshotId": plan["snapshotId"],
        "featureEngineVersion": ENGINE_VERSION,
        "sourcePlanHash": canonical_hash(plan),
        "decisions": decisions,
    }
    output["planHash"] = canonical_hash(output)
    return output


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        result = generate(payload)
        json.dump(result, sys.stdout, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        sys.stdout.write("\n")
        return 0
    except Exception as error:  # fixed worker boundary: one structured error line
        sys.stderr.write(f"{type(error).__name__}: {error}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
