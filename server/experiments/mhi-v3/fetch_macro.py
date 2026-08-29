"""Fetch and freeze the macro inputs used by the MHI v3 experiment.

AKShare is used as the transport layer.  Its current implementations for these
three series read Eastmoney mirrors, so the manifest distinguishes the retrieval
URL from the official statistical authority used for spot checks and semantics.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path

import akshare as ak
import pandas as pd


ROOT = Path(__file__).resolve().parent
RAW_DIR = ROOT / "data" / "raw"


def parse_month(value: object) -> pd.Timestamp:
    digits = re.findall(r"\d+", str(value))
    if len(digits) >= 2:
        return pd.Timestamp(year=int(digits[0]), month=int(digits[1]), day=1)
    if len(digits) == 1 and len(digits[0]) == 6:
        return pd.Timestamp(year=int(digits[0][:4]), month=int(digits[0][4:]), day=1)
    raise ValueError(f"Cannot parse month: {value!r}")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_csv(frame: pd.DataFrame, name: str) -> dict[str, object]:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    path = RAW_DIR / name
    frame.sort_values("observation_month").to_csv(path, index=False, encoding="utf-8")
    return {
        "file": str(path.relative_to(ROOT)).replace("\\", "/"),
        "rows": int(len(frame)),
        "firstObservation": frame["observation_month"].min().strftime("%Y-%m-%d"),
        "lastObservation": frame["observation_month"].max().strftime("%Y-%m-%d"),
        "sha256": sha256(path),
    }


def fetch_pmi() -> pd.DataFrame:
    raw = ak.macro_china_pmi()
    out = pd.DataFrame(
        {
            "observation_month": raw.iloc[:, 0].map(parse_month),
            "manufacturing_pmi": pd.to_numeric(raw.iloc[:, 1], errors="coerce"),
            "non_manufacturing_pmi": pd.to_numeric(raw.iloc[:, 3], errors="coerce"),
        }
    ).dropna(subset=["manufacturing_pmi"])
    # NBS normally publishes at 09:30 on the final calendar day of the survey
    # month.  Using the following calendar day is deliberately conservative.
    out["availability_date"] = out["observation_month"] + pd.offsets.MonthEnd(0) + pd.Timedelta(days=1)
    return out


def fetch_ppi() -> pd.DataFrame:
    raw = ak.macro_china_ppi()
    out = pd.DataFrame(
        {
            "observation_month": raw.iloc[:, 0].map(parse_month),
            "ppi_yoy": pd.to_numeric(raw.iloc[:, 2], errors="coerce"),
        }
    ).dropna(subset=["ppi_yoy"])
    # Historical release dates are not present in the mirror.  The 15th of the
    # following month is later than the usual NBS release and avoids pretending
    # that a reconstructed date is the actual vintage timestamp.
    out["availability_date"] = out["observation_month"] + pd.offsets.MonthBegin(1) + pd.Timedelta(days=14)
    return out


def fetch_money() -> pd.DataFrame:
    raw = ak.macro_china_money_supply()
    out = pd.DataFrame(
        {
            "observation_month": raw.iloc[:, 0].map(parse_month),
            "m2_yoy": pd.to_numeric(raw.iloc[:, 2], errors="coerce"),
            "m1_yoy": pd.to_numeric(raw.iloc[:, 5], errors="coerce"),
        }
    ).dropna(subset=["m1_yoy", "m2_yoy"])
    out["m1_m2_gap"] = out["m1_yoy"] - out["m2_yoy"]
    # PBOC historical articles contain actual timestamps, but the AKShare mirror
    # does not.  The following-month 20th is a conservative common availability.
    out["availability_date"] = out["observation_month"] + pd.offsets.MonthBegin(1) + pd.Timedelta(days=19)
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--as-of", default=None, help="UTC fetch timestamp override for reproducible metadata")
    args = parser.parse_args()

    fetched_at = args.as_of or datetime.now(timezone.utc).isoformat()
    series = [
        (
            "pmi",
            "macro_china_pmi",
            fetch_pmi(),
            "https://data.eastmoney.com/cjsj/pmi.html",
            "https://www.stats.gov.cn/sj/zxfbhjd/",
            "National Bureau of Statistics of China",
            "pmi.csv",
        ),
        (
            "ppi",
            "macro_china_ppi",
            fetch_ppi(),
            "https://data.eastmoney.com/cjsj/ppi.html",
            "https://www.stats.gov.cn/sj/zxfbhjd/",
            "National Bureau of Statistics of China",
            "ppi.csv",
        ),
        (
            "money_supply",
            "macro_china_money_supply",
            fetch_money(),
            "https://data.eastmoney.com/cjsj/hbgyl.html",
            "https://www.pbc.gov.cn/diaochatongjisi/116219/116225/index.html",
            "People's Bank of China",
            "money-supply.csv",
        ),
    ]

    manifest: dict[str, object] = {
        "schemaVersion": 1,
        "fetchedAt": fetched_at,
        "akshareVersion": ak.__version__,
        "vintageWarning": (
            "AKShare returns the latest historical series, not archived first-release vintages. "
            "Conservative availability dates prevent obvious look-ahead but cannot remove revision bias."
        ),
        "series": [],
    }
    for key, function, frame, retrieval_url, authority_url, authority, filename in series:
        file_meta = write_csv(frame, filename)
        manifest["series"].append(
            {
                "key": key,
                "akshareFunction": function,
                "retrievalUrl": retrieval_url,
                "officialAuthority": authority,
                "officialReferenceUrl": authority_url,
                **file_meta,
            }
        )

    manifest_path = ROOT / "data" / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
