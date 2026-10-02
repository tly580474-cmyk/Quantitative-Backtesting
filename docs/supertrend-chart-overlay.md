# K 线 Supertrend

行情详情（股票、指数等）、行情分析、回测 K 线和盘感训练共用 `supertrend.ts` 与 `SupertrendPrimitive.ts`。首次使用默认开启，可在各页面的技术指标选择中隐藏。行情详情移动端旧偏好会补入 Supertrend 默认值，已保存的关闭偏好会保留。分时折线图维持原有展示。

主图按涨跌偏好绘制上涨支撑、下跌阻力，以及趋势线至 K 线实体中点的 9% 透明填充。每次趋势反转独立绘制线段和多边形，不跨反转连接，只有一根 K 线的趋势也可见。指标参加价格轴自动缩放。图例显示实际生效的 ATR 周期、倍数和数值；悬停可查看对应 K 线的指标值。

## 自动参数

| K 线周期 | ATR 周期 | 倍数 |
| --- | ---: | ---: |
| 1 分钟 | 14 | 3.5 |
| 5 分钟 | 12 | 3 |
| 15 / 30 分钟 | 10 | 3 |
| 60 / 120 分钟 | 10 | 2.5 |
| 日 / 周 | 10 | 3 |
| 月 | 6 | 2.5 |
| 季 | 4 | 2.5 |
| 年 | 3 | 2.5 |

这些是按周期设置的显示预设，没有对样本做参数寻优，也不表示收益最优。15 分钟对应参考图 `(10, 3)`。分析/回测指标参数窗口可以关闭自动适配，使用手动 ATR 周期和倍数。盘感训练当前只有日 K，采用日线预设。

## 计算与跳空

- 采用 [TradingView 公布的 Supertrend 轨道及方向公式](https://www.tradingview.com/support/solutions/43000634738-supertrend/)。ATR 用 Wilder 平滑，第一根有效 K 线的 TR 为最高价减最低价，以完整的 `period` 根 TR 均值初始化。预热期间无指标值。
- 后续 TR 为 `max(high-low, abs(high-prevClose), abs(low-prevClose))`。真实跳空只计入一次；休市、周末或午休不添加虚拟 K 线。`prevClose` 使用同一张图上前一根 K 线的收盘价，避免将未复权报价的昨收混入复权 K 线。
- 上下轨依据前收盘和前轨道递推；方向依据当前收盘穿越当前递推轨道切换。跳空放大 ATR 后仍可穿越已保留的轨道，影线穿越和收盘恰好等于轨道不切换方向。
- 周/月/季/年先聚合 OHLC，再计算指标。参数随周期而定，不因后续数据增长或当前视窗变化而调整。所有值仅依赖截至当根 K 线的数据，训练后续揭示不会改写既有值。
- 非有限或不合法的 OHLC 中断计算并重新预热；数据不足不生成虚假趋势。

## 验证

单元测试包含双向跳空手算样例、Wilder ATR、轨道递推、收盘与影线区别、零波幅、预热、无未来数据、周期覆盖、手动参数、聚合与价格口径、反转断线及单根趋势填充、隐藏及价格轴范围。运行前端相关测试时排除仓库中的临时历史副本：

```powershell
npx vitest run src/features/indicators src/features/chart src/features/marketData/MarketKlineChart.test.tsx src/features/marketData/useDetailIndicators.test.ts src/features/marketData/MarketIndexNavigation.test.tsx src/features/marketSenseTraining src/MarketAnalysisRoute.test.tsx src/__tests__/marketDetailNavigation.test.tsx --exclude .tmp_agent/** --exclude tmp_output/**
npm run build
```

本地浏览器使用含双向跳空的模拟 OHLC 验收三套实际组件，检查红绿趋势带、明暗主题、周期参数切换及隐藏开关。

## 涨跌配色偏好

桌面导航底部的“涨跌配色”按钮、手机“全部功能”菜单均可选择“红涨绿跌”或“绿涨红跌”。默认红涨绿跌，独立于明暗主题，选择保存在当前浏览器。K 线实体、边框、影线、成交量、MACD 柱、Supertrend 线和填充、图例及涨跌数值同步切换；历史分时弹窗的成交量也使用该偏好。颜色在现有图表中更新，不重新创建主图，因此保留缩放、画线和训练进度。计算结果及周期参数不受配色影响。
