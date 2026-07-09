import json
import math
import sys
import warnings

warnings.filterwarnings("ignore")


def to_float(value):
    try:
        if value is None or (isinstance(value, float) and math.isnan(value)):
            return None
        parsed = float(value)
        return parsed if math.isfinite(parsed) else None
    except Exception:
        return None


def main():
    try:
        import akshare as ak
        import pandas as pd

        symbol = sys.argv[1] if len(sys.argv) > 1 else ""
        start_date = sys.argv[2] if len(sys.argv) > 2 else "20100101"
        end_date = sys.argv[3] if len(sys.argv) > 3 else "20500101"
        if not symbol:
            raise ValueError("缺少股票代码参数")

        # 新浪历史日频接口自带 turnover（换手率）字段，与东方财富不同源，
        # 用于在东财 K 线接口降级时补全历史每日换手率。
        df = ak.stock_zh_a_daily(symbol=symbol, start_date=start_date, end_date=end_date, adjust="")
        items = []
        for _, row in df.iterrows():
            raw_date = row.get("date")
            if isinstance(raw_date, pd.Timestamp):
                date_str = raw_date.strftime("%Y-%m-%d")
            else:
                date_str = str(raw_date)[:10]
            items.append({"date": date_str, "turnover_rate": to_float(row.get("turnover"))})
        print(json.dumps({"items": items}, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({"error": f"Akshare 换手率数据源暂不可用：{exc}"}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
