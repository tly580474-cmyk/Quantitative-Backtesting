# Stock fund-flow pipeline

This pipeline stores daily A-share fund flow in `stock_fund_flows`.

- Historical backfill: Tinyshare `moneyflow`, from 2010 onward.
- Daily incremental update: AKShare `stock_individual_fund_flow_rank(indicator="今日")` after market close.
- Amount columns are normalized to yuan.
- `main_net_in` for Tinyshare history is derived as `large_net_in + super_large_net_in`.
- `provider_net_in` preserves Tinyshare's `net_mf_amount`; it is not treated as main net inflow.
- `source_key` and `source_version` must be retained because Tinyshare and Eastmoney/AKShare use different provider methodologies.

Commands:

```powershell
npm run db:migrate
npm run fund-flow:backfill
npm run fund-flow:update
npm run fund-flow:test
npm run fund-flow:schedule:register
```

The backfill is idempotent and resumable. Per-date source coverage and failures are recorded in
`fund_flow_sync_dates`; live progress is written to `.logs/fund-flow/progress.json`.

The Windows scheduled task runs at `FUND_FLOW_UPDATE_TIME` and retries at
`FUND_FLOW_RETRY_TIME`. The defaults are 16:20 and 17:20 Asia/Shanghai time.
