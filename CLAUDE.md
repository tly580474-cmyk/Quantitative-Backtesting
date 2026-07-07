# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Frontend
npm run dev           # Start Vite dev server at localhost:5173
npm run build         # TypeScript check (tsc -b) + Vite production build
npm run preview       # Preview production build
npm test              # Run all tests (Vitest)
npm run test:watch    # Watch mode for tests

# Run a single test file
npx vitest run src/features/backtest/__tests__/engine.test.ts

# Backend
cd server
npm run dev           # Start Fastify server at localhost:3001 (tsx watch)
npm start             # Production start (tsx src/app.ts)
npm run typecheck     # TypeScript check (tsc --noEmit)
npm run build         # Compile with tsc
npm test              # Run server tests (Vitest)

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
```

Start both frontend and backend together: double-click `start.bat` (Windows) or run `scripts/start-dev.ps1`.

## Tech Stack

### Frontend
- **React 19** + TypeScript 6, Vite
- **React Router 7** for client-side routing
- **Ant Design 6** with Chinese locale (zhCN) and @ant-design/icons
- **TradingView Lightweight Charts 5** for K-line and indicator charts
- **Zustand 5** + Immer for state management
- **Dexie 4** (IndexedDB) for local data persistence
- **SheetJS (xlsx)** for Excel parsing
- **React Markdown** + remark-gfm for rendering AI-generated reports
- **@xyflow/react** + dagre for visual strategy node editor
- **Zod 4** for validation
- **Vitest** + happy-dom for testing
- **Path alias**: `@/` maps to `src/`

### Backend (`server/`)
- **Fastify 5** + TypeScript 5, run with tsx
- **Drizzle ORM** + MySQL2 for optional server-side persistence
- **DuckDB** (`@duckdb/node-api`) as embedded OLAP engine for factor research and snapshot queries
- **OpenAI SDK** for AI strategy generation and stock research agent
- **Zod 4** for config validation, route schemas, and drizzle-zod
- Market data from 腾讯财经, 东方财富, and 巨潮资讯

## Project Structure

```
src/
  models/            TypeScript interfaces (Candle, BacktestResult, Strategy, Trade, etc.)
  components/        Shared UI components (AppLayout, FileUploader, IndicatorPanel)
  api/               Frontend API client and repository layer
  features/
    import/          Excel parsing, header mapping (Chinese-English), validation
    chart/           K-line chart with lightweight-charts, crosshair details, indicator panes
    indicators/      11 technical indicators (SMA, EMA, BOLL, MACD, RSI, KDJ, ATR, CCI, WR, OBV, volume MA)
    strategies/      Strategy protocol + 4 built-in strategies (dual MA, RSI, MACD, BOLL)
    visualStrategies/ Visual node-based strategy editor, DSL compiler, validator, explainer
    strategyStudio/  AI-powered strategy generation via OpenAI-compatible providers
    backtest/        Engine, broker, portfolio, metrics calculation, validation
    backtestResults/ Results overview, equity curve chart, trade list, comparison
    dataLibrary/     Dataset management UI (save, open, delete from IndexedDB)
    marketData/      Watchlist, real-time quotes, K-line, research reports, AI agent
  stores/            Zustand stores (candle, chart, indicator, backtest, strategy)
  workers/           Web Worker for async backtest execution
  db/                Dexie database schema and repositories

server/src/
  app.ts             Fastify server entry point, route registration
  config.ts          Zod-validated env config
  marketData/
    providers/       Data source adapters (Tencent, primary, registry)
    normalization/   Symbol mapping, candle normalization, adjustment
    quality/         Data quality checks, anomaly detection, calendar validation
    repositories/    Instrument, market data, calendar, sync job repositories
    jobs/            Sync scheduler, executor, index dataset updater, retry policy
    aStockDataService.ts    Stock quote, search, K-line (Tencent + East Money)
    sevenLayerDataService.ts Seven-layer data: quotes, research, signals, capital,
                             fundamental, announcements, news
  routes/            Fastify route modules (marketData, instruments, syncJobs,
                     dataQuality, datasets, results, aiStrategies, visualStrategies,
                     factorResearch, export, strategyConfigs)
  services/          AI stock research agent, data service
    strategyGeneration/ OpenAI + mock providers, prompt templates, schema
  db/                MySQL/Drizzle schema, connection pool, migrations
  research/          Phase 5.5: snapshot builder, DuckDB query service,
                     manifest/freshness/verifier, CLI tools
  historyImport/     Phase 5.5: CSV/factor batch importer into MySQL
  backup/            Phase 5.5: MySQL dump + snapshot backup, verify, restore-check
  factorResearch/    Phase 6: factor definitions, compiler, evaluator,
                     single/composite runner, repository, CLI
  validation/        Shared error codes and API error helpers
```

## Architecture Highlights

### Data Flow
1. **Excel Import**: SheetJS parses `.xlsx` → `headerMapper` maps Chinese/English column names → `parser` produces `Candle[]` → `validator` checks dates, OHLC, duplicates
2. **Storage**: Candles saved to Dexie/IndexedDB via `marketDataRepository` (or MySQL via server API)
3. **Chart**: `ChartContainer` reads candles from `useCandleStore`, renders with lightweight-charts, overlays indicator series and signal markers
4. **Backtest**: UI sends request via `useBacktest` hook → Web Worker → `runBacktestAsync` engine → fills orders via `broker.ts` → tracks portfolio via `portfolio.ts` → computes metrics via `metrics.ts` → returns `BacktestResult` → saves to IndexedDB

### Server Architecture
- **Fastify** with CORS at `localhost:3001`
- Routes registered in `app.ts` by calling `register*Routes(fastify)` functions
- Market data providers follow a plugin pattern: register with `providerRegistry`, implement the `MarketDataProvider` interface
- **PrimaryProvider** wraps any provider with rate limiting and retry logic
- **TencentProvider** is the main data source (quotes, K-line, search); East Money provides industry, research reports, and fundamentals
- AI services use the OpenAI Chat Completions spec — works with OpenAI, DeepSeek, or any compatible endpoint
- Config is loaded via `dotenv` + Zod schema at startup (`server/src/config.ts`)

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
- **Definitions** (`definitions/`): Factor schema types (`FactorDefinition`, `FactorRunConfig`, `CompositeFactorRunConfig`), built-in factor catalog, validator.
- **Engine** (`engine/`):
  - `factorCompiler.ts` — compiles factor definitions into executable logic
  - `evaluator.ts` — evaluates a single factor against market data (via DuckDB on research snapshots)
  - `factorRunner.ts` — orchestrates single-factor research runs; computes IC, rank IC, ICIR, layer returns
  - `compositeRunner.ts` — runs multi-factor research with weighting strategies: `equal`, `ic`, `rankIc`, `manual`
- **Repository** (`repositories/factorRepository.ts`): Persists factor run results to MySQL, lists factor catalog, syncs built-in factors.
- **Route** (`routes/factorResearch.ts`): `POST /api/factor-research/run` and `POST /api/factor-research/composite`, guarded by snapshot freshness check.
- **Factor types**: `higher-is-better`, `lower-is-better`, `research`. Dependencies include open/high/low/close/previousClose/volume/amount/turnoverRatePct.
- **Composite weighting**: `equal`, `ic` (information coefficient), `rankIc`, `manual` (user-specified weights).

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
- `useBacktestStore`: backtest config, signals, results, comparison selection
- `useStrategyStore`: saved strategy configurations

### Chart Conventions (Chinese Market)
- Red = up (上涨), Green = down (下跌) — opposite of US conventions
- Volume formatted in 亿 (hundred millions)
- MACD histogram uses red/green based on zero-crossing

### Database

**Frontend (Dexie/IndexedDB)**: Schema version 2 with tables: `marketDatasets`, `candles` (composite key `[datasetId+time]`), `strategyConfigs`, `backtestResults`, `equityPoints` (composite key `[resultId+time]`).

**Backend (Drizzle/MySQL)**: Schema in `server/src/db/schema.ts` (~490 lines). Migrations run automatically at server startup.

Core tables: `market_datasets`, `candles`, `strategy_configs`, `backtest_results`, `equity_points`, `visual_strategies`, `strategy_versions`, `strategy_drafts`.

Phase 5 market data tables: `instruments` (stock master with market/symbol/name/industry/type/listDate/delistDate/status), `provider_symbol_mappings`, `trading_calendar`, `daily_candles` (OHLCV with source tracking), `adjustment_factors` (复权因子), `market_data_versions` (checksum/quality per instrument), `sync_jobs` + `sync_job_items` (batch sync tracking), `data_quality_issues` (anomaly records).

Phase 6 factor tables: factor catalog, factor run records, composite run records, daily factor metrics, layer metrics, correlation metrics (managed via `factorResearch/repositories/factorRepository.ts`).

### Environment Configuration

**Frontend** (`.env`):
- `VITE_DATA_SOURCE`: `indexeddb` (default) or `api`
- `VITE_API_URL`: Backend URL (default `http://localhost:3001`)

**Backend** (`server/.env`):
- `DB_*`: MySQL connection (optional, server runs without it for read-only market data)
- `OPENAI_*`: AI model config for strategy generation and stock research agent
- `MARKET_DATA_*`: Market data provider and sync schedule
- `PORT`: Server port (default 3001)
