"""检查 DuckDB 快照 parquet 文件的实际字段。"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, r"D:\github_public_repo\评分规则探索")

from src.data.connection import open_duckdb_session


def main() -> None:
    snapshot_root = Path(r"D:/github_public_repo/量化回测/server/data/research-snapshots")
    session = open_duckdb_session(snapshot_root)
    print(f"快照 ID: {session.snapshot.snapshot_id}")
    print(f"bars_glob: {session.bars_glob}")

    # 用 DESCRIBE 查询字段
    sql = f"DESCRIBE SELECT * FROM read_parquet('{session.bars_glob}', hive_partitioning=true) LIMIT 1"
    df = session.execute_df(sql, [])
    print("\nParquet 字段列表:")
    for _, row in df.iterrows():
        print(f"  {row['column_name']:30s} {row['column_type']}")


if __name__ == "__main__":
    main()
