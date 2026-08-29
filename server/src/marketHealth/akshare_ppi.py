"""Return AKShare PPI observations as one compact JSON document on stdout."""

from __future__ import annotations

import json
import re

import akshare as ak
import pandas as pd


def parse_month(value: object) -> pd.Timestamp:
    digits = re.findall(r"\d+", str(value))
    if len(digits) >= 2:
        return pd.Timestamp(year=int(digits[0]), month=int(digits[1]), day=1)
    raise ValueError(f"Cannot parse month: {value!r}")


def main() -> None:
    frame = ak.macro_china_ppi()
    items = []
    for _, row in frame.iterrows():
        month = parse_month(row.iloc[0])
        value = pd.to_numeric(row.iloc[2], errors="coerce")
        if pd.isna(value):
            continue
        available_at = month + pd.offsets.MonthBegin(1) + pd.Timedelta(days=14)
        items.append({
            "observationPeriod": month.strftime("%Y-%m-%d"),
            "value": float(value),
            "availableAt": available_at.strftime("%Y-%m-%dT00:00:00Z"),
        })
    print(json.dumps({
        "akshareVersion": ak.__version__,
        "retrievalUrl": "https://data.eastmoney.com/cjsj/ppi.html",
        "authorityKey": "nbs",
        "items": items,
    }, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
