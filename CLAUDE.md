# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev           # Start Vite dev server at localhost:5173
npm run build         # TypeScript check (tsc -b) + Vite production build
npm run preview       # Preview production build
npm test              # Run all tests (Vitest)
npm run test:watch    # Watch mode for tests
```

## Tech Stack

- **React 19** + TypeScript 6, Vite
- **Ant Design 6** with Chinese locale (zhCN)
- **TradingView Lightweight Charts 5** for K-line and indicator charts
- **Zustand 5** for state management
- **Dexie 4** (IndexedDB) for local data persistence
- **SheetJS (xlsx)** for Excel parsing
- **Zod 4** for validation
- **Vitest** + happy-dom for testing

## Project Structure

```
src/
  models/            TypeScript interfaces (Candle, BacktestResult, Strategy, Trade, etc.)
  components/        Shared UI components (AppLayout, FileUploader, IndicatorPanel)
  features/
    import/          Excel parsing, header mapping (Chinese-English), validation
    chart/           K-line chart with lightweight-charts, crosshair details, indicator panes
    indicators/      11 technical indicators (SMA, EMA, BOLL, MACD, RSI, KDJ, ATR, CCI, WR, OBV, volume MA)
    strategies/      Strategy protocol + 4 built-in strategies (dual MA, RSI, MACD, BOLL)
    backtest/        Engine, broker, portfolio, metrics calculation, validation
    backtestResults/ Results overview, equity curve chart, trade list, comparison
    dataLibrary/     Dataset management UI (save, open, delete from IndexedDB)
  stores/            Zustand stores (candle, chart, indicator, backtest, strategy)
  workers/           Web Worker for async backtest execution
  db/                Dexie database schema and repositories
  utils/             Date and number formatting utilities
```

## Architecture Highlights

### Data Flow
1. **Excel Import**: SheetJS parses `.xlsx` → `headerMapper` maps Chinese/English column names → `parser` produces `Candle[]` → `validator` checks dates, OHLC, duplicates
2. **Storage**: Candles saved to Dexie/IndexedDB via `marketDataRepository`
3. **Chart**: `ChartContainer` reads candles from `useCandleStore`, renders with lightweight-charts, overlays indicator series and signal markers
4. **Backtest**: UI sends request via `useBacktest` hook → Web Worker → `runBacktestAsync` engine → fills orders via `broker.ts` → tracks portfolio via `portfolio.ts` → computes metrics via `metrics.ts` → returns `BacktestResult` → saves to IndexedDB

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

### Database (Dexie)
Schema version 2 with tables: `marketDatasets`, `candles` (composite key `[datasetId+time]`), `strategyConfigs`, `backtestResults`, `equityPoints` (composite key `[resultId+time]`).
