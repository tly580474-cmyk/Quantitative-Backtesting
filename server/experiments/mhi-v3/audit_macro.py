"""Audit frozen macro files for integrity, timing, and official spot checks."""

from __future__ import annotations

import json
from pathlib import Path

import pandas as pd


ROOT = Path(__file__).resolve().parent


def main() -> None:
    checks = json.loads((ROOT / "data" / "official-spot-checks.json").read_text(encoding="utf-8"))
    frames: dict[str, pd.DataFrame] = {}
    for name in ("pmi", "ppi", "money-supply"):
        frame = pd.read_csv(ROOT / "data" / "raw" / f"{name}.csv", parse_dates=["observation_month", "availability_date"])
        if frame["observation_month"].duplicated().any():
            raise AssertionError(f"{name}: duplicate observation months")
        if not (frame["availability_date"] > frame["observation_month"]).all():
            raise AssertionError(f"{name}: non-causal availability date")
        frames[name] = frame

    results = []
    for check in checks:
        frame = frames[check["series"]]
        month = pd.Timestamp(check["observationMonth"])
        matches = frame.loc[frame["observation_month"] == month, check["field"]]
        if len(matches) != 1:
            raise AssertionError(f"Missing spot check row: {check}")
        actual = float(matches.iloc[0])
        if abs(actual - float(check["expected"])) > 1e-9:
            raise AssertionError(f"Spot check failed: expected {check['expected']}, got {actual}: {check}")
        results.append({**check, "actual": actual, "passed": True})

    print(json.dumps({"passed": True, "checks": results}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
