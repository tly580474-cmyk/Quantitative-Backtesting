"""Source-specific contracts. Never manufacture unreported order-size fields."""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal, InvalidOperation
import math
import time
from typing import Any

import requests

WEB_SOURCE = "eastmoney_web_datacenter"
WEB_TABLE = "stock_fund_flows_web_datacenter"
WEB_VERSION = "RPT_DMSK_TS_STOCKNEW-v1-yuan-main=elg+lg"
HISTORY_SOURCE = "tushare_gateway_eastmoney"
HISTORY_VERSION = "jiaoch:moneyflow_dc-v1-wanyuan-to-yuan"
WEB_URL = "https://datacenter-web.eastmoney.com/api/data/v1/get"


def number(value: Any) -> Decimal:
    try:
        result = Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise ValueError("missing or invalid numeric value") from None
    if not result.is_finite():
        raise ValueError("non-finite numeric value")
    return result


def business_date(value: Any) -> str:
    text = str(value).strip()
    if len(text) == 8 and text.isdigit():
        text = f"{text[:4]}-{text[4:6]}-{text[6:]}"
    else:
        text = text[:10]
    return date.fromisoformat(text).isoformat()


def optional_number(value: Any) -> float | None:
    # pandas represents a provider JSON null as NaN; missing quotes are not zeros.
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return None
    return float(number(value))


def web_record(row: dict[str, Any], instrument_key: int, expected_date: str,
               fetched_at: datetime) -> dict[str, Any]:
    actual_date = business_date(row.get("TRADE_DATE"))
    if actual_date != expected_date:
        raise ValueError(f"source trade date {actual_date} != requested {expected_date}")
    if not str(row.get("SECUCODE", "")).endswith((".SH", ".SZ")):
        raise ValueError("web datacenter supports SH/SZ only")
    main = number(row.get("PRIME_INFLOW"))
    extra = number(row.get("SUPERDEAL_INFLOW")) - number(row.get("SUPERDEAL_OUTFLOW"))
    large = number(row.get("BIGDEAL_INFLOW")) - number(row.get("BIGDEAL_OUTFLOW"))
    if main != extra + large:
        raise ValueError("PRIME_INFLOW != net SUPERDEAL + net BIGDEAL")
    close = optional_number(row.get("CLOSE_PRICE"))
    if close is not None and close <= 0:
        raise ValueError("invalid close price")
    return dict(instrument_key=instrument_key, trade_date=actual_date,
                close_price=close, change_pct=optional_number(row.get("CHANGE_RATE")),
                main_net_in=float(main), main_net_ratio=None,
                super_large_net_in=float(extra), super_large_net_ratio=None,
                large_net_in=float(large), large_net_ratio=None,
                medium_net_in=None, medium_net_ratio=None, small_net_in=None, small_net_ratio=None,
                provider_net_in=None, source_key=WEB_SOURCE, source_version=WEB_VERSION,
                fetched_at=fetched_at, is_final=1)


def gateway_record(row: dict[str, Any], instrument_key: int, expected_date: str,
                   fetched_at: datetime) -> dict[str, Any]:
    actual_date = business_date(row.get("trade_date"))
    if actual_date != expected_date:
        raise ValueError("gateway returned a different trade date")
    amounts = {name: number(row.get(name)) * 10_000 for name in
               ("net_amount", "buy_elg_amount", "buy_lg_amount", "buy_md_amount", "buy_sm_amount")}
    # moneyflow_dc publishes net amounts rounded to 0.01 万元 (100 yuan).
    if abs(amounts["net_amount"] - amounts["buy_elg_amount"] - amounts["buy_lg_amount"]) > 150:
        raise ValueError("gateway main amount inconsistent with order-size net amounts")
    close = number(row.get("close"))
    if close <= 0:
        raise ValueError("invalid historical close price")
    def ratio(name):
        value = row.get(name)
        return float(number(value)) if value is not None else None
    return dict(instrument_key=instrument_key, trade_date=actual_date,
                close_price=float(close), change_pct=float(number(row.get("pct_change"))),
                main_net_in=float(amounts["net_amount"]), main_net_ratio=ratio("net_amount_rate"),
                super_large_net_in=float(amounts["buy_elg_amount"]), super_large_net_ratio=ratio("buy_elg_amount_rate"),
                large_net_in=float(amounts["buy_lg_amount"]), large_net_ratio=ratio("buy_lg_amount_rate"),
                medium_net_in=float(amounts["buy_md_amount"]), medium_net_ratio=ratio("buy_md_amount_rate"),
                small_net_in=float(amounts["buy_sm_amount"]), small_net_ratio=ratio("buy_sm_amount_rate"),
                provider_net_in=None, source_key=HISTORY_SOURCE, source_version=HISTORY_VERSION,
                fetched_at=fetched_at, is_final=1)


def fetch_web_rows(expected_date: str, session=None, interval: float = 1.1) -> list[dict[str, Any]]:
    session = session or requests.Session()
    params = dict(reportName="RPT_DMSK_TS_STOCKNEW", columns="ALL", pageSize=500,
                  sortColumns="SECURITY_CODE", sortTypes="1", source="WEB", client="WEB",
                  filter=f"(TRADE_DATE='{expected_date}')")
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    expected_count = None
    expected_pages = None
    page = 1
    while True:
        response = session.get(WEB_URL, params={**params, "pageNumber": page},
                               headers={"User-Agent": "Mozilla/5.0", "Referer": "https://data.eastmoney.com/"},
                               timeout=(5, 25))
        response.raise_for_status()
        body = response.json()
        if body.get("success") is not True:
            raise ValueError(f"datacenter unavailable for {expected_date}: {body.get('code')} {body.get('message')}")
        result = body.get("result") or {}
        count, pages = int(result.get("count", 0)), int(result.get("pages", 0))
        batch = result.get("data")
        if count <= 0 or pages <= 0 or pages > 100 or pages != math.ceil(count / 500) or not isinstance(batch, list) or not batch:
            raise ValueError("invalid or empty datacenter page")
        if expected_count is None:
            expected_count, expected_pages = count, pages
        if count != expected_count or pages != expected_pages:
            raise ValueError("datacenter changed during pagination")
        for row in batch:
            key = str(row.get("SECUCODE", ""))
            if not key or key in seen:
                raise ValueError("repeated/invalid datacenter security during pagination")
            if business_date(row.get("TRADE_DATE")) != expected_date:
                raise ValueError("datacenter returned stale or misdated data")
            seen.add(key)
            rows.append(row)
        if page == pages:
            break
        page += 1
        time.sleep(interval)
    if len(rows) != expected_count:
        raise ValueError(f"incomplete datacenter result: {len(rows)}/{expected_count}")
    return rows


def fetch_gateway_rows(provider, trade_date: str, interval: float = 1.1) -> list[dict[str, Any]]:
    rows, seen = [], set()
    limit = 2000
    for page in range(10):
        frame = provider.moneyflow_dc(trade_date=trade_date.replace("-", ""), limit=limit, offset=page * limit)
        batch = frame.to_dict("records")
        for row in batch:
            key = str(row.get("ts_code", ""))
            if not key or key in seen or business_date(row.get("trade_date")) != trade_date:
                raise ValueError("gateway returned duplicate/invalid/misdated rows")
            seen.add(key)
            rows.append(row)
        if len(batch) < limit:
            return rows
        time.sleep(interval)
    raise ValueError("gateway pagination exceeded safe bound")
