# 项目长期记忆（量化回测）

## 图表详情面板归属与改动边界
- **市场界面**：使用 `src/features/marketData/MarketKlineChart.tsx`，hover 详情面板由 `src/index.css` 中的 `.market-chart-tooltip` 类（`is-left`/`is-right` 修饰）控制定位。
- **行情分析 + 策略回测界面**：共用 `src/features/chart/ChartContainer.tsx` + `src/features/chart/CandleDetail.tsx`（十字线详情面板，inline style 定位，受 `crosshairTime/Data/Indicators` 控制）。ChartContainer 由 App.tsx（行情分析）与 BacktestRunner.tsx（策略回测）调用。
- **用户边界约定**：调整图表详情面板位置时，只允许改动行情分析/策略回测侧（ChartContainer / CandleDetail）。**严禁改动市场界面（MarketKlineChart）及其 CSS 定位**——这是用户明确划定的红线（此前一次越界改动被要求完整回退）。
- 筹码峰（ChipProfile，`.market-chip-profile`，宽 ~170px）固定在图表右侧区域；详情面板放在左侧时无需为其让位。
