# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Frontend (business UI at localhost:5558)
npm run dev           # Start Vite dev server at localhost:5558 (strictPort)
npm run build         # TypeScript check (tsc -b) + Vite production build
npm run preview       # Preview production build at localhost:5558
npm test              # Run all tests (Vitest)
npm run test:watch    # Watch mode for tests

# Admin console (operations UI at localhost:5559, separate Vite config)
npm run admin:dev     # Start admin Vite dev server at localhost:5559
npm run admin:build   # TypeScript check + build admin bundle
npm run admin:preview # Preview admin production build

# Run a single test file
npx vitest run src/features/backtest/__tests__/engine.test.ts

# Backend (Fastify at localhost:3001)
cd server
npm run dev           # Start Fastify server at localhost:3001 (tsx watch)
npm start             # Production start (tsx src/app.ts)
npm run typecheck     # TypeScript check (tsc --noEmit)
npm run build         # Compile with tsc
npm test              # Run server tests (vitest run src)
npm run db:migrate    # Run SQL migrations manually

# Phase 5.5: History import (CSV/OHLCV into MySQL daily_candles)
cd server && npm run import:history -- --source "<path>" --limit 10 --dry-run
cd server && npm run import:factors -- --source "<path>" --dry-run
cd server && npm run benchmark:history

# Phase 5.5: Research snapshot management (MySQL → Parquet for DuckDB)
cd server && npm run snapshot:build
cd server && npm run snapshot:publish
cd server && npm run snapshot:verify
cd server && npm run snapshot:freshness
cd server && npm run snapshot:benchmark
cd server && npm run snapshot:schedule:register  # Register Windows scheduled task

# Phase 5.5: Data governance (research artifacts & DuckDB)
cd server && npm run data:gate              # Data health gate check
cd server && npm run data:coverage          # Data coverage matrix audit
cd server && npm run data:reconcile         # Data reconciliation
cd server && npm run research:artifacts:prune  # Prune stale research artifacts
cd server && npm run parquet:compact        # Compact Parquet snapshot files
cd server && npm run factor:materializations:archive  # Archive materialized factor artifacts
cd server && npm run duckdb                 # DuckDB CLI

# Phase 5.5: Backup (MySQL dump + snapshot Parquet)
cd server && npm run backup:create
cd server && npm run backup:verify -- --path ./data/backups/<backup-id>
cd server && npm run backup:restore-check -- --path ./data/backups/<backup-id> --database quant_backtest_restore_check --confirm-drop quant_backtest_restore_check --cleanup true

# Phase 6: Factor research
cd server && npm run factor:list
cd server && npm run factor:run -- --factor momentum_20 --start 2026-05-01 --end 2026-06-30 --horizon 5 --layers 5
cd server && npm run factor:composite -- --factors momentum_20,reversal_5 --start 2026-06-01 --end 2026-06-20 --validationStart 2026-06-11 --horizon 5 --layers 5
cd server && npm run factor:composite -- --factors momentum_20,reversal_5 --start 2026-06-01 --end 2026-06-20 --validationStart 2026-06-11 --weighting ic --horizon 5 --layers 5
cd server && npm run factor:composite -- --factors momentum_20,reversal_5 --start 2026-06-01 --end 2026-06-20 --weighting manual --weights momentum_20:2,reversal_5:-1 --horizon 5 --layers 5

# Admin diagnostics
cd server && npm run admin:diagnostics

# Reference data (Python: index constituents, dividends, SW industry)
cd server && npm run reference:status       # Reference data status overview
cd server && npm run index:update           # Update index daily bars
cd server && npm run index:backfill         # Full backfill index history
cd server && npm run index:constituents:update   # Update index constituents
cd server && npm run index:constituents:dry-run  # Dry-run constituents update
cd server && npm run index:test             # Run reference data Python tests
cd server && npm run dividend:update        # Update dividend events (batch)
cd server && npm run dividend:probe         # Probe single symbol dividend
cd server && npm run sw-industry:update     # Update SW (申万) industry data
cd server && npm run sw-industry:dry-run    # Dry-run SW industry update

# Minute data (Python: TDX import + online update)
cd server && npm run minute:prepare         # Prepare minute data pipeline
cd server && npm run minute:update          # Update minute data
cd server && npm run minute:tdx:import      # Import minute data from TDX
cd server && npm run minute:online:update   # Online minute data update
cd server && npm run minute:schedule:register  # Register Windows scheduled task
cd server && npm run minute:test            # Run minute data Python tests
```

Start both frontend and backend together: double-click `start.bat` (Windows) or run `scripts/start-dev.ps1`. Three services run by default: business frontend (5558), admin console (5559), backend API (3001).

## Tech Stack

### Frontend (business UI at `src/`)
- **React 19** + TypeScript 6, Vite (dev server at localhost:5558)
- **React Router 7** (HashRouter) for client-side routing, pages are lazy-loaded
- **Ant Design 6** with Chinese locale (zhCN) and @ant-design/icons
- **TradingView Lightweight Charts 5** for K-line and indicator charts
- **Zustand 5** + Immer for state management (7 domain stores)
- **Dexie 4** (IndexedDB) for local data persistence (schema v4)
- **SheetJS (xlsx)** for Excel parsing
- **React Markdown** + remark-gfm for rendering AI-generated reports
- **@xyflow/react** + dagre for visual strategy node editor
- **Zod 4** for validation
- **Vitest** + happy-dom for testing
- **Path alias**: `@/` maps to `src/`
- Manual vendor chunk splitting: `vendor-react`, `vendor-antd`, `vendor-charts`, `vendor-flow`, `vendor-data`

### Admin Console (operations UI at `admin/`)
- Separate React + Vite app (dev server at localhost:5559, own `vite.config.ts` and `tsconfig.json`)
- Bearer token auth (`ADMIN_API_TOKEN`), three sections: overview, diagnostics, configuration
- 15 editable config items grouped by access/database/ai/market/runtime categories
- Calls backend `/api/admin/*` endpoints

### Backend (`server/`)
- **Fastify 5** + TypeScript 5, run with tsx (bodyLimit 100MB, CORS localhost-only)
- **Drizzle ORM** + MySQL2 for server-side persistence (24 SQL migrations)
- **DuckDB** (`@duckdb/node-api`) as embedded OLAP engine for factor research and snapshot queries
- **OpenAI SDK** for AI strategy generation and stock research agent
- **Zod 4** for config validation, route schemas, and drizzle-zod
- **Python toolchain** for reference data (index constituents/dividends/SW industry) and minute data (TDX import/online update)
- Market data from 腾讯财经, 东方财富, and 巨潮资讯

## Project Structure

```
src/
  models/            TypeScript interfaces (Candle, BacktestResult, Strategy, Trade, etc.)
  components/        Shared UI components (AppLayout, FileUploader, IndicatorPanel)
  api/               Frontend API client, IndexedDB/API repository abstraction (IDataRepository)
  features/
    import/          Excel/CSV parsing, header mapping (Chinese-English), validation
    chart/           K-line chart with lightweight-charts, crosshair details, indicator panes, range lines
    indicators/      18 technical indicators (SMA, EMA, BOLL, MACD, RSI, KDJ, ATR, CCI, WR, OBV,
                     volumeMa, highLowBreakout, drawdown, bias, volatility, volCluster, hold, reversal)
    strategies/      Strategy protocol + 8 built-in strategies (dualMa, rsi, macd, boll, smaCross,
                     volatility, reversal, compositeFactor) + multi-factor synthesis
    visualStrategies/ Visual node-based strategy editor, DSL v1.0 (Zod-validated), compiler, validator, explainer
    strategyStudio/  Node-based strategy editor (@xyflow/react) with undo/redo, import/export, preview
    aiStrategy/      AI strategy generation client (calls /api/ai/*) + local mock
    backtest/        Engine, broker, portfolio, metrics, validation, version, Worker hook
    backtestResults/ Results overview, equity curve chart, trade list, multi-result comparison
    dataLibrary/     Dataset management UI (save, open, delete, export from IndexedDB)
    marketData/      Watchlist, real-time quotes, K-line, 7-layer data, research reports, AI agent,
                     chip profile, hot sectors, stock selection score, data quality/sync modals
    factorResearch/  Factor research UI: catalog, single/composite runs, IC/ICIR/layer reports,
                     automated mining panel, snapshot freshness
  stores/            Zustand stores (candle, chart, indicator, backtest, strategy,
                     dataLibraryView, strategyStudio)
  workers/           Web Worker for async backtest execution + strategy preview (T signal → T+1 open)
  db/                Dexie database schema v4 and repositories (datasets, candles, results, visualStrategies)
  utils/             General utilities (checksum, date, fingerprint, number, random, rangeChange)

admin/               Independent admin console (React + Vite, port 5559)
  src/
    App.tsx          Overview/diagnostics/configuration sections
    api.ts           Calls /api/admin/* endpoints
    types.ts, styles.css

server/src/
  app.ts             Fastify server entry point, route registration, scheduler startup, graceful shutdown
  config.ts          Zod-validated env config (DB, AI, market data, minute data, factor miner, admin)
  admin/             Admin API: diagnostics, env config editor, overview TTL cache, metrics history
  marketData/
    providers/       Data source adapters (Tencent, primary, registry) — plugin pattern
    normalization/   Symbol mapping, candle normalization, adjustment (v1 + v2 history)
    quality/         Data quality checks, anomaly detection, calendar validation
    repositories/    Instrument, market data, calendar, sync job, data quality, history store policy
    jobs/            Sync scheduler, executor, index dataset updater, adjustment/factor refresh,
                     job lock, market session, retry policy, scheduler time
    aStockDataService.ts    Stock quote, search, K-line (Tencent + East Money)
    sevenLayerDataService.ts Seven-layer data: quotes, research, signals, capital,
                             fundamental, announcements, news
    hotSectorService.ts, marketTechnicalScreen.ts, marketBreadth
    *.py             Python helper scripts (akshare market snapshot, turnover rate)
  routes/            Fastify route modules (admin, aiStrategies, dataQuality, datasets, export,
                     factorResearch, instruments, marketData, results, strategyConfigs, syncJobs,
                     visualStrategies)
  services/          AI stock research agent, data service (Drizzle CRUD)
    strategyGeneration/ OpenAI + mock providers, prompt templates, schema
  db/                MySQL/Drizzle schema (~706 lines, 24 migrations), connection pool, migrate CLI
  research/          Phase 5.5: snapshot builder, DuckDB query service, manifest/freshness/verifier,
                     CLI tools + data governance (coverage matrix, health gate, reconciliation),
                     artifact lifecycle/prune, Parquet compaction, materialized artifact health
  historyImport/     Phase 5.5: CSV/factor batch importer into MySQL
  backup/            Phase 5.5: MySQL dump + snapshot backup, verify, restore-check
  factorResearch/    Phase 6: factor definitions (AST), compiler, evaluator, single/composite runner,
                     repository, CLI + candidates (state machine) + mining (scheduler + Python worker)
                     + materialization (offline complex factor computation)
  referenceData/     Python: index constituents/dividends/SW industry reference data maintenance
  minuteData/        Python: minute data lake (TDX import, online update, prepare pipeline)
  validation/        Shared error codes and API error helpers
```

## Architecture Highlights

### Data Flow
1. **Excel Import**: SheetJS parses `.xlsx` → `headerMapper` maps Chinese/English column names → `parser` produces `Candle[]` → `validator` checks dates, OHLC, duplicates
2. **Storage**: Candles saved to Dexie/IndexedDB via `marketDataRepository` (or MySQL via server API)
3. **Chart**: `ChartContainer` reads candles from `useCandleStore`, renders with lightweight-charts, overlays indicator series and signal markers
4. **Backtest**: UI sends request via `useBacktest` hook → Web Worker → `runBacktestAsync` engine → fills orders via `broker.ts` → tracks portfolio via `portfolio.ts` → computes metrics via `metrics.ts` → returns `BacktestResult` → saves to IndexedDB

### Server Architecture
- **Fastify** with CORS at `localhost:3001` (localhost-only), `bodyLimit: 100MB`
- Routes registered in `app.ts` by calling `register*Routes(fastify)` functions; route registration is conditional on config (e.g. market data routes only if `MARKET_DATA_ENABLED`)
- **Startup flow**: loadConfig → configure history store policy → init AI provider → MySQL connect/migrate → recover interrupted candidate tests → register routes → start schedulers (sync, index dataset, factor mining)
- Market data providers follow a plugin pattern: register with `providerRegistry`, implement the `MarketDataProvider` interface
- **PrimaryProvider** wraps any provider with rate limiting and retry logic
- **TencentProvider** is the main data source (quotes, K-line, search); East Money provides industry, research reports, and fundamentals
- AI services use the OpenAI Chat Completions spec — works with OpenAI, DeepSeek, or any compatible endpoint
- Config is loaded via `dotenv` + Zod schema at startup (`server/src/config.ts`)
- **Graceful shutdown**: stops sync/index/mining schedulers, closes app/db/pool

### Admin Console (`server/src/admin/` + `admin/`)
- **Auth**: Bearer token via `timingSafeEqual` against `ADMIN_API_TOKEN`; returns 503 if token unset
- **Diagnostics** (`diagnostics.ts`): `collectAdminOverview` (full: DB/storage/tasks/governance/config) + `collectAdminHealth` (lightweight, for high-frequency polling); severity levels `healthy/warning/critical/disabled`
- **Env Config** (`envConfig.ts`): 15 editable config definitions across 5 categories (access/database/ai/market/runtime); `listAdminConfig` masks secrets; `updateEnvFile` atomically writes `server/.env` with validation (port, concurrency 1-8, capacity format)
- **Overview Cache** (`overviewCache.ts`): TTL cache (default 10s), degrades to stale frame on error
- **Metrics History** (`metricsHistory.ts`): samples rss/heap/DB latency/DuckDB active+queued/disk/task failures

### Data Governance (`server/src/research/` data governance modules)
- **Data Coverage Matrix** (`dataCoverageMatrix.ts`): multi-domain coverage audit across data sources
- **Data Health Gate** (`dataHealthGate.ts`): gate checks that block operations on unhealthy data
- **Data Reconciliation** (`dataReconciliation.ts`): cross-source reconciliation
- **Artifact Lifecycle** (`artifactLifecycle.ts`): prune stale research artifacts
- **Parquet Compaction** (`parquetCompactCli.ts`): compact Parquet snapshot files
- **Materialized Artifact Health** (`materializedArtifactHealth.ts`): health check + archive for materialized factor artifacts

### Research Snapshot System (Phase 5.5)
- **Purpose**: Create immutable, versioned Parquet snapshots from MySQL `daily_candles` for high-performance analytical queries via DuckDB.
- **Pipeline**: MySQL `daily_candles` → `snapshotBuilder.ts` builds Parquet partitions with manifest → `snapshotVerifier.ts` validates checksums → `publishCli.ts` promotes to current.
- **DuckDB Research Service** (`research/duckdbResearchService.ts`): Compiles research queries to SQL, executes against Parquet snapshots via `@duckdb/node-api`. Supports K-line fields plus derived metrics (PE TTM, PB, PS TTM, volume ratio).
- **Snapshot Freshness** (`research/snapshotFreshness.ts`): Guards factor research routes — rejects requests if the current snapshot is stale.
- **Manifest** (`research/snapshotManifest.ts`): Tracks snapshot ID, source version, date range, SHA-256 checksums.

### History Import System (Phase 5.5)
- **Bulk CSV Import** (`historyImport/importer.ts`): Imports historical OHLCV data from CSV files into MySQL `daily_candles`. Supports dry-run mode.
- **Factor Import** (`historyImport/factorImporter.ts`): Bulk-inserts factor values into MySQL factor tables, likely using DuckDB for efficient loading.
- Both have CLI interfaces and support `--dry-run`, `--limit`, and path configuration.

### Backup System (Phase 5.5)
- **Create**: Dumps MySQL via `mysqldump`, copies current research snapshot Parquet files and manifest.
- **Verify**: Validates backup integrity via checksums and SHA-256.
- **Restore-check**: Restores dump to a temporary `_restore_check` database, validates row counts and max date, optionally cleans up. Safe production dry-run.

### Factor Research System (Phase 6)
Located in `server/src/factorResearch/`:
- **Definitions** (`definitions/`): Factor schema types (`FactorDefinition`, `FactorRunConfig`, `CompositeFactorRunConfig`, `FactorAstNode` AST), built-in factor catalog, validator, AST materialization detection.
- **Engine** (`engine/`):
  - `factorCompiler.ts` — compiles factor definitions into executable logic
  - `evaluator.ts` — evaluates a single factor against market data (via DuckDB on research snapshots)
  - `factorRunner.ts` — orchestrates single-factor research runs; computes IC, rank IC, ICIR, layer returns; includes `auditFactorCorrelations`/`auditFactorDecay`
  - `compositeRunner.ts` — runs multi-factor research with weighting strategies: `equal`, `ic`, `rankIc`, `manual`
- **Repository** (`repositories/factorRepository.ts`): Persists factor run results to MySQL, lists factor catalog, syncs built-in factors.
- **Route** (`routes/factorResearch.ts`): `/api/factors`, `/api/factor-runs` (CRUD + cancel/retry/interpret), `/api/factor-composites`, `/api/factor-candidates` (CRUD + freeze/test/approve/reject/publish), `/api/factor-mining-tasks` (CRUD + start/resume/cancel/archive/trace), `/api/factor-mining-schedules`; guarded by snapshot freshness check.
- **Factor types**: `higher-is-better`, `lower-is-better`, `research`. Dependencies include open/high/low/close/previousClose/volume/amount/turnoverRatePct.
- **Composite weighting**: `equal`, `ic` (information coefficient), `rankIc`, `manual` (user-specified weights).

### Factor Candidate Workflow (`factorResearch/candidates/`)
- **Candidate Repository** (`candidateRepository.ts`): CRUD + state transitions for candidate factors
- **State Machine** (`candidateState.ts`): `draft → frozen → testing → tested → approved/rejected → published`
- **Publish Gate** (`candidateGate.ts`): evaluates readiness before publishing a candidate
- **Locked Test Validation** (`lockedTestValidation.ts`): lineage/coverage validation with `MIN_LOCKED_TEST_SAMPLES`/`MIN_LOCKED_TEST_TRADING_DAYS` thresholds

### Factor Mining (`factorResearch/mining/`)
- **Mining Scheduler** (`miningScheduler.ts`): default 5-min tick; auto-starts mining tasks when a new snapshot is published per schedule
- **Mining Worker** (`miningWorker.ts`): invokes external Python `factor-miner` (`FACTOR_MINER_ROOT`); supports `startMiningWorker`/`cancelMiningWorker`; configurable timeout (`FACTOR_MINER_TIMEOUT_MS`, default 6h) and memory cap (`FACTOR_MINER_MAX_MEMORY_MB`, default 4GB)

### Factor Materialization (`factorResearch/materialization/`)
- **Materialized Factor** (`materializedFactor.ts`): offline computation of complex candidate factors via Python miner into Parquet artifacts, queried later by DuckDB

### Reference Data (`server/src/referenceData/`, Python)
Maintains reference datasets that enrich research:
- **Index Constituents** (`index_constituents_update.py`): snapshot + wayback + derive modes
- **Index Daily Bars** (`index_update.py`): incremental + full backfill
- **Dividend Events** (`dividend_update.py`): batch update with workers, retry, refresh; `dividend_current_update.py` for current snapshot
- **SW (申万) Industry** (`sw_industry_update.py`): industry definitions, memberships, daily bars

### Minute Data Lake (`server/src/minuteData/`, Python)
- **Prepare** (`prepare.py`): pipeline preparation (zip → parquet conversion)
- **TDX Import** (`tdx_import.py`): import minute bars from TDX (通达信) data
- **Online Update** (`online_update.py`): online minute data update with health probes

### Backtest Engine Rules
- Signal generated at bar T, executed at bar T+1 open (no look-ahead bias)
- Buy amount: `cash * positionSizing%`, rounded down to `minimumTradeAmount`
- Index ETFs use 1 yuan minimum trade amount, fractional quantities allowed
- Buy fill price = open × (1 + slippageBps/10000); sell = open × (1 - slippageBps/10000)
- Commission on buys and sells; stamp tax on sells only
- Force close at end if `forceCloseAtEnd` is true
- Engine yields to event loop every 200 bars for cancellation support

### Strategy Protocol
Strategies implement `StrategyDefinition<P>` interface from `src/features/strategies/types.ts`:
- `id`, `name`, `version`, `description`
- `paramsSchema`: typed parameter definitions
- `warmupBars(params)`: minimum data required
- `evaluate(context, params) → StrategySignal`: receives candle slice, position, and indicators; returns buy/sell/hold

Register new strategies in `src/features/strategies/registry.ts`.

### Visual Strategy System
Visual strategies use a node-based flow editor (`@xyflow/react`):
- **`src/features/visualStrategies/compiler.ts`**: Compiles visual strategy DAG into `StrategyDefinition`
- **`src/features/visualStrategies/validator.ts`**: Validates graph structure (no cycles, valid edges, required nodes)
- **`src/features/visualStrategies/explainer.ts`**: Generates natural language explanation of strategy logic
- **`src/features/visualStrategies/schema.ts`**: Node and edge type definitions

### Seven-Layer Market Data (`server/src/marketData/sevenLayerDataService.ts`)
Aggregates data across seven layers for a given stock:
| Layer | Key | Sources |
|-------|-----|---------|
| Signals | `signal` | 同花顺热点, 北向资金, 龙虎榜, 解禁, 行业轮动 |
| Capital | `capital` | 融资融券, 大宗交易, 股东户数, 分红, 资金流 |
| Fundamental | `fundamental` | mootdx财务/F10, 东财三表, 新浪三表 |
| Announcements | `announcement` | 巨潮资讯 |
| Quotes | (via aStockDataService) | mootdx/通达信, 腾讯, 百度K线 |
| Research | (via aStockDataService) | 东财, 同花顺, iwencai |
| News | (via aStockDataService) | 东财个股新闻, 全球资讯 |

### Indicator Protocol
Indicators follow `IndicatorDefinition` from `src/models/IndicatorTypes.ts`:
- `id`, `name`, `params[]`, `display` (overlay vs separate pane, series config)
- Calculation functions take `(Candle[], params) → Record<string, (number | null)[]>`
- Register new indicators in `src/features/indicators/registry.ts`

### State Management (Zustand)
- `useCandleStore`: loaded candles and import result
- `useChartStore`: crosshair position and detail data
- `useIndicatorStore`: active/visible indicators and their parameters
- `useBacktestStore`: backtest config, signals, results, comparison selection, strategy source (builtin/visual), visual DSL document
- `useStrategyStore`: saved strategy configurations
- `useDataLibraryViewStore`: data library page view state (asset type, search, pagination, industry, filters)
- `useStrategyStudioStore`: strategy studio document state (Immer, undo/redo stack max 50, validation, drafts/versions)

### Chart Conventions (Chinese Market)
- Red = up (上涨), Green = down (下跌) — opposite of US conventions
- Volume formatted in 亿 (hundred millions)
- MACD histogram uses red/green based on zero-crossing

### Database

**Frontend (Dexie/IndexedDB)**: Schema version 4 with tables: `marketDatasets`, `candles` (composite key `[datasetId+time]`), `strategyConfigs`, `backtestResults`, `equityPoints` (composite key `[resultId+time]`), `visualStrategies`, `strategyVersions` (composite key `[strategyId+version]`), `strategyDrafts`.

**Backend (Drizzle/MySQL)**: Schema in `server/src/db/schema.ts` (~706 lines). **24 SQL migrations** in `db/migrations/` run automatically at server startup.

Core tables: `market_datasets`, `candles`, `strategy_configs`, `backtest_results`, `equity_points`, `visual_strategies`, `strategy_versions`, `strategy_drafts`.

Phase 5 market data tables: `instruments` (stock master with market/symbol/name/industry/type/listDate/delistDate/status), `provider_symbol_mappings`, `trading_calendar`, `daily_candles` (OHLCV with source tracking), `adjustment_factors` (复权因子), `market_data_versions` (checksum/quality per instrument), `sync_jobs` (with `run_key` generated column) + `sync_job_items` (batch sync tracking), `data_quality_issues` (anomaly records).

Phase 5.5 v2 history storage tables: `daily_bars_v2`, `daily_stock_metrics`, `adjustment_factors_v2`, `adjustment_factor_publications`, `corporate_actions`, `adjusted_bar_overrides`, `data_import_batches`, `data_import_files`.

Phase 6 factor tables: `factor_definitions`, `factor_versions`, `factor_runs`, `factor_reports`, `factor_mining_tasks` (with `worker_pid`/`archived_at`/`deleted_at`), `factor_candidates` (state machine fields), `factor_mining_schedules` (managed via `factorResearch/repositories/factorRepository.ts`).

Reference data tables: `index_constituent_snapshots`, `index_constituent_members`, `dividend_events`, `reference_data_backfill_items`, `sw_industry_definitions`, `sw_industry_memberships`, `sw_industry_daily_bars`.

### Environment Configuration

**Frontend** (`.env`):
- `VITE_DATA_SOURCE`: `api` (default, backend MySQL/Fastify) or `indexeddb` (read-only migration, rejects writes)
- `VITE_API_URL`: Backend URL (default `http://localhost:3001`)

**Admin Console** (`admin/`): Uses the same backend API; auth token configured in backend `server/.env`.

**Backend** (`server/.env`):
- **Database**: `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` (MySQL connection)
- **AI Strategy**: `AI_STRATEGY_ENABLED` (true/false), `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`, `OPENAI_TIMEOUT_MS`
- **Market Data**: `MARKET_DATA_ENABLED`, `MARKET_DATA_PROVIDER`, `MARKET_DATA_API_KEY`, `MARKET_DATA_BASE_URL`, `MARKET_DATA_SYNC_TIME`, `MARKET_DATA_INTRADAY_INTERVAL_MINUTES`, `MARKET_INDEX_AUTO_UPDATE_ENABLED`, `MARKET_CN_INDEX_UPDATE_TIME`, `MARKET_US_INDEX_UPDATE_TIME`
- **History Store**: `HISTORY_STORE_READ_MODE` (legacy/prefer-v2/v2), `HISTORY_STORE_DUAL_WRITE` (true/false)
- **Research**: `RESEARCH_SNAPSHOT_ROOT`, `RESEARCH_QUERY_MAX_ROWS`
- **Minute Data**: `MINUTE_DATA_ZIP_ROOT`, `MINUTE_DATA_ROOT`, `MINUTE_QUERY_MAX_ROWS`
- **Backup**: `BACKUP_ROOT`
- **Factor Research**: `FACTOR_RESEARCH_ROOT`, `FACTOR_MINER_PYTHON`, `FACTOR_MINER_ROOT`, `FACTOR_MINER_TIMEOUT_MS` (default 6h), `FACTOR_MINER_MAX_MEMORY_MB` (default 4GB)
- **Admin Console**: `ADMIN_API_TOKEN` (empty disables admin API), `ADMIN_OVERVIEW_CACHE_TTL_MS` (default 10000, 0 disables caching)
- **Server**: `PORT` (default 3001)

### Testing
- **Frontend**: Vitest + happy-dom, ~32 test files under `src/**/__tests__/`
- **Backend TS**: Vitest, ~46 test files under `server/src/**/` (research/factorResearch/marketData modules have high density)
- **Backend Python**: unittest, ~10 test files (`*_test.py`) under `server/src/referenceData/` and `server/src/minuteData/`
- Run a single test: `npx vitest run <path-to-test>`

### Documentation
- `CLAUDE.md` (this file): Claude Code collaboration guide
- `README.md`: User-facing project documentation (Chinese)
- `doc/`: 14 structured docs across 5 categories (盘后数据更新, 因子研究与查询, 运维监控, 数据治理与验收, 架构设计与规划)
- `plan/`: Phase development plans (Phase 1 through Phase 6.5)
