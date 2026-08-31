"""Period-based A-share collection, including bank/securities/insurance templates.

Raw stages and write-ahead backups live under server/.cache/financial-data.
--resume reuses complete stages from today only; normal scheduled runs refresh.
"""
from __future__ import annotations

import hashlib
import json
import time
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Callable

import requests

import financial_update as fin

URL = "https://datacenter-web.eastmoney.com/api/data/v1/get"
CACHE_ROOT = Path(__file__).resolve().parents[2] / ".cache/financial-data/eastmoney"
SECURITY_FILTER = '(SECURITY_TYPE_CODE in ("058001001","058001008"))'
META = ("SECUCODE", "SECURITY_CODE", "SECURITY_TYPE_CODE", "REPORT_DATE", "NOTICE_DATE", "UPDATE_DATE", "CURRENCY")
MAPS = {
    "BALANCE": dict(zip(
        ("TOTAL_ASSETS", "TOTAL_LIABILITIES", "TOTAL_EQUITY", "TOTAL_PARENT_EQUITY", "TOTAL_CURRENT_ASSETS",
         "TOTAL_CURRENT_LIAB", "MONETARYFUNDS", "ACCOUNTS_RECE", "INVENTORY", "GOODWILL", "SHORT_LOAN", "LONG_LOAN", "BOND_PAYABLE"),
        ("total_assets", "total_liabilities", "total_equity", "equity_parent", "total_current_assets",
         "total_current_liabilities", "cash_and_equivalents", "accounts_receivable", "inventory", "goodwill", "short_term_borrowings", "long_term_borrowings", "bonds_payable"))),
    "INCOME": dict(zip(
        ("TOTAL_OPERATE_INCOME", "OPERATE_INCOME", "OPERATE_COST", "TOTAL_OPERATE_COST", "OPERATE_PROFIT", "TOTAL_PROFIT",
         "INCOME_TAX", "NETPROFIT", "PARENT_NETPROFIT", "BASIC_EPS", "DILUTED_EPS"),
        ("total_revenue", "revenue", "operating_cost", "total_operating_cost", "operating_profit", "total_profit",
         "income_tax", "net_profit", "net_profit_parent", "eps", "diluted_eps"))),
    "CASHFLOW": dict(zip(
        ("NETCASH_OPERATE", "NETCASH_INVEST", "NETCASH_FINANCE", "CONSTRUCT_LONG_ASSET"),
        ("net_operating_cash_flow", "net_investing_cash_flow", "net_financing_cash_flow", "capital_expenditure"))),
    "DISCLOSURE": {
        "TOTAL_OPERATE_INCOME": "total_revenue", "PARENT_NETPROFIT": "net_profit_parent", "BASIC_EPS": "eps",
        "BPS": "bps", "MGJYXJJE": "operating_cash_flow_per_share", "WEIGHTAVG_ROE": "roe_weighted_pct",
        "YSTZ": "revenue_yoy_pct", "SJLTZ": "net_profit_yoy_pct", "XSMLL": "gross_margin_pct",
    },
}
CORE_FIELDS = ("total_assets", "total_liabilities", "total_equity", "equity_parent", "net_profit_parent", "net_operating_cash_flow")


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, default=str, indent=2), encoding="utf-8")
    temporary.replace(path)


def recent_periods(as_of: date) -> list[str]:
    return sorted((f"{year}-{ending}" for year in (as_of.year - 1, as_of.year)
                   for ending in ("03-31", "06-30", "09-30", "12-31")
                   if f"{year}-{ending}" < as_of.isoformat()), reverse=True)[:2]


class EastmoneyClient:
    def __init__(self, cache: Path, interval: float = .15, resume: bool = False,
                 progress: Callable[[dict[str, Any]], None] | None = None) -> None:
        self.cache, self.interval, self.resume = cache, max(.05, interval), resume
        self.session = requests.Session()
        self.progress = progress or (lambda _: None)

    def request(self, params: dict[str, Any]) -> dict[str, Any]:
        for attempt in range(3):
            try:
                response = self.session.get(URL, params=params, timeout=(5, 20))
                response.raise_for_status()
                body = response.json()
                if not body.get("success"):
                    # The service represents a valid zero-row query this way.
                    if body.get("code") == 9201 and body.get("message") == "返回数据为空":
                        return {"pages": 0, "count": 0, "data": []}
                    raise ValueError(f"Eastmoney {params['reportName']}: {body.get('message')}")
                result = body.get("result")
                if not isinstance(result, dict) or not isinstance(result.get("data"), list):
                    raise ValueError("Invalid Eastmoney result shape")
                return result
            except (requests.RequestException, ValueError):
                if attempt == 2:
                    raise
                time.sleep(2 ** attempt)
            finally:
                time.sleep(self.interval)
        raise RuntimeError("unreachable")

    def fetch(self, report: str, period: str, columns: str = "ALL") -> list[dict[str, Any]]:
        period_field = "REPORTDATE" if report == "RPT_LICO_FN_CPD" else "REPORT_DATE"
        params = {"reportName": report, "columns": columns,
                  "filter": f"({period_field}='{period}')" + SECURITY_FILTER,
                  "pageSize": 500, "sortColumns": "SECURITY_CODE", "sortTypes": "1"}
        signature = hashlib.sha256(json.dumps(params, sort_keys=True).encode()).hexdigest()
        path = self.cache / period / f"{report}.json"
        if self.resume and path.exists():
            cached = json.loads(path.read_text(encoding="utf-8"))
            if cached.get("signature") == signature and cached.get("count") == len(cached.get("rows", [])):
                self.progress({"stage": report, "period": period, "cached": True, "rows": cached["count"]})
                return cached["rows"]
        rows: list[dict[str, Any]] = []
        first = self.request({**params, "pageNumber": 1})
        count, pages = int(first["count"]), int(first["pages"])
        page_hashes: set[str] = set()
        for page in range(1, max(1, pages) + 1):
            result = first if page == 1 else self.request({**params, "pageNumber": page})
            if int(result["count"]) != count or int(result["pages"]) != pages:
                raise ValueError(f"{report}: source changed during pagination; retry without using this stage")
            data = result["data"]
            digest = hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()
            if digest in page_hashes or (count and not data):
                raise ValueError(f"{report}: repeated or empty page {page}")
            page_hashes.add(digest)
            rows.extend(data)
            self.progress({"stage": report, "period": period, "page": page, "pages": pages, "rows": len(rows)})
        if len(rows) != count:
            raise ValueError(f"{report}: expected {count} rows, received {len(rows)}")
        write_json(path, {"signature": signature, "fetchedAt": datetime.now(timezone.utc).isoformat(), "count": count, "rows": rows})
        return rows


def map_rows(combined: dict[tuple[int, str, str], dict[str, Any]], rows: list[dict[str, Any]],
             kind: str, instruments: dict[str, int], period: str, as_of: str) -> None:
    for raw in rows:
        symbol = str(raw.get("SECURITY_CODE", "")).zfill(6)
        report_period = fin.normalize_date(raw.get("REPORT_DATE") or raw.get("REPORTDATE"))
        announcement = fin.normalize_date(raw.get("NOTICE_DATE"))
        if symbol not in instruments or report_period != period or not announcement:
            continue
        if announcement > as_of or announcement < period or raw.get("CURRENCY") not in (None, "CNY"):
            continue
        key = (instruments[symbol], period, announcement)
        year, quarter, report_type = fin.fiscal_metadata(period)
        record = combined.setdefault(key, {"instrument_key": key[0], "report_period": period,
                                          "announcement_date": announcement, "fiscal_year": year,
                                          "fiscal_quarter": quarter, "report_type": report_type, "update_flag": 0})
        for source, target in MAPS[kind].items():
            value = fin.finite_number(raw.get(source))
            if value is not None:
                record[target] = value


def missing_core(record: dict[str, Any]) -> list[str]:
    # Pre-commercial companies can legitimately have no revenue line. Income
    # statement coverage uses parent profit; revenue nulls are reported separately.
    return [field for field in CORE_FIELDS if record.get(field) is None]


def collect_period(client: EastmoneyClient, instruments: dict[str, int], period: str,
                   as_of: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    # Disclosure is the authoritative target list; never guess a missing company's report.
    disclosures = client.fetch("RPT_LICO_FN_CPD", period)
    eligible = [row for row in disclosures if str(row.get("SECURITY_CODE")) in instruments
                and period <= (fin.normalize_date(row.get("NOTICE_DATE")) or "") <= as_of]
    disclosed = {str(row["SECURITY_CODE"]) for row in eligible}
    active = {symbol: key for symbol, key in instruments.items() if symbol in disclosed}
    combined: dict[tuple[int, str, str], dict[str, Any]] = {}
    failures = []
    stage_rows = {"RPT_LICO_FN_CPD": len(disclosures)}
    # Summaries cover all industries; complete templates override their values.
    stages = [(f"RPT_DMSK_FN_{kind}", kind, "ALL") for kind in ("BALANCE", "INCOME", "CASHFLOW")]
    stages += [(f"RPT_F10_FINANCE_{template}{kind}", kind,
                ",".join((*META, *MAPS[kind])) if template == "G" else "ALL")
               for template in ("G", "B", "S", "I") for kind in ("BALANCE", "INCOME", "CASHFLOW")]
    for report, kind, columns in stages:
        try:
            rows = client.fetch(report, period, columns)
            stage_rows[report] = len(rows)
            map_rows(combined, rows, kind, active, period, as_of)
        except Exception as error:
            failures.append({"stage": report, "error": str(error)[:1000]})
    # Only indicator fields from CPD override complete statements. Statement values
    # from disclosure are a fallback (not a different version's financial restatement).
    summary: dict[tuple[int, str, str], dict[str, Any]] = {}
    map_rows(summary, eligible, "DISCLOSURE", active, period, as_of)
    indicator_fields = set(MAPS["DISCLOSURE"].values()) - {"total_revenue", "net_profit_parent", "eps"}
    for key, values in summary.items():
        target = combined.setdefault(key, {})
        for field, value in values.items():
            if target.get(field) is None or field in indicator_fields:
                target[field] = value
    records = list(combined.values())
    fin.prepare_records(records, "eastmoney", f"eastmoney-v1-{period}-{as_of}")
    latest = {record["instrument_key"]: record for record in records}
    incomplete = [{"symbol": symbol, "missing": missing_core(latest.get(key, {}))}
                  for symbol, key in active.items() if missing_core(latest.get(key, {}))]
    return records, {"reportPeriod": period, "disclosedSymbols": len(disclosed), "activeSymbols": len(instruments),
                     "undisclosedSymbols": sorted(set(instruments) - disclosed), "stageRows": stage_rows,
                     "failures": failures, "incomplete": incomplete, "normalizedReports": len(records),
                     "fieldWarnings": [{"symbol": symbol, "field": "total_revenue_or_revenue", "value": None}
                                       for symbol, key in active.items()
                                       if fin.first_value(latest.get(key, {}), "total_revenue", "revenue") is None]}


def verify_period(connection: Any, instruments: dict[str, int], period: str, as_of: str) -> dict[str, Any]:
    # Narrow period-index read; perform version selection and coverage in Python.
    fields = ("instrument_key", "announcement_date", "total_revenue", "revenue", *CORE_FIELDS,
              "roe_pct", "roe_weighted_pct", "roe_calculated_pct", "revenue_yoy_pct", "net_profit_yoy_pct", "source_key")
    with connection.cursor() as cursor:
        cursor.execute(f"SELECT {','.join(fields)} FROM financial_reports WHERE report_period=%s AND announcement_date<=%s",
                       (period, as_of))
        rows = cursor.fetchall()
    eligible = set(instruments.values())
    latest = {}
    for row in sorted(rows, key=lambda r: str(r["announcement_date"])):
        if row["instrument_key"] in eligible:
            latest[row["instrument_key"]] = row
    return {"reportPeriod": period, "coveredSymbols": len(latest),
            "coreCompleteSymbols": sum(not missing_core(row) for row in latest.values()),
            "fieldCoverage": {field: sum(row.get(field) is not None for row in latest.values()) for field in fields[2:-1]},
            "missingSymbols": sorted(symbol for symbol, key in instruments.items() if key not in latest),
            "incomplete": [{"symbol": symbol, "missing": missing_core(latest[key])} for symbol, key in instruments.items()
                           if key in latest and missing_core(latest[key])],
            "sources": {source: sum(row["source_key"] == source for row in latest.values())
                        for source in sorted({row["source_key"] for row in latest.values()})}}


def run(args: Any) -> int:
    as_of = date.fromisoformat(args.end_date) if args.end_date else date.today()
    periods = getattr(args, "report_period", None) or recent_periods(as_of)
    if args.full and not getattr(args, "report_period", None):
        raise ValueError("Eastmoney backfills require explicit --report-period; unbounded --full is disabled")
    for period in periods:
        parsed = date.fromisoformat(period)
        if period[5:] not in ("03-31", "06-30", "09-30", "12-31") or parsed >= as_of:
            raise ValueError(f"Not an ended quarter: {period}")
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    cache = CACHE_ROOT / date.today().isoformat()
    run_dir = cache / "runs" / run_id
    manifest: dict[str, Any] = {"status": "running", "source": "eastmoney", "unit": "stock-period", "apiRows": {}, "totalSymbols": 0,
                                "normalizedReports": 0, "writtenReports": 0, "periods": [], "runDirectory": str(run_dir)}

    def emit(progress: dict[str, Any] | None = None) -> None:
        if progress is not None:
            manifest["progress"] = progress
        manifest["updatedAt"] = datetime.now(timezone.utc).isoformat()
        write_json(run_dir / "manifest.json", manifest)
        print(json.dumps(manifest, ensure_ascii=False, default=str), flush=True)

    connection = fin.connect_db()
    try:
        fin.acquire_financial_lock(connection)
        instruments = {symbol: key for symbol, key in fin.load_instruments(connection).items() if "." not in symbol}
        if args.symbol:
            instruments = {symbol: key for symbol, key in instruments.items() if symbol == args.symbol.zfill(6)}
            if not instruments:
                raise ValueError("Requested active stock not found")
        client = EastmoneyClient(cache, args.request_interval, getattr(args, "resume", False), emit)
        manifest["totalSymbols"] = len(instruments) * len(periods)
        emit()
        for period in periods:
            records, detail = collect_period(client, instruments, period, as_of.isoformat())
            manifest["periods"].append(detail)
            manifest["normalizedReports"] += len(records)
            write_json(run_dir / f"{period}-records.json", records)
            if not args.dry_run:
                for offset in range(0, len(records), 100):
                    part = records[offset:offset + 100]
                    manifest["writtenReports"] += fin.upsert_records(connection, part, run_dir / "before-write.jsonl")
                    emit({"stage": "write", "period": period, "records": offset + len(part), "total": len(records)})
                detail["verification"] = verify_period(connection, instruments, period, as_of.isoformat())
                # A successful but incomplete disclosure response must not silently
                # relabel already-known reports as undisclosed.
                omitted = sorted(set(detail["undisclosedSymbols"]) - set(detail["verification"]["missingSymbols"]))
                if omitted:
                    detail["failures"].append({"stage": "disclosure_reconciliation", "error": "Source omitted locally known reports", "symbols": omitted})
            manifest["apiRows"][period] = detail["stageRows"]
        partial = any(detail["failures"] or detail["incomplete"] or
                      (not args.dry_run and (detail["verification"]["coreCompleteSymbols"] < detail["disclosedSymbols"]))
                      for detail in manifest["periods"])
        manifest["apiRows"].update(
            symbols=sum(p["disclosedSymbols"] - len(p["incomplete"]) for p in manifest["periods"]),
            partialSymbols=sum(len(p["incomplete"]) for p in manifest["periods"]),
            failedStages=sum(len(p["failures"]) for p in manifest["periods"]),
            undisclosedSymbols=sum(len(p["undisclosedSymbols"]) for p in manifest["periods"]),
        )
        manifest["status"] = "dry-run" if args.dry_run else "partial" if partial else "completed"
        emit({"stage": "finished"})
        return 1 if partial else 0
    except Exception as error:
        connection.rollback()
        manifest.update(status="failed", error=str(error)[:1500])
        emit()
        raise
    finally:
        connection.close()
