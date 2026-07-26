from __future__ import annotations

import argparse
import hashlib
import json
import os
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

import pymysql

SOURCE_KEY = "tushare"
API_URL = "https://api.tushare.pro"
PAGE_SIZE = 5000

IDENTITY_FIELDS = ("instrument_key", "report_period", "announcement_date")
VALUE_FIELDS = (
    "report_type", "fiscal_year", "fiscal_quarter", "update_flag",
    "total_revenue", "revenue", "operating_cost", "total_operating_cost",
    "operating_profit", "total_profit", "income_tax", "net_profit", "net_profit_parent",
    "total_assets", "total_liabilities", "total_equity", "equity_parent",
    "total_current_assets", "total_current_liabilities", "cash_and_equivalents",
    "accounts_receivable", "inventory", "goodwill", "short_term_borrowings",
    "long_term_borrowings", "bonds_payable", "net_operating_cash_flow",
    "net_investing_cash_flow", "net_financing_cash_flow", "capital_expenditure",
    "free_cash_flow", "eps", "diluted_eps", "bps", "revenue_per_share",
    "operating_cash_flow_per_share", "roe_pct", "roe_weighted_pct",
    "roe_diluted_pct", "roe_calculated_pct", "roe_calculation_method", "roa_pct",
    "gross_margin_pct", "net_margin_pct", "debt_to_assets_pct", "current_ratio",
    "quick_ratio", "asset_turnover", "inventory_turnover", "receivables_turnover",
    "operating_cash_flow_to_revenue_pct", "revenue_yoy_pct", "net_profit_yoy_pct",
)
SOURCE_FIELDS = ("source_key", "source_version", "source_fingerprint", "fetched_at")
ALL_FIELDS = IDENTITY_FIELDS + VALUE_FIELDS + SOURCE_FIELDS

API_FIELDS: dict[str, tuple[str, ...]] = {
    "income": (
        "ts_code", "ann_date", "f_ann_date", "end_date", "report_type", "update_flag",
        "total_revenue", "revenue", "oper_cost", "total_cogs", "operate_profit",
        "total_profit", "income_tax", "n_income", "n_income_attr_p", "basic_eps", "diluted_eps",
    ),
    "balancesheet": (
        "ts_code", "ann_date", "f_ann_date", "end_date", "report_type", "update_flag",
        "total_assets", "total_liab", "total_hldr_eqy_inc_min_int",
        "total_hldr_eqy_exc_min_int", "total_cur_assets", "total_cur_liab",
        "money_cap", "accounts_receiv", "inventories", "goodwill", "st_borr",
        "lt_borr", "bond_payable",
    ),
    "cashflow": (
        "ts_code", "ann_date", "f_ann_date", "end_date", "report_type", "update_flag",
        "n_cashflow_act", "n_cashflow_inv_act", "n_cash_flows_fnc_act",
        "c_pay_acq_const_fiolta", "free_cashflow",
    ),
    "fina_indicator": (
        "ts_code", "ann_date", "end_date", "eps", "dt_eps", "bps", "revenue_ps",
        "ocfps", "roe", "roe_waa", "roe_dt", "roa", "grossprofit_margin",
        "netprofit_margin", "debt_to_assets", "current_ratio", "quick_ratio",
        "assets_turn", "inv_turn", "ar_turn", "ocf_to_or", "tr_yoy", "netprofit_yoy",
    ),
}

FIELD_MAP: dict[str, dict[str, str]] = {
    "income": {
        "total_revenue": "total_revenue", "revenue": "revenue",
        "oper_cost": "operating_cost", "total_cogs": "total_operating_cost",
        "operate_profit": "operating_profit", "total_profit": "total_profit",
        "income_tax": "income_tax", "n_income": "net_profit",
        "n_income_attr_p": "net_profit_parent", "basic_eps": "eps",
        "diluted_eps": "diluted_eps",
    },
    "balancesheet": {
        "total_assets": "total_assets", "total_liab": "total_liabilities",
        "total_hldr_eqy_inc_min_int": "total_equity",
        "total_hldr_eqy_exc_min_int": "equity_parent",
        "total_cur_assets": "total_current_assets",
        "total_cur_liab": "total_current_liabilities",
        "money_cap": "cash_and_equivalents", "accounts_receiv": "accounts_receivable",
        "inventories": "inventory", "goodwill": "goodwill",
        "st_borr": "short_term_borrowings", "lt_borr": "long_term_borrowings",
        "bond_payable": "bonds_payable",
    },
    "cashflow": {
        "n_cashflow_act": "net_operating_cash_flow",
        "n_cashflow_inv_act": "net_investing_cash_flow",
        "n_cash_flows_fnc_act": "net_financing_cash_flow",
        "c_pay_acq_const_fiolta": "capital_expenditure",
        "free_cashflow": "free_cash_flow",
    },
    "fina_indicator": {
        "eps": "eps", "dt_eps": "diluted_eps", "bps": "bps",
        "revenue_ps": "revenue_per_share", "ocfps": "operating_cash_flow_per_share",
        "roe": "roe_pct", "roe_waa": "roe_weighted_pct", "roe_dt": "roe_diluted_pct",
        "roa": "roa_pct", "grossprofit_margin": "gross_margin_pct",
        "netprofit_margin": "net_margin_pct", "debt_to_assets": "debt_to_assets_pct",
        "current_ratio": "current_ratio", "quick_ratio": "quick_ratio",
        "assets_turn": "asset_turnover", "inv_turn": "inventory_turnover",
        "ar_turn": "receivables_turnover",
        "ocf_to_or": "operating_cash_flow_to_revenue_pct",
        "tr_yoy": "revenue_yoy_pct", "netprofit_yoy": "net_profit_yoy_pct",
    },
}


def load_env(path: Path) -> None:
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key.strip() not in os.environ:
            os.environ[key.strip()] = value.strip().strip('"').strip("'")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Update normalized A-share financial reports")
    parser.add_argument("--start-date", help="Announcement start date, YYYY-MM-DD")
    parser.add_argument("--end-date", help="Announcement end date, YYYY-MM-DD")
    parser.add_argument("--lookback-days", type=int, default=21)
    parser.add_argument("--symbol", help="Single six-digit stock code")
    parser.add_argument("--full", action="store_true", help="Backfill by all reporting periods")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--request-interval", type=float, default=0.15)
    parser.add_argument("--provider", choices=("auto", "tushare", "sina"), default="auto")
    parser.add_argument("--batch-size", type=int, default=200)
    parser.add_argument("--workers", type=int, default=4)
    return parser.parse_args()


def normalize_date(value: Any) -> str | None:
    if value is not None and hasattr(value, "strftime"):
        try:
            return value.strftime("%Y-%m-%d")
        except (TypeError, ValueError):
            pass
    text = "".join(ch for ch in str(value or "") if ch.isdigit())
    if len(text) < 8:
        return None
    text = text[:8]
    return f"{text[:4]}-{text[4:6]}-{text[6:8]}"


def finite_number(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number or number in (float("inf"), float("-inf")):
        return None
    return number


def fiscal_metadata(report_period: str) -> tuple[int, int, str]:
    year, month, _ = (int(part) for part in report_period.split("-"))
    quarter = {3: 1, 6: 2, 9: 3, 12: 4}.get(month, max(1, min(4, (month + 2) // 3)))
    report_type = "annual" if quarter == 4 else "quarterly"
    return year, quarter, report_type


def derive_metrics(record: dict[str, Any]) -> None:
    revenue = finite_number(record.get("revenue")) or finite_number(record.get("total_revenue"))
    cost = finite_number(record.get("operating_cost"))
    net_profit = finite_number(record.get("net_profit_parent")) or finite_number(record.get("net_profit"))
    assets = finite_number(record.get("total_assets"))
    liabilities = finite_number(record.get("total_liabilities"))
    ocf = finite_number(record.get("net_operating_cash_flow"))
    capex = finite_number(record.get("capital_expenditure"))
    if record.get("gross_margin_pct") is None and revenue and cost is not None:
        record["gross_margin_pct"] = (revenue - cost) / revenue * 100
    if record.get("net_margin_pct") is None and revenue and net_profit is not None:
        record["net_margin_pct"] = net_profit / revenue * 100
    if record.get("debt_to_assets_pct") is None and assets and liabilities is not None:
        record["debt_to_assets_pct"] = liabilities / assets * 100
    if record.get("operating_cash_flow_to_revenue_pct") is None and revenue and ocf is not None:
        record["operating_cash_flow_to_revenue_pct"] = ocf / revenue * 100
    if record.get("free_cash_flow") is None and ocf is not None and capex is not None:
        record["free_cash_flow"] = ocf - abs(capex)


def map_api_rows(
    api_name: str,
    rows: Iterable[dict[str, Any]],
    instruments: dict[str, int],
) -> dict[tuple[int, str, str], dict[str, Any]]:
    mapped: dict[tuple[int, str, str], dict[str, Any]] = {}
    for row in rows:
        ts_code = str(row.get("ts_code") or "").upper()
        symbol = ts_code.split(".", 1)[0]
        instrument_key = instruments.get(ts_code) or instruments.get(symbol)
        report_period = normalize_date(row.get("end_date"))
        announcement_date = normalize_date(row.get("f_ann_date") or row.get("ann_date"))
        if not instrument_key or not report_period or not announcement_date:
            continue
        key = (instrument_key, report_period, announcement_date)
        target = mapped.setdefault(key, {
            "instrument_key": instrument_key,
            "report_period": report_period,
            "announcement_date": announcement_date,
            "update_flag": 0,
        })
        year, quarter, report_type = fiscal_metadata(report_period)
        target.update(fiscal_year=year, fiscal_quarter=quarter, report_type=report_type)
        target["update_flag"] = max(
            int(target.get("update_flag") or 0),
            int(finite_number(row.get("update_flag")) or 0),
        )
        for source_name, target_name in FIELD_MAP[api_name].items():
            value = finite_number(row.get(source_name))
            if value is not None:
                target[target_name] = value
    return mapped


class TushareClient:
    def __init__(self, token: str, request_interval: float = 0.15) -> None:
        if not token:
            raise RuntimeError("TUSHARE_TOKEN is not configured")
        self.token = token
        self.request_interval = max(0.0, request_interval)

    def query(self, api_name: str, params: dict[str, Any]) -> list[dict[str, Any]]:
        fields = API_FIELDS[api_name]
        result: list[dict[str, Any]] = []
        offset = 0
        while True:
            page_params = {**params, "limit": PAGE_SIZE, "offset": offset}
            payload = json.dumps({
                "api_name": api_name,
                "token": self.token,
                "params": page_params,
                "fields": ",".join(fields),
            }).encode("utf-8")
            body = self._post(payload)
            if body.get("code") != 0:
                raise RuntimeError(f"Tushare {api_name} failed: {body.get('msg') or body.get('code')}")
            data = body.get("data") or {}
            response_fields = data.get("fields") or []
            items = data.get("items") or []
            page = [dict(zip(response_fields, item)) for item in items]
            result.extend(page)
            if len(page) < PAGE_SIZE:
                break
            offset += PAGE_SIZE
        return result

    def _post(self, payload: bytes) -> dict[str, Any]:
        last_error: Exception | None = None
        for attempt in range(4):
            try:
                request = urllib.request.Request(
                    API_URL, data=payload,
                    headers={"Content-Type": "application/json", "User-Agent": "quant-backtest/1.0"},
                    method="POST",
                )
                with urllib.request.urlopen(request, timeout=45) as response:
                    body = json.loads(response.read().decode("utf-8"))
                time.sleep(self.request_interval)
                return body
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
                last_error = error
                time.sleep(2 ** attempt)
        raise RuntimeError(f"Tushare request failed after retries: {last_error}")


def connect_db() -> pymysql.Connection:
    return pymysql.connect(
        host=os.getenv("DB_HOST", "127.0.0.1"),
        port=int(os.getenv("DB_PORT", "3306")),
        user=os.getenv("DB_USER", "root"),
        password=os.getenv("DB_PASSWORD", ""),
        database=os.getenv("DB_NAME", "quant_backtest"),
        charset="utf8mb4",
        autocommit=False,
        cursorclass=pymysql.cursors.DictCursor,
    )


def load_instruments(connection: pymysql.Connection) -> dict[str, int]:
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT instrument_key, market, symbol FROM instruments "
            "WHERE type='stock' AND status='active'"
        )
        rows = cursor.fetchall()
    result: dict[str, int] = {}
    for row in rows:
        symbol = str(row["symbol"]).zfill(6)
        market = str(row["market"]).upper()
        suffix = {"SH": "SH", "SZ": "SZ", "BJ": "BJ"}.get(market)
        result[symbol] = int(row["instrument_key"])
        if suffix:
            result[f"{symbol}.{suffix}"] = int(row["instrument_key"])
    return result


def merge_records(target: dict[tuple[int, str, str], dict[str, Any]],
                  incoming: dict[tuple[int, str, str], dict[str, Any]]) -> None:
    for key, values in incoming.items():
        target.setdefault(key, {}).update(values)


def carry_forward_publications(records: Iterable[dict[str, Any]]) -> None:
    grouped: dict[tuple[int, str], list[dict[str, Any]]] = {}
    for record in records:
        grouped.setdefault(
            (int(record["instrument_key"]), str(record["report_period"])), []
        ).append(record)
    carry_fields = tuple(
        field for field in VALUE_FIELDS
        if field not in {
            "report_type", "fiscal_year", "fiscal_quarter", "update_flag",
            "roe_calculated_pct", "roe_calculation_method",
        }
    )
    for versions in grouped.values():
        versions.sort(key=lambda item: str(item["announcement_date"]))
        latest: dict[str, Any] = {}
        for version in versions:
            for field in carry_fields:
                if version.get(field) is None and latest.get(field) is not None:
                    version[field] = latest[field]
                elif version.get(field) is not None:
                    latest[field] = version[field]


def fingerprint(record: dict[str, Any]) -> str:
    material = {key: record.get(key) for key in IDENTITY_FIELDS + VALUE_FIELDS}
    return hashlib.sha256(
        json.dumps(material, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def upsert_records(connection: pymysql.Connection, records: list[dict[str, Any]]) -> int:
    if not records:
        return 0
    placeholders = ", ".join(["%s"] * len(ALL_FIELDS))
    updates = ", ".join(
        f"{field}=COALESCE(VALUES({field}), {field})"
        for field in VALUE_FIELDS + SOURCE_FIELDS
        if field not in {"source_fingerprint"}
    )
    updates += ", source_fingerprint=VALUES(source_fingerprint)"
    sql = (
        f"INSERT INTO financial_reports ({', '.join(ALL_FIELDS)}) VALUES ({placeholders}) "
        f"ON DUPLICATE KEY UPDATE {updates}"
    )
    values = [[record.get(field) for field in ALL_FIELDS] for record in records]
    with connection.cursor() as cursor:
        cursor.executemany(sql, values)
    connection.commit()
    return len(records)


def fill_calculated_roe(connection: pymysql.Connection) -> int:
    sql = """
        UPDATE financial_reports AS current
        LEFT JOIN (
          SELECT ranked.instrument_key, ranked.report_period, ranked.equity_parent
          FROM (
            SELECT instrument_key, report_period, equity_parent,
                   ROW_NUMBER() OVER (
                     PARTITION BY instrument_key, report_period
                     ORDER BY announcement_date DESC, update_flag DESC
                   ) AS version_rank
            FROM financial_reports
            WHERE fiscal_quarter=4
          ) AS ranked
          WHERE ranked.version_rank=1
        ) AS previous
          ON previous.instrument_key=current.instrument_key
         AND previous.report_period=STR_TO_DATE(
           CONCAT(current.fiscal_year - 1, '-12-31'), '%Y-%m-%d'
         )
        SET current.roe_calculated_pct =
              current.net_profit_parent
              / NULLIF((current.equity_parent + COALESCE(previous.equity_parent, current.equity_parent)) / 2, 0)
              * (4 / current.fiscal_quarter) * 100,
            current.roe_calculation_method =
              IF(previous.equity_parent IS NULL,
                 'annualized_profit_over_ending_parent_equity',
                 'annualized_profit_over_average_parent_equity')
        WHERE current.roe_pct IS NULL
          AND current.roe_weighted_pct IS NULL
          AND current.net_profit_parent IS NOT NULL
          AND current.equity_parent IS NOT NULL
    """
    with connection.cursor() as cursor:
        affected = cursor.execute(sql)
    connection.commit()
    return int(affected)


def reporting_periods(start_year: int = 1990) -> Iterable[str]:
    today = date.today()
    for year in range(start_year, today.year + 1):
        for month_day in ("0331", "0630", "0930", "1231"):
            value = f"{year}{month_day}"
            if value <= today.strftime("%Y%m%d"):
                yield value


def first_value(row: dict[str, Any], *keys: str) -> float | None:
    for key in keys:
        value = finite_number(row.get(key))
        if value is not None:
            return value
    return None


def load_sina_targets(
    connection: pymysql.Connection,
    symbol: str | None,
    full: bool,
    batch_size: int,
) -> list[dict[str, Any]]:
    if symbol:
        normalized = "".join(ch for ch in symbol if ch.isdigit()).zfill(6)
        clause = "AND instrument.symbol=%s"
        params: tuple[Any, ...] = (normalized,)
        limit = ""
    else:
        clause = ""
        params = ()
        limit = "" if full else f"LIMIT {max(1, min(1000, batch_size))}"
    with connection.cursor() as cursor:
        cursor.execute(
            f"""
            SELECT instrument.instrument_key, instrument.market, instrument.symbol,
                   MAX(report.fetched_at) AS latest_fetched_at
            FROM instruments AS instrument
            LEFT JOIN financial_reports AS report
              ON report.instrument_key=instrument.instrument_key
            WHERE instrument.type='stock' AND instrument.status='active' {clause}
            GROUP BY instrument.instrument_key, instrument.market, instrument.symbol
            ORDER BY latest_fetched_at IS NOT NULL, latest_fetched_at, instrument.instrument_key
            {limit}
            """,
            params,
        )
        return list(cursor.fetchall())


def fetch_sina_symbol(target: dict[str, Any]) -> list[dict[str, Any]]:
    import akshare as ak

    symbol = str(target["symbol"]).zfill(6)
    market = str(target["market"]).upper()
    prefixed = ("sh" if market == "SH" else "bj" if market == "BJ" else "sz") + symbol
    combined: dict[tuple[int, str, str], dict[str, Any]] = {}

    frames = {
        "income": ak.stock_financial_report_sina(stock=prefixed, symbol="利润表"),
        "balance": ak.stock_financial_report_sina(stock=prefixed, symbol="资产负债表"),
        "cashflow": ak.stock_financial_report_sina(stock=prefixed, symbol="现金流量表"),
    }
    for kind, frame in frames.items():
        for raw in frame.to_dict(orient="records"):
            report_period = normalize_date(raw.get("报告日"))
            announcement_date = normalize_date(raw.get("公告日期") or raw.get("更新日期"))
            if not report_period or not announcement_date:
                continue
            key = (int(target["instrument_key"]), report_period, announcement_date)
            record = combined.setdefault(key, {
                "instrument_key": int(target["instrument_key"]),
                "report_period": report_period,
                "announcement_date": announcement_date,
                "update_flag": 0,
            })
            year, quarter, report_type = fiscal_metadata(report_period)
            record.update(fiscal_year=year, fiscal_quarter=quarter, report_type=report_type)
            if kind == "income":
                record.update({
                    "total_revenue": first_value(raw, "营业总收入"),
                    "revenue": first_value(raw, "营业收入"),
                    "operating_cost": first_value(raw, "营业成本"),
                    "total_operating_cost": first_value(raw, "营业总成本"),
                    "operating_profit": first_value(raw, "营业利润"),
                    "total_profit": first_value(raw, "利润总额"),
                    "income_tax": first_value(raw, "所得税费用"),
                    "net_profit": first_value(raw, "净利润"),
                    "net_profit_parent": first_value(raw, "归属于母公司所有者的净利润"),
                    "eps": first_value(raw, "基本每股收益"),
                    "diluted_eps": first_value(raw, "稀释每股收益"),
                })
            elif kind == "balance":
                record.update({
                    "total_assets": first_value(raw, "资产总计"),
                    "total_liabilities": first_value(raw, "负债合计"),
                    "total_equity": first_value(raw, "所有者权益(或股东权益)合计", "所有者权益合计"),
                    "equity_parent": first_value(raw, "归属于母公司股东权益合计", "归属于母公司所有者权益合计"),
                    "total_current_assets": first_value(raw, "流动资产合计"),
                    "total_current_liabilities": first_value(raw, "流动负债合计"),
                    "cash_and_equivalents": first_value(raw, "货币资金"),
                    "accounts_receivable": first_value(raw, "应收账款", "应收票据及应收账款"),
                    "inventory": first_value(raw, "存货"),
                    "goodwill": first_value(raw, "商誉"),
                    "short_term_borrowings": first_value(raw, "短期借款"),
                    "long_term_borrowings": first_value(raw, "长期借款"),
                    "bonds_payable": first_value(raw, "应付债券"),
                })
            else:
                record.update({
                    "net_operating_cash_flow": first_value(raw, "经营活动产生的现金流量净额"),
                    "net_investing_cash_flow": first_value(raw, "投资活动产生的现金流量净额"),
                    "net_financing_cash_flow": first_value(raw, "筹资活动产生的现金流量净额"),
                    "capital_expenditure": first_value(
                        raw, "购建固定资产、无形资产和其他长期资产所支付的现金"
                    ),
                })

    # Sina rejects very early start years for some securities with an empty frame.
    # 2010 is accepted consistently; older periods still retain statement values
    # and receive transparently labelled calculated ROE where possible.
    indicators = ak.stock_financial_analysis_indicator(symbol=symbol, start_year="2010")
    by_period: dict[str, dict[str, Any]] = {}
    for raw in indicators.to_dict(orient="records"):
        period = normalize_date(raw.get("日期"))
        if period:
            by_period[period] = raw
    for record in combined.values():
        raw = by_period.get(record["report_period"])
        if not raw:
            continue
        record.update({
            "eps": first_value(raw, "加权每股收益(元)", "摊薄每股收益(元)") or record.get("eps"),
            "bps": first_value(raw, "每股净资产_调整前(元)", "每股净资产_调整后(元)"),
            "operating_cash_flow_per_share": first_value(raw, "每股经营性现金流(元)"),
            "roe_pct": first_value(raw, "净资产收益率(%)"),
            "roe_weighted_pct": first_value(raw, "加权净资产收益率(%)"),
            "roa_pct": first_value(raw, "总资产净利润率(%)", "总资产利润率(%)"),
            "gross_margin_pct": first_value(raw, "销售毛利率(%)"),
            "net_margin_pct": first_value(raw, "销售净利率(%)"),
            "debt_to_assets_pct": first_value(raw, "资产负债率(%)"),
            "current_ratio": first_value(raw, "流动比率"),
            "quick_ratio": first_value(raw, "速动比率"),
            "asset_turnover": first_value(raw, "总资产周转率(次)"),
            "inventory_turnover": first_value(raw, "存货周转率(次)"),
            "receivables_turnover": first_value(raw, "应收账款周转率(次)"),
            "operating_cash_flow_to_revenue_pct": first_value(
                raw, "经营现金净流量对销售收入比率(%)"
            ),
            "revenue_yoy_pct": first_value(raw, "主营业务收入增长率(%)"),
            "net_profit_yoy_pct": first_value(raw, "净利润增长率(%)"),
        })
    return list(combined.values())


def main() -> int:
    load_env(Path.cwd() / ".env")
    args = parse_args()
    today = date.today()
    end_date = date.fromisoformat(args.end_date) if args.end_date else today
    start_date = (
        date.fromisoformat(args.start_date)
        if args.start_date else end_date - timedelta(days=max(1, args.lookback_days))
    )
    connection = connect_db()
    try:
        combined: dict[tuple[int, str, str], dict[str, Any]] = {}
        fetched_counts: dict[str, int] = {}
        token = os.getenv("TUSHARE_TOKEN", "")
        provider = args.provider
        if provider == "auto":
            provider = "tushare" if token and args.symbol else "sina"

        if provider == "tushare":
            client = TushareClient(token, args.request_interval)
            instruments = load_instruments(connection)
            params_list: list[dict[str, Any]]
            if args.full:
                params_list = [{"period": period} for period in reporting_periods()]
            else:
                params = {
                    "start_date": start_date.strftime("%Y%m%d"),
                    "end_date": end_date.strftime("%Y%m%d"),
                }
                if not args.symbol:
                    raise RuntimeError(
                        "The standard Tushare financial indicator API requires --symbol; "
                        "use --provider sina for token-free rotating updates"
                    )
                symbol = "".join(ch for ch in args.symbol if ch.isdigit()).zfill(6)
                suffix = (
                    "SH" if symbol.startswith(("5", "6", "9"))
                    else "BJ" if symbol.startswith(("4", "8")) else "SZ"
                )
                params["ts_code"] = f"{symbol}.{suffix}"
                params_list = [params]
            for params in params_list:
                for api_name in API_FIELDS:
                    rows = client.query(api_name, params)
                    fetched_counts[api_name] = fetched_counts.get(api_name, 0) + len(rows)
                    merge_records(combined, map_api_rows(api_name, rows, instruments))
        else:
            targets = load_sina_targets(connection, args.symbol, args.full, args.batch_size)
            with ThreadPoolExecutor(max_workers=max(1, min(8, args.workers))) as executor:
                futures = {executor.submit(fetch_sina_symbol, target): target for target in targets}
                for future in as_completed(futures):
                    target = futures[future]
                    try:
                        records = future.result()
                        merge_records(combined, {
                            (
                                int(record["instrument_key"]),
                                str(record["report_period"]),
                                str(record["announcement_date"]),
                            ): record
                            for record in records
                        })
                        fetched_counts["symbols"] = fetched_counts.get("symbols", 0) + 1
                        fetched_counts["reports"] = fetched_counts.get("reports", 0) + len(records)
                    except Exception as error:
                        fetched_counts["failedSymbols"] = fetched_counts.get("failedSymbols", 0) + 1
                        print(
                            f"[financial_update] Sina {target['symbol']} failed: {error}",
                            file=os.sys.stderr,
                        )

        fetched_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
        source_version = f"{provider}-{start_date:%Y%m%d}-{end_date:%Y%m%d}"
        records = []
        carry_forward_publications(combined.values())
        for record in combined.values():
            derive_metrics(record)
            record.update(
                source_key=provider,
                source_version=source_version,
                fetched_at=fetched_at,
            )
            record["source_fingerprint"] = fingerprint(record)
            records.append(record)
        records.sort(key=lambda item: (
            item["instrument_key"], item["report_period"], item["announcement_date"]
        ))
        written = 0 if args.dry_run else upsert_records(connection, records)
        calculated_roe = 0 if args.dry_run else fill_calculated_roe(connection)
        print(json.dumps({
            "status": "dry-run" if args.dry_run else "completed",
            "source": provider,
            "window": {"start": start_date.isoformat(), "end": end_date.isoformat()},
            "apiRows": fetched_counts,
            "normalizedReports": len(records),
            "writtenReports": written,
            "calculatedRoeRows": calculated_roe,
        }, ensure_ascii=False))
        return 0
    finally:
        connection.close()


if __name__ == "__main__":
    raise SystemExit(main())
