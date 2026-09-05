---
name: local-duckdb-research
description: Use this repository's DuckDB CLI to inspect, query, analyze, or export published daily research snapshots and the local one-minute Parquet lake. Apply to ad hoc SQL, factors, pipelines, batches, and local research artifacts; do not use it to update authoritative market data.
---

# Local DuckDB Research

Run commands from `D:\github_public_repo\量化回测\server`. Treat the CLI as a read-only research layer over published Parquet; a request to query or export data does not authorize data ingestion, snapshot publishing, scheduled-task changes, or edits to upstream MySQL/Parquet data.

## Rules

1. **R1 — Discover before assuming.** Run `npm run duckdb -- help`, then use `status`, `views`, and `schema --view <name>` as needed. A view may be absent from an older snapshot. `status.maxDate` describes `bars`, not every reference view.
2. **R2 — Use the narrowest interface.** Use `query` for ad hoc SQL, `recipe` for built-in factor/layer/time-series work, `minute` for standard minute aggregation, `pipeline` for dependent same-connection steps or multi-output research, and `batch` for one SQL shape over many parameter sets.
3. **R3 — Build commands correctly.** Put the subcommand before its options. Prefer `$name` SQL parameters with repeated `--param name=value` or `--params-file`; keep zero-padded stock codes parameterized. Put multiline or multi-statement SQL in a file. CLI parameters override a parameter file; step parameters override CLI and pipeline parameters.
4. **R4 — Check complex work before running it.** Use `--dry-run` for recipes, pipelines, batches, and unfamiliar large queries. Use `--transaction` when dependent multi-statement work must be atomic. Do not add `--continue-on-error` unless partial batch completion is useful to the user.
5. **R5 — Preserve financial meaning.** Keep meaningful `NULL` values unless the requested analysis defines an imputation. Adjust prices with `raw_price * factor + priceOffset`. Lock index constituents to one `snapshotId` or an effective date. Treat dividend amounts as per-share and an empty dividend result as unknown until coverage is checked. Treat SW2021 industries as industries, not concept themes.
6. **R6 — Handle minute data through its catalog.** Prefer `minute`, which resolves exchange suffixes, manifest-selected files, sessions, and 240/241-row normalization. For raw SQL, use forward-slash absolute paths, scan exact days or narrow month globs, filter by `code` and time, use `trade_time` rather than row number, and never include `.partial` files. `vol` is shares and `amount` is currency.
7. **R7 — Respect the unmanaged-glob guard.** Prefer registered views or `minute`. Use `--allow-unmanaged-parquet-glob` only when the user intentionally asks to query an external/unmanaged Parquet glob and accepts that it is outside the published manifest.
8. **R8 — Bound resource use and outputs.** Select only needed columns and dates. Use CSV or Parquet files for large results; table/JSON output is for small results. Use `--threads` and `--max-memory` when warranted. Keep `splitBy`/`--split-by-symbol` under `--max-output-files`; prefer partitioned Parquet over thousands of small CSV files.
9. **R9 — Preserve provenance and completed files.** Keep generated research manifests beside pipeline/batch outputs. The CLI writes through `.partial` paths and avoids overwriting an occupied/existing target; report the actual generated filename. Never treat a scan estimate as exact bytes read after predicate pushdown.
10. **R10 — Choose persistence deliberately.** A view over a path sees matching files on later queries; `CREATE TABLE AS` and CSV/JSON exports are static copies. Use a persistent `--db` only when the user needs reusable views, frozen inputs, or cached intermediate results, and record the source snapshot/date for materialized research.

## Execution pattern

1. Inspect availability and field names instead of relying on remembered schemas.
2. State the selected snapshot/date range and material assumptions.
3. Dry-run complex or broad work, then execute only the requested query/export.
4. Validate row counts, date bounds, null behavior, and output paths; for pipeline/batch outputs, retain the manifest.

For uncommon CLI syntax and domain examples, read [`../../../doc/02-因子研究与查询/LOCAL_DUCKDB_CLI_GUIDE.md`](../../../doc/02-因子研究与查询/LOCAL_DUCKDB_CLI_GUIDE.md) only as reference material. Verify details against current `help`, `views`, and `schema` output before acting.
