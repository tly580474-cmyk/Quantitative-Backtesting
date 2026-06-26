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
npm run typecheck     # TypeScript check (tsc --noEmit)
npm run build         # Compile with tsc
```

Start both frontend and backend together: double-click `start.bat` (Windows) or run `scripts/start-dev.ps1`.

## Tech Stack

### Frontend
- **React 19** + TypeScript 6, Vite
- **Ant Design 6** with Chinese locale (zhCN)
- **TradingView Lightweight Charts 5** for K-line and indicator charts
- **Zustand 5** for state management
- **Dexie 4** (IndexedDB) for local data persistence
- **SheetJS (xlsx)** for Excel parsing
- **Zod 4** for validation
- **@xyflow/react** + **dagre** for visual strategy node editor
- **Vitest** + **happy-dom** for testing
- **Path alias**: `@/` maps to `src/`

### Backend (`server/`)
- **Fastify 5** + TypeScript 5, run with **tsx**
- **Drizzle ORM** + **MySQL2** for optional server-side persistence
- **OpenAI SDK** for AI strategy generation and stock research agent
- **Zod 4** for config validation and schema generation (drizzle-zod)
- Market data from **腾讯财经**, **东方财富**, and **巨潮资讯**

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
                     dataQuality, datasets, results, aiStrategies, visualStrategies, etc.)
  services/          AI stock research agent, data service
    strategyGeneration/ OpenAI + mock providers, prompt templates, schema
  db/                MySQL/Drizzle schema, connection pool, migrations
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

**Backend (Drizzle/MySQL)**: Schema in `server/src/db/schema.ts`. Migrations run automatically at server startup. Tables mirror the IndexedDB schema plus additional market data tables (instruments, sync jobs, data quality).

### Environment Configuration

**Frontend** (`.env`):
- `VITE_DATA_SOURCE`: `indexeddb` (default) or `api`
- `VITE_API_URL`: Backend URL (default `http://localhost:3001`)

**Backend** (`server/.env`):
- `DB_*`: MySQL connection (optional, server runs without it for read-only market data)
- `OPENAI_*`: AI model config for strategy generation and stock research agent
- `MARKET_DATA_*`: Market data provider and sync schedule
- `PORT`: Server port (default 3001)
