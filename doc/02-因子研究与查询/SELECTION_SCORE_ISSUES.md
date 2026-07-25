# 选股评分逻辑问题分析

> 代码位置: [`src/features/marketData/selectionScore.ts`](../../src/features/marketData/selectionScore.ts)
> 配套文档: [`SELECTION_SCORE_GUIDE.md`](./SELECTION_SCORE_GUIDE.md)
> 审查日期: 2026-07-21
> 审查范围: `calculateSelectionScore` 全部 423 行实现

本文档记录对选股评分模块进行的深入逻辑审查,按严重度分层列出发现的问题,共计 **24 项**。

---

## 一、严重问题:前视偏差(系统性缺陷)

这是最严重的一类问题 — 用"最新 SMA 值"判定"历史是否破位/站稳",而 SMA 本身被最近价格影响,导致判定失真。

### 问题 1:`below60Unrecovered` 用最新 sma60 判定最近 3 日是否跌破

[`selectionScore.ts:231`](../../src/features/marketData/selectionScore.ts#L231)

```ts
const below60Unrecovered = candles.slice(-3).every((item) => item.close < sma60);
```

- `sma60` 是用全量数据(截至最新)算的,**包含了最近 3 日的 close**
- 当最近 3 日下跌时,`sma60` 被拉低,使得 `item.close < sma60` **更容易满足** → 变相放大惩罚
- 正确做法:`candles.slice(-3).every((item, i) => item.close < smaAt(candles, 60, candles.length - 3 + i)!)`

### 问题 2:`supportHeld` 同样存在前视偏差

[`selectionScore.ts:280`](../../src/features/marketData/selectionScore.ts#L280)

```ts
const supportHeld = candles.slice(-5).every((item) => item.low >= sma20 * 0.95);
```

- 用最新 `sma20` 判定历史 5 日的 low 是否"回踩未破"
- 最近 5 日大跌时 `sma20` 被拉低,`item.low >= sma20 * 0.95` 更容易满足 → **变相放宽判定,可能掩盖真实破位**

### 问题 3:`recentUnstable` 用最新 sma5 判定 5 日站稳

[`selectionScore.ts:355`](../../src/features/marketData/selectionScore.ts#L355)

```ts
const recentUnstable = hasConsecutiveLargeBearish && recent5.every((item) => item.close <= item.open || item.close < sma5);
```

- 同样的前视偏差,`sma5` 用最新值判定历史
- 而且 `item.close < sma5` 与 `item.close <= item.open` 是 OR 关系,**只要任一满足就视为"未企稳"** — 阴线或低于最新 MA5,任一成立即命中,逻辑过于宽松

### 问题 4:`below20And60` 用最新 sma20/sma60 判定 3 日跌破

[`selectionScore.ts:373`](../../src/features/marketData/selectionScore.ts#L373)

```ts
const below20And60 = candles.slice(-3).every((item) => item.close < sma20 && item.close < sma60);
```

- 同样的前视偏差,最近 3 日下跌时 sma20/sma60 被拉低,**变相放大 -8 分惩罚**

**前视偏差影响汇总**:4 条规则(2 个加分 + 2 个扣分)失真,且方向不一致 — `supportHeld` 放宽(多加分),`below60Unrecovered`/`below20And60` 放大(多扣分),整体评分平衡被破坏。

---

## 二、严重问题:计算正确性

### 问题 5:`upVolumes`/`downVolumes` 漏算最近 10 日的第一根

[`selectionScore.ts:261-262`](../../src/features/marketData/selectionScore.ts#L261)

```ts
const upVolumes = recent10.filter((_, index) => index > 0 && recent10[index].close > recent10[index - 1].close).map((item) => item.volume);
```

- `index > 0` 跳过了 `recent10[0]`,实际只比较了 9 个变化(recent10[1] vs recent10[0], ..., recent10[9] vs recent10[8])
- 标签写"上涨日量能",10 日应产生 10 个变化,实际只算 9 个 — **最近 10 日第一根的涨跌被漏掉**
- 修复:`const recent11 = candles.slice(-11); recent11.filter((_, i) => i > 0 && recent11[i].close > recent11[i-1].close)`

### 问题 6:`gentleRise` 漏检第一根的温和性

[`selectionScore.ts:307`](../../src/features/marketData/selectionScore.ts#L307)

```ts
const gentleRise = return5 > 0 && bullishDays >= 3 && recent5.every((_, index) => index === 0 || Math.abs(dailyChanges[dailyChanges.length - 5 + index]) < 0.05);
```

- `index === 0 ||` 跳过了第一根的检查,实际只验证 4 根的温和性
- 但 `recent5[0]` 的 dailyChange 对应 `dailyChanges[length-5]`(即"倒数第 6 → 倒数第 5"),被漏掉了
- 标签"连续小阳线或温和上行"应覆盖 5 根,**实际只检查 4 根**

### 问题 7:输入预处理无去重,重复日期污染计算

[`selectionScore.ts:167-169`](../../src/features/marketData/selectionScore.ts#L167)

```ts
const candles = [...inputCandles]
  .filter((item) => [item.open, item.close, item.high, item.low, item.volume].every(Number.isFinite))
  .sort((a, b) => a.date.localeCompare(b.date));
```

- 只过滤 NaN/Infinity 并排序,**没有按 date 去重**
- 如果输入有同一日期的多根 K 线(例如 API 重试或跨源合并),全部保留 → `latestChange`、`dailyChanges`、`smaAt` 等全部受污染
- 修复:排序后加 `filter((item, i, arr) => i === 0 || item.date !== arr[i-1].date)`

### 问题 8:`forcedCooling` 估算粗糙且与文档语义不一致

[`selectionScore.ts:379-382`](../../src/features/marketData/selectionScore.ts#L379)

```ts
const estimatedAmounts = candles.slice(-20).map((item) => item.volume * ((item.high + item.low + item.close) / 3) * 100);
// ...
const forcedCooling = averageAmountYuan < 10_000_000;
addPenalty(riskItems, '日均成交额低于 3000 万', 5, averageAmountYuan < 30_000_000, ...);
```

- **不使用 `KlinePoint.amount` 字段**:即便后端可能返回真实成交额,代码完全忽略,只用估算
- **`candles.slice(-20)` 包含今日**,但 `previous20 = slice(-21, -1)` 不含今日 — 同函数内"20 日"有两种含义
- **阈值梯度不合理**:1000 万直接进冷却池(0 分项),3000 万扣 5 分,中间无过渡
- **单位假设**:`× 100` 假设 volume 单位是"手",但不同数据源(通达信/腾讯/东财)单位不统一,可能导致数量级偏差

### 问题 9:`recentUnstable` 在 volatility 和 risk 双重扣 12 分

[`selectionScore.ts:356`](../../src/features/marketData/selectionScore.ts#L356) 与 [`selectionScore.ts:378`](../../src/features/marketData/selectionScore.ts#L378)

```ts
// volatility section
addPenalty(volatilityItems, '连续大阴线后未企稳', 6, recentUnstable, ...);
// risk section
addPenalty(riskItems, '短期连续大阴线且无企稳', 6, recentUnstable, ...);
```

- 同一 `recentUnstable` 在两个 section 各扣 6 分,共 **-12 分**
- volatility 是正向节(被 max(0, ...) 截断下限),risk 是倒扣节(无上限),**双重惩罚**
- 文档未说明这种重复合理性

### 问题 10:`brokeRecently` 只看"曾突破"不看"维持"

[`selectionScore.ts:294`](../../src/features/marketData/selectionScore.ts#L294)

```ts
const brokeRecently = Math.max(...candles.slice(-5).map((item) => item.close)) >= olderPlatformHigh;
const breakoutHeld = brokeRecently && latestClose >= olderPlatformHigh * 0.98;
```

- `brokeRecently` 只要有 1 日 close ≥ 平台高就为 true
- 即使今日大跌,只要前 4 日有 1 日突破,仍视为"近期突破"
- 然后用 `latestClose >= olderPlatformHigh * 0.98` 判断"未明显跌回",但 0.98 阈值意味着即使跌回平台下方 2% 也算"维持" — 与标签"突破平台后未明显跌回"语义不符

---

## 三、中等问题:逻辑不严谨

### 问题 11:`sma20NearCross` "即将上穿"判定不准

[`selectionScore.ts:225`](../../src/features/marketData/selectionScore.ts#L225)

```ts
const sma20NearCross = sma20 >= sma60 * 0.98;
```

- 等价于"sma20 不低于 sma60 的 98%",但这是**静态距离**而非"即将上穿"
- 如果 sma20=9.9, sma60=10,距离 1%,但 sma20 下行、sma60 上行,永远不会"上穿"
- 正确做法:看斜率差 `sma20 - sma20Prev > sma60 - sma60Prev && |sma20 - sma60| / sma60 < 0.02`

### 问题 12:`upVolumes` 全涨时不命中加分

[`selectionScore.ts:265`](../../src/features/marketData/selectionScore.ts#L265)

```ts
addBonus(volumeItems, '上涨日量能高于下跌日', 5, upVolumes.length >= 2 && downVolumes.length >= 1 && upVolumeAverage > downVolumeAverage, ...);
```

- 要求 `downVolumes.length >= 1`,10 日全部上涨时 `downVolumes.length = 0`,**反而不命中加分**
- 10 日全涨是强势信号,不应被惩罚 — 应改为 `upVolumes.length >= 1 && (downVolumes.length === 0 || upVolumeAverage > downVolumeAverage)`

### 问题 13:`upperRejectionCount` 只统计阴线

[`selectionScore.ts:348-352`](../../src/features/marketData/selectionScore.ts#L348)

```ts
return item.close < item.open && shadow > Math.max(candleBody * 2, (item.high - item.low) * 0.35);
```

- `item.close < item.open` 要求阴线才计入"冲高回落"
- 但阳线长上影同样是冲高回落,被漏掉
- 应去掉 `item.close < item.open` 限制,只看上影线长度

### 问题 14:`contraction` 误判低波动为整理形态

[`selectionScore.ts:303-304`](../../src/features/marketData/selectionScore.ts#L303)

```ts
const contraction = average(candles.slice(-5).map(rangePct)) < average(candles.slice(-15, -5).map(rangePct)) * 0.8
  && latestClose >= sma20;
```

- 仅检查"振幅缩小 20% + 价格在 MA20 之上"
- 长期阴跌后波动减小也会命中 — **会误判下跌中继为"上升三角形/收敛整理"**
- 应加趋势过滤:`return5 > 0` 或 `sma5 > sma20`

### 问题 15:`attemptBreakout` 与 `risingOrBreakout` 阈值不一致

[`selectionScore.ts:259`](../../src/features/marketData/selectionScore.ts#L259) 与 [`selectionScore.ts:291`](../../src/features/marketData/selectionScore.ts#L291)

```ts
const risingOrBreakout = latestChange > 0 || latestClose >= previous20High * 0.98;  // 0.98
const attemptBreakout = latestClose >= previous20High * 0.97;  // 0.97
```

- 同一"接近前高"概念,两个阈值相差 1%
- 应统一为一个常量,避免维护混乱

### 问题 16:`stopFalling` 标签与逻辑不符

[`selectionScore.ts:284`](../../src/features/marketData/selectionScore.ts#L284)

```ts
const stopFalling = nearSupport && (isBullishOrDoji || latest.volume < candles[candles.length - 2].volume);
addBonus(supportItems, '小阳线、十字星或缩量止跌', 2, stopFalling, ...);
```

- 标签是三个条件(小阳 + 十字星 + 缩量止跌),但代码是 `nearSupport && (阳线 OR 十字星 OR 缩量)` — AND 语气 vs OR 逻辑
- 任一即可命中,语义不严谨

### 问题 17:`heavySellWithoutSupport` 一字板边界依赖外部检查

[`selectionScore.ts:270-272`](../../src/features/marketData/selectionScore.ts#L270)

```ts
const heavySellWithoutSupport = latestChange <= -0.03
  && latestVolumeRatio >= 1.5
  && (latest.close - latest.low) / Math.max(latest.high - latest.low, 0.01) < 0.25;
```

- `Math.max(latest.high - latest.low, 0.01)` 防除零,但 0.01 元对低价股(2 元)不合理(0.5% 波动)
- 一字跌停时 `close=low=high`,被放大到 0.01,`0/0.01=0 < 0.25` 命中 — 合理但依赖 `latestChange <= -0.03` 前置
- 建议:`Math.max(latest.high - latest.low, latest.close * 0.001)`

---

## 四、健壮性问题

### 问题 18:`latestChange` 无 close=0 保护

[`selectionScore.ts:218`](../../src/features/marketData/selectionScore.ts#L218)

```ts
const latestChange = latest.close / candles[candles.length - 2].close - 1;
```

- 没检查 `candles[length-2].close > 0`,如果前一日 close=0(API 异常)会得到 Infinity
- `priceReturn` 有此保护,这里却没有,不一致

### 问题 19:`dailyChanges` 首项强制 0,隐式依赖 NaN 比较

[`selectionScore.ts:219`](../../src/features/marketData/selectionScore.ts#L219)

```ts
const dailyChanges = candles.map((item, index) => index === 0 ? 0 : item.close / candles[index - 1].close - 1);
```

- 若 `candles[0].close = 0`,则 `candles[1]` 的 dailyChange = Infinity
- 后续 `dailyChanges[index] <= -0.02` 依赖 `NaN <= -0.02 === false` 的隐式语义
- 不健壮,应显式过滤

### 问题 20:`sma60Change` 无 sma60Prev=0 保护

[`selectionScore.ts:222`](../../src/features/marketData/selectionScore.ts#L222)

```ts
const sma60Change = sma60 / sma60Prev - 1;
const sma60FlatOrUp = sma60Change >= -0.005;
```

- 若 `sma60Prev = 0`,得 Infinity,`Infinity >= -0.005` 为 true,**错误命中"60 日均线向上或走平"+8 分**
- 虽然实际几乎不可能,但缺乏防御

### 问题 21:`largeBearishStreak` 无 open=0 保护

[`selectionScore.ts:344`](../../src/features/marketData/selectionScore.ts#L344)

```ts
largeBearishStreak = item.close < item.open && (item.open - item.close) / item.open >= 0.03 ? largeBearishStreak + 1 : 0;
```

- `(item.open - item.close) / item.open` 没保护 `item.open = 0`
- `Number.isFinite(0)` 为 true,所以 open=0 不会被前置过滤掉

### 问题 22:`maxDrawdown20` 的 rollingPeak 初始化不当

[`selectionScore.ts:334`](../../src/features/marketData/selectionScore.ts#L334)

```ts
let rollingPeak = drawdownWindow[0].close;
```

- 应该用 `drawdownWindow[0].high`,因为 peak 应该是最高价
- 虽然第一轮循环 `Math.max(close, item.high)` 会修正,但语义不清晰

### 问题 23:`normalizedBaseScore` 冗余计算

[`selectionScore.ts:395`](../../src/features/marketData/selectionScore.ts#L395)

```ts
const normalizedBaseScore = Math.round(rawPositiveScore / POSITIVE_SCORE_MAX * 100);
```

- 7 个 section 的 maxScore 总和 = 22+18+18+14+10+8+10 = 100,等于 `POSITIVE_SCORE_MAX`
- 所以 `rawPositiveScore / 100 * 100 = rawPositiveScore`,**`Math.round` 多此一举**(已经是整数)
- 更严重:如果未来调整 maxScore 总和不为 100,这里会出错 — 应除以 `sum(positiveSections.map(s => s.maxScore))`

### 问题 24:`sampleSize` 未报告原始输入大小

[`selectionScore.ts:187`](../../src/features/marketData/selectionScore.ts#L187)

```ts
sampleSize: candles.length,
message: `当前仅有 ${candles.length} 根有效日 K，至少需要 65 根。`,
```

- 用的是过滤后的长度,用户不知道有多少根被 NaN/Infinity 过滤掉
- 如果原始输入 70 根但 10 根 NaN,过滤后 60 根 < 65,用户困惑"我传了 70 根为什么还说不足"
- 应同时报告原始长度和过滤后长度

---

## 五、问题汇总

| 类别 | 问题数 | 关键风险 |
|---|---:|---|
| **前视偏差(系统性)** | 4 | below60/supportHeld/recentUnstable/below20And60 用最新 SMA 判定历史,评分失真 |
| 计算正确性 | 6 | upVolumes 漏算、gentleRise 漏检、无去重、forcedCooling 估算粗糙、双重扣分、brokeRecently 语义错 |
| 逻辑不严谨 | 7 | sma20NearCross 不准、全涨不加分、上影只看阴线、contraction 误判、阈值不一致、标签逻辑不符、一字板边界 |
| 健壮性 | 7 | 除零保护缺失、NaN 隐式依赖、rollingPeak 初始化、冗余计算、sampleSize 不透明 |

---

## 六、最需要优先修复的 5 个问题

1. **前视偏差(问题 1-4)**:系统性缺陷,影响 4 条规则,且方向不一致(有的放宽、有的放大),整体评分平衡被破坏。这是**最严重的设计缺陷**
2. **upVolumes 漏算(问题 5)**:量价验证维度的数据错误,直接影响 +5/-5 分项
3. **无去重(问题 7)**:输入有重复日期时全部规则都可能失效
4. **forcedCooling 估算(问题 8)**:不使用真实 amount 字段,可能导致整个评分被误判为冷却池
5. **recentUnstable 双重扣分(问题 9)**:同一条件扣 12 分,评分公平性问题

---

## 七、修复建议路线

### 阶段一:修复前视偏差(问题 1-4)

引入 `smaAtUpTo(candles, period, asOfIndex)` 辅助函数,在判定历史时点是否破位/站稳时,使用该时点的 SMA 值而非最新 SMA。

```ts
function smaAtUpTo(candles: KlinePoint[], period: number, asOfIndex: number): number | null {
  return smaAt(candles.slice(0, asOfIndex + 1), period);
}
```

### 阶段二:修复计算正确性(问题 5-10)

- `upVolumes`/`downVolumes` 改用 `recent11`
- `gentleRise` 去掉 `index === 0 ||` 特判
- 输入预处理增加按 date 去重
- `forcedCooling` 优先使用 `KlinePoint.amount`,缺失时才估算
- `recentUnstable` 在 volatility 节去掉,只在 risk 节保留
- `brokeRecently` 改为"最近 5 日有 close ≥ 平台高,且最新 close 不低于平台高的 0.98"

### 阶段三:补充健壮性保护(问题 18-24)

统一在所有除法运算前增加 `> 0` 检查,显式处理 NaN/Infinity,使用 `Number(value.toFixed(digits))` 替代 `Math.round(value * factor) / factor`。

### 阶段四:补充测试覆盖

现有测试仅 3 个用例,应针对每条规则补充命中/不命中分支测试,特别是前视偏差修复后的回归测试。
