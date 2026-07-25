"""写入 tests/test_data.py。

测试覆盖:
- 字段映射完整性(覆盖所有因子依赖)
- is_main_board 主板过滤(SH+60/SZ+00 通过,创业板/科创板/北交所拒绝)
- compute_forward_returns 已知值与无前视偏差
- load_candles 合成 Parquet 加载(用 tmp_path + pyarrow.parquet)
"""
from pathlib import Path

TARGET = Path(r"D:\github_public_repo\评分规则探索\tests")
TARGET.mkdir(parents=True, exist_ok=True)

TEST_DATA_PY = '''"""数据加载层测试。"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from src.data import (
    DUCKDB_TO_PYTHON,
    REQUIRED_KLINE_FIELDS,
    MAIN_BOARD_FILTER_SQL,
    MAIN_BOARD_MARKETS,
    MAIN_BOARD_PREFIXES,
    is_main_board,
    compute_forward_returns,
    load_candles,
    load_candles_for_instrument,
    open_duckdb_session,
    read_current_snapshot,
)
from src.factors.registry import DEFAULT_REGISTRY


class TestFieldMapping:
    """字段映射完整性测试。"""

    def test_duckdb_to_python_covers_all_factor_dependencies(self) -> None:
        """DUCKDB_TO_PYTHON 的 values 必须覆盖所有因子 dependencies。"""
        # 收集所有因子声明的依赖字段
        all_deps: set[str] = set()
        for defn in DEFAULT_REGISTRY.list():
            all_deps.update(defn.dependencies)
        # 因子依赖的 snake_case 字段必须在 DUCKDB_TO_PYTHON.values 中
        python_columns = set(DUCKDB_TO_PYTHON.values())
        missing = all_deps - python_columns
        # dividend_yield 是已知缺失字段(独立数据集,loader 不加载)
        allowed_missing = {"dividend_yield"}
        real_missing = missing - allowed_missing
        assert not real_missing, (
            f"因子依赖但 DUCKDB_TO_PYTHON 缺失映射: {real_missing}"
        )

    def test_required_kline_fields_subset_of_mapping(self) -> None:
        """REQUIRED_KLINE_FIELDS 必须是 DUCKDB_TO_PYTHON.values 的子集。"""
        python_columns = set(DUCKDB_TO_PYTHON.values())
        for f in REQUIRED_KLINE_FIELDS:
            assert f in python_columns, f"REQUIRED_KLINE_FIELDS 含未映射字段: {f}"

    def test_main_board_constants(self) -> None:
        assert MAIN_BOARD_MARKETS == ("SH", "SZ")
        assert MAIN_BOARD_PREFIXES == ("60", "00")
        # SQL 片段必须包含两个市场与两个前缀
        assert "SH" in MAIN_BOARD_FILTER_SQL
        assert "SZ" in MAIN_BOARD_FILTER_SQL
        assert "60%" in MAIN_BOARD_FILTER_SQL
        assert "00%" in MAIN_BOARD_FILTER_SQL


class TestIsMainBoard:
    """主板过滤测试。"""

    def test_sh_60_main_board(self) -> None:
        assert is_main_board("SH", "600000") is True
        assert is_main_board("SH", "601318") is True

    def test_sz_00_main_board(self) -> None:
        assert is_main_board("SZ", "000001") is True
        assert is_main_board("SZ", "000876") is True

    def test_chuangye_board_rejected(self) -> None:
        # 创业板 300 开头
        assert is_main_board("SZ", "300750") is False
        assert is_main_board("SZ", "300059") is False

    def test_kechuang_board_rejected(self) -> None:
        # 科创板 688 开头
        assert is_main_board("SH", "688981") is False
        assert is_main_board("SH", "688009") is False

    def test_beijiao_rejected(self) -> None:
        # 北交所 8xx 开头
        assert is_main_board("BJ", "832000") is False
        assert is_main_board("BJ", "870866") is False

    def test_unknown_market_rejected(self) -> None:
        assert is_main_board("US", "AAPL") is False
        assert is_main_board("", "600000") is False


class TestComputeForwardReturnsKnownValue:
    """已知值测试: 验证 compute_forward_returns 的计算结果正确。"""

    def test_known_value_horizon_5(self) -> None:
        """T 日 open=10/close=11, T+1 open=10.5/close=12, T+5 close=13
        -> forward_return_5d = 13 / 10.5 - 1 ≈ 0.238095
        """
        candles = pd.DataFrame({
            "instrumentKey": ["A"] * 7,
            "tradeDate": [f"2026-07-{i:02d}" for i in range(1, 8)],
            "open":   [10.0, 10.5, 11.0, 11.5, 12.0, 12.5, 13.0],
            "close":  [11.0, 12.0, 11.0, 12.0, 13.0, 12.0, 13.0],
            # 关键: T+5 的 close = 13.0
        })
        # 修改 T+5 的 close 为 13.0
        candles.loc[5, "close"] = 12.0  # T+5 是 index 5? 让我们重新核对
        # 索引: 0=T, 1=T+1, 2=T+2, 3=T+3, 4=T+4, 5=T+5, 6=T+6
        # 我们要 T+5 的 close = 13.0
        candles.loc[5, "close"] = 13.0

        result = compute_forward_returns(candles, horizon=5)
        col = "forward_return_5d"
        assert col in result.columns

        # T (index 0) 的 forward_return_5d = close[T+5] / open[T+1] - 1
        # = candles.loc[5, "close"] / candles.loc[1, "open"] - 1
        # = 13.0 / 10.5 - 1 = 0.238095...
        expected = 13.0 / 10.5 - 1.0
        actual = result.loc[0, col]
        assert math.isclose(actual, expected, rel_tol=1e-9), (
            f"expected {expected}, got {actual}"
        )

    def test_known_value_horizon_1(self) -> None:
        """horizon=1: T 日的 forward_return_1d = close[T+1] / open[T+1] - 1
        """
        candles = pd.DataFrame({
            "instrumentKey": ["A"] * 3,
            "tradeDate": ["2026-07-01", "2026-07-02", "2026-07-03"],
            "open":   [10.0, 10.5, 11.0],
            "close":  [11.0, 12.0, 13.0],
        })
        result = compute_forward_returns(candles, horizon=1)
        # T (index 0): close[T+1]/open[T+1] - 1 = 12.0/10.5 - 1
        expected = 12.0 / 10.5 - 1.0
        actual = result.loc[0, "forward_return_1d"]
        assert math.isclose(actual, expected, rel_tol=1e-9)

    def test_last_horizon_days_are_nan(self) -> None:
        """最后 horizon 个交易日的 forward_return 必须为 NaN(无未来数据)。"""
        candles = pd.DataFrame({
            "instrumentKey": ["A"] * 10,
            "tradeDate": [f"2026-07-{i:02d}" for i in range(1, 11)],
            "open":  list(range(10, 20)),
            "close": list(range(11, 21)),
        })
        result = compute_forward_returns(candles, horizon=3)
        col = result["forward_return_3d"]
        # 最后 3 个交易日(index 7, 8, 9)必须为 NaN
        assert pd.isna(col.iloc[7])
        assert pd.isna(col.iloc[8])
        assert pd.isna(col.iloc[9])
        # 倒数第 4 个(index 6)应该有值
        assert not pd.isna(col.iloc[6])

    def test_multiple_instruments(self) -> None:
        """多股票分组: 每只股票独立计算 forward_return。"""
        candles = pd.DataFrame({
            "instrumentKey": ["A"] * 4 + ["B"] * 4,
            "tradeDate": [f"2026-07-{i:02d}" for i in range(1, 5)] * 2,
            "open":  [10.0, 10.5, 11.0, 11.5] + [20.0, 20.5, 21.0, 21.5],
            "close": [11.0, 12.0, 13.0, 14.0] + [21.0, 22.0, 23.0, 24.0],
        })
        result = compute_forward_returns(candles, horizon=2)
        col = result["forward_return_2d"]
        # A 股 T (index 0): close[T+2]/open[T+1] - 1 = 13.0/10.5 - 1
        a_t0 = result.loc[result["instrumentKey"] == "A"].iloc[0]
        assert math.isclose(a_t0[col.name], 13.0 / 10.5 - 1.0, rel_tol=1e-9)
        # B 股 T (index 0): close[T+2]/open[T+1] - 1 = 23.0/20.5 - 1
        b_t0 = result.loc[result["instrumentKey"] == "B"].iloc[0]
        assert math.isclose(b_t0[col.name], 23.0 / 20.5 - 1.0, rel_tol=1e-9)

    def test_future_open_zero_or_negative_returns_nan(self) -> None:
        """未来开盘价 <= 0 时,forward_return 应为 NaN(防御性)。"""
        candles = pd.DataFrame({
            "instrumentKey": ["A"] * 3,
            "tradeDate": ["2026-07-01", "2026-07-02", "2026-07-03"],
            "open":   [10.0, 0.0, 11.0],  # T+1 open=0
            "close":  [11.0, 12.0, 13.0],
        })
        result = compute_forward_returns(candles, horizon=1)
        # T (index 0): future_open = 0, 应为 NaN
        assert pd.isna(result.loc[0, "forward_return_1d"])

    def test_empty_dataframe(self) -> None:
        empty = pd.DataFrame(columns=["instrumentKey", "tradeDate", "open", "close"])
        result = compute_forward_returns(empty, horizon=5)
        assert "forward_return_5d" in result.columns
        assert len(result) == 0


class TestComputeForwardReturnsNoLookahead:
    """无前视偏差测试: 扩展数据后历史 forward_return 不变。"""

    def test_no_lookahead_when_extending_data(self) -> None:
        """扩展 K 线数据(添加更晚的日期)后,历史日期的 forward_return 不变。"""
        # 短数据: 8 天
        short_candles = pd.DataFrame({
            "instrumentKey": ["A"] * 8,
            "tradeDate": [f"2026-07-{i:02d}" for i in range(1, 9)],
            "open":  [10.0, 10.5, 11.0, 11.5, 12.0, 12.5, 13.0, 13.5],
            "close": [11.0, 12.0, 11.0, 12.0, 13.0, 12.0, 13.0, 14.0],
        })
        short_result = compute_forward_returns(short_candles, horizon=3)

        # 长数据: 在末尾追加 5 天
        ext_candles = pd.concat([
            short_candles,
            pd.DataFrame({
                "instrumentKey": ["A"] * 5,
                "tradeDate": [f"2026-07-{i:02d}" for i in range(9, 14)],
                "open":  [14.0, 14.5, 15.0, 15.5, 16.0],
                "close": [15.0, 14.0, 15.0, 16.0, 17.0],
            }),
        ], ignore_index=True)
        long_result = compute_forward_returns(ext_candles, horizon=3)

        # 短数据前 5 天(0~4)的 forward_return 应与长数据完全一致
        col = "forward_return_3d"
        for i in range(5):
            short_v = short_result.loc[i, col]
            long_v = long_result.loc[i, col]
            if pd.isna(short_v):
                assert pd.isna(long_v), f"index {i}: short=NaN but long={long_v}"
            else:
                assert math.isclose(short_v, long_v, rel_tol=1e-12), (
                    f"index {i}: short={short_v} != long={long_v} (前视偏差!)"
                )

    def test_no_lookahead_when_adding_more_instruments(self) -> None:
        """增加更多股票不应影响已有股票的 forward_return。"""
        base = pd.DataFrame({
            "instrumentKey": ["A"] * 5,
            "tradeDate": [f"2026-07-{i:02d}" for i in range(1, 6)],
            "open":  [10.0, 10.5, 11.0, 11.5, 12.0],
            "close": [11.0, 12.0, 11.0, 12.0, 13.0],
        })
        base_result = compute_forward_returns(base, horizon=2)

        # 加入新股票 B
        extended = pd.concat([
            base,
            pd.DataFrame({
                "instrumentKey": ["B"] * 5,
                "tradeDate": [f"2026-07-{i:02d}" for i in range(1, 6)],
                "open":  [20.0, 20.5, 21.0, 21.5, 22.0],
                "close": [21.0, 22.0, 21.0, 22.0, 23.0],
            }),
        ], ignore_index=True)
        ext_result = compute_forward_returns(extended, horizon=2)

        # A 股的 forward_return 应保持不变
        a_short = base_result[base_result["instrumentKey"] == "A"].reset_index(drop=True)
        a_long = ext_result[ext_result["instrumentKey"] == "A"].reset_index(drop=True)
        col = "forward_return_2d"
        for i in range(len(a_short)):
            if pd.isna(a_short.loc[i, col]):
                assert pd.isna(a_long.loc[i, col])
            else:
                assert math.isclose(
                    a_short.loc[i, col], a_long.loc[i, col], rel_tol=1e-12
                ), f"A index {i}: {a_short.loc[i, col]} vs {a_long.loc[i, col]}"


def _write_synthetic_snapshot(root: Path, snapshot_id: str = "test-snap") -> None:
    """在 root 下构造一个小型合成快照(5 股 × 30 日)。"""
    snap_dir = root / snapshot_id
    bars_dir = snap_dir / "bars" / "year=2026"
    bars_dir.mkdir(parents=True, exist_ok=True)

    np.random.seed(42)
    instruments = [
        ("SH600001", "SH", "600001", "A股1"),
        ("SH600002", "SH", "600002", "A股2"),
        ("SZ000001", "SZ", "000001", "B股1"),
        ("SZ000002", "SZ", "000002", "B股2"),
        ("SZ300001", "SZ", "300001", "创业板"),  # 不应被主板过滤通过
    ]
    dates = pd.date_range("2026-06-01", periods=30, freq="B").strftime("%Y-%m-%d")

    rows = []
    for inst_key, market, symbol, name in instruments:
        price = 10.0
        for d in dates:
            ret = np.random.randn() * 0.02
            open_ = price
            close = open_ * (1 + ret)
            high = max(open_, close) * (1 + abs(np.random.randn()) * 0.005)
            low = min(open_, close) * (1 - abs(np.random.randn()) * 0.005)
            volume = int(1_000_000 + np.random.randn() * 200_000)
            amount = volume * close  # >= 1M,远高于 1000 万过滤阈值
            rows.append({
                "instrumentKey": inst_key,
                "market": market,
                "symbol": symbol,
                "name": name,
                "industry": "测试",
                "tradeDate": d,
                "open": open_,
                "high": high,
                "low": low,
                "close": close,
                "volume": volume,
                "amount": amount,
                "turnoverRatePct": 1.0,
                "totalMarketCap": 1e10,
                "floatMarketCap": 5e9,
                "peTtm": 15.0,
                "pb": 2.0,
                "psTtm": 3.0,
            })
            price = close

    df = pd.DataFrame(rows)
    # 写 Parquet (Hive 分区: year=2026/data.parquet)
    table = pa.Table.from_pandas(df, preserve_index=False)
    pq.write_table(table, bars_dir / "data.parquet")

    # 写 manifest.json
    manifest = {
        "schemaVersion": 1,
        "snapshotId": snapshot_id,
        "status": "validated",
        "rowCount": len(df),
        "instrumentCount": len(instruments),
        "minDate": dates[0],
        "maxDate": dates[-1],
        "partitions": [
            {
                "year": 2026,
                "relativePath": "bars/year=2026/data.parquet",
                "rows": len(df),
                "bytes": 0,
                "minDate": dates[0],
                "maxDate": dates[-1],
                "sha256": "",
            }
        ],
        "datasets": [],
    }
    with open(snap_dir / "manifest.json", "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False)

    # 写 current.json
    with open(root / "current.json", "w", encoding="utf-8") as f:
        json.dump({"snapshotId": snapshot_id, "publishedAt": "2026-07-24T10:00:00Z"}, f)


class TestReadCurrentSnapshot:
    """read_current_snapshot 测试。"""

    def test_read_synthetic_snapshot(self, tmp_path: Path) -> None:
        _write_synthetic_snapshot(tmp_path)
        info = read_current_snapshot(tmp_path)
        assert info.snapshot_id == "test-snap"
        assert info.manifest["status"] == "validated"
        assert info.manifest["rowCount"] == 150  # 5 instruments * 30 days
        assert "test-snap" in info.bars_glob
        assert "year=*" in info.bars_glob

    def test_missing_current_json_raises(self, tmp_path: Path) -> None:
        with pytest.raises(FileNotFoundError, match="current.json"):
            read_current_snapshot(tmp_path)

    def test_invalid_status_raises(self, tmp_path: Path) -> None:
        # 写一个状态非 validated 的快照
        snap_id = "bad-snap"
        snap_dir = tmp_path / snap_id
        snap_dir.mkdir(parents=True)
        with open(snap_dir / "manifest.json", "w") as f:
            json.dump({
                "schemaVersion": 1, "snapshotId": snap_id, "status": "draft"
            }, f)
        with open(tmp_path / "current.json", "w") as f:
            json.dump({"snapshotId": snap_id, "publishedAt": "2026-01-01"}, f)
        with pytest.raises(ValueError, match="validated"):
            read_current_snapshot(tmp_path)

    def test_unsupported_schema_version_raises(self, tmp_path: Path) -> None:
        snap_id = "v2-snap"
        snap_dir = tmp_path / snap_id
        snap_dir.mkdir(parents=True)
        with open(snap_dir / "manifest.json", "w") as f:
            json.dump({
                "schemaVersion": 2, "snapshotId": snap_id, "status": "validated"
            }, f)
        with open(tmp_path / "current.json", "w") as f:
            json.dump({"snapshotId": snap_id, "publishedAt": "2026-01-01"}, f)
        with pytest.raises(ValueError, match="schemaVersion"):
            read_current_snapshot(tmp_path)


class TestLoadCandlesSynthetic:
    """load_candles 用合成 Parquet 测试。"""

    @pytest.fixture
    def synthetic_session(self, tmp_path: Path):
        _write_synthetic_snapshot(tmp_path)
        with open_duckdb_session(tmp_path, threads=2, max_memory="512MB") as session:
            yield session

    def test_load_candles_shape_and_columns(self, synthetic_session) -> None:
        df = load_candles(
            synthetic_session,
            start_date="2026-06-01",
            end_date="2026-06-30",
            min_daily_amount=0,  # 不过滤流动性
        )
        # 5 股 × 30 日 = 150 行; 创业板 300001 应被过滤掉 -> 4 股 × 30 日 = 120 行
        assert len(df) == 120
        # 列已转为 snake_case
        expected_cols = {
            "instrumentKey", "market", "symbol", "name", "industry",
            "tradeDate", "open", "high", "low", "close", "volume", "amount",
            "turnover_rate", "market_cap", "float_market_cap",
            "pe_ttm", "pb", "ps_ttm",
        }
        assert expected_cols.issubset(set(df.columns))

    def test_load_candles_filters_chuangye(self, synthetic_session) -> None:
        """创业板 300001 应被过滤掉。"""
        df = load_candles(
            synthetic_session,
            start_date="2026-06-01",
            end_date="2026-06-30",
            min_daily_amount=0,
        )
        symbols = df["symbol"].unique()
        assert "300001" not in symbols
        assert "600001" in symbols
        assert "000001" in symbols

    def test_load_candles_date_range(self, synthetic_session) -> None:
        df = load_candles(
            synthetic_session,
            start_date="2026-06-15",
            end_date="2026-06-20",
            min_daily_amount=0,
        )
        dates = set(df["tradeDate"].unique())
        # 应只包含 06-15 ~ 06-20 之间的工作日
        for d in dates:
            assert "2026-06-15" <= d <= "2026-06-20"

    def test_load_candles_amount_filter(self, synthetic_session) -> None:
        """amount 过滤: 设高阈值应过滤掉所有数据。"""
        df = load_candles(
            synthetic_session,
            start_date="2026-06-01",
            end_date="2026-06-30",
            min_daily_amount=1e15,  # 极高,应过滤掉全部
        )
        assert len(df) == 0

    def test_load_candles_ordered_by_instrument_date(self, synthetic_session) -> None:
        df = load_candles(
            synthetic_session,
            start_date="2026-06-01",
            end_date="2026-06-30",
            min_daily_amount=0,
        )
        # 应按 instrumentKey, tradeDate 升序
        df_reset = df.reset_index(drop=True)
        for i in range(1, len(df_reset)):
            prev = df_reset.loc[i - 1, ["instrumentKey", "tradeDate"]]
            curr = df_reset.loc[i, ["instrumentKey", "tradeDate"]]
            if prev["instrumentKey"] == curr["instrumentKey"]:
                assert prev["tradeDate"] <= curr["tradeDate"], (
                    f"tradeDate 非升序: {prev['tradeDate']} > {curr['tradeDate']}"
                )

    def test_load_candles_for_instrument(self, synthetic_session) -> None:
        """单股加载: lookback_days 控制返回行数。"""
        df = load_candles_for_instrument(
            synthetic_session,
            instrument_key="SH600001",
            end_date="2026-06-30",
            lookback_days=5,
        )
        assert len(df) == 5
        # 应按 tradeDate 升序
        dates = df["tradeDate"].tolist()
        assert dates == sorted(dates)
        # 全部 <= end_date
        for d in dates:
            assert d <= "2026-06-30"

    def test_load_candles_for_instrument_unknown(self, synthetic_session) -> None:
        """未知股票应返回空 DataFrame。"""
        df = load_candles_for_instrument(
            synthetic_session,
            instrument_key="UNKNOWN999",
            end_date="2026-06-30",
            lookback_days=5,
        )
        assert len(df) == 0


class TestDuckDBSessionContextManager:
    """DuckDBSession 上下文管理器测试。"""

    def test_context_manager_closes(self, tmp_path: Path) -> None:
        _write_synthetic_snapshot(tmp_path)
        with open_duckdb_session(tmp_path) as session:
            assert session.bars_glob is not None
            # 简单查询
            df = load_candles(
                session, "2026-06-01", "2026-06-30", min_daily_amount=0
            )
            assert len(df) > 0
        # 退出后连接应已关闭
        # (后续访问会失败,但我们不在这里测试,因为可能引发段错误)

    def test_session_with_explicit_snapshot_id(self, tmp_path: Path) -> None:
        _write_synthetic_snapshot(tmp_path, snapshot_id="explicit-id")
        with open_duckdb_session(tmp_path, snapshot_id="explicit-id") as session:
            assert session.snapshot.snapshot_id == "explicit-id"
'''


def main() -> None:
    path = TARGET / "test_data.py"
    path.write_text(TEST_DATA_PY, encoding="utf-8")
    print(f"wrote {path} ({len(TEST_DATA_PY)} bytes)")


if __name__ == "__main__":
    main()
