import copy
import json
import math
import sys
import time
import warnings

warnings.filterwarnings("ignore")

MAX_PAGES = 75
MIN_ROWS = 300


def to_float(value):
    try:
        if value in ("", "-", None):
            return None
        parsed = float(value)
        if math.isfinite(parsed):
            return parsed
    except Exception:
        return None
    return None


def fetch_page(session, url, payload, page):
    request_payload = copy.deepcopy(payload)
    request_payload.update({"page": str(page)})
    last_error = None
    for attempt in range(3):
        try:
            response = session.get(url, params=request_payload, timeout=12)
            response.raise_for_status()
            return response.text
        except Exception as exc:
            last_error = exc
            time.sleep(0.7 + attempt * 0.8)
    raise last_error


def main():
    try:
        import requests
        import akshare.stock.stock_zh_a_sina as sina
        from akshare.utils import demjson

        session = requests.Session()
        session.headers.update(
            {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
                "Referer": "https://vip.stock.finance.sina.com.cn/mkt/",
            }
        )

        items = []
        failed_pages = []
        empty_pages = 0
        for page in range(1, MAX_PAGES + 1):
            try:
                text = fetch_page(session, sina.zh_sina_a_stock_url, sina.zh_sina_a_stock_payload, page)
                rows = demjson.decode(text)
            except Exception:
                failed_pages.append(page)
                if len(items) < MIN_ROWS and page <= 8:
                    continue
                break

            if not rows:
                empty_pages += 1
                if empty_pages >= 2:
                    break
                continue
            empty_pages = 0

            for row in rows:
                code = str(row.get("symbol", "")).strip()
                name = str(row.get("name", "")).strip()
                if code.startswith(("sh", "sz", "bj")):
                    code = code[2:]
                if not code or not name:
                    continue
                items.append(
                    {
                        "f12": code,
                        "f14": name,
                        "f3": to_float(row.get("changepercent")),
                        "f6": to_float(row.get("amount")),
                        "f62": 0,
                    }
                )
            time.sleep(0.45)

        if not items:
            raise RuntimeError("AKShare/Sina 全市场分页暂无可用数据")

        print(json.dumps({"items": items, "failedPages": failed_pages}, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({"error": f"AKShare/Sina 数据源暂不可用：{exc}"}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
