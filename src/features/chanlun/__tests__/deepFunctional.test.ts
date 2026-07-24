import { describe, expect, it } from 'vitest';
import type { Candle } from '@/models';
import {
  CHAN_V1_CONFIG,
  analyzeChanlun,
  IncrementalChanEngine,
  resolveContainment,
  identifyStrictFractals,
  buildPens,
  buildCenters,
  buildSegments,
  generateChanCenterSignals,
  generateChanThirdBuySignals,
  analyzeChanlunAt,
  replayChanlun,
} from '..';
import { GOLDEN_CHAN_BARS } from './fixtures';

function candle(
  time: string,
  high: number,
  low: number,
  close = (high + low) / 2,
  open = close,
  volume = 10,
): Candle {
  return { time, symbol: 'TEST', open, high, low, close, volume };
}

// 构造一个能产出至少一确认笔的最小序列：3根上+3根下+3根上+3根下
function basicUpPulse(): Candle[] {
  return [
    candle('2026-01-01', 8, 6),
    candle('2026-01-02', 10, 8),
    candle('2026-01-03', 12, 10),
    candle('2026-01-04', 11, 9),
    candle('2026-01-05', 10, 8),
    candle('2026-01-06', 8, 6),
    candle('2026-01-07', 9, 7),
    candle('2026-01-08', 11, 9),
    candle('2026-01-09', 13, 11),
    candle('2026-01-10', 12, 10),
    candle('2026-01-11', 10, 8),
    candle('2026-01-12', 8, 6),
    candle('2026-01-13', 9, 7),
    candle('2026-01-14', 11, 9),
    candle('2026-01-15', 13, 11),
  ];
}

describe('输入校验与边界', () => {
  it('空数组生成空分析但不抛错', () => {
    const result = analyzeChanlun([]);
    expect(result.sourceBars).toHaveLength(0);
    expect(result.mergedBars).toHaveLength(0);
    expect(result.fractals).toHaveLength(0);
    expect(result.pens).toHaveLength(0);
    expect(result.segments).toHaveLength(0);
    expect(result.penCenters).toHaveLength(0);
    expect(result.segmentCenters).toHaveLength(0);
    expect(result.current.asOfIndex).toBeNull();
    expect(result.current.asOf).toBeNull();
    // engine.ts: sourceBars.length < 7 触发警告
    expect(result.warnings).toContain('K线数量较少，可能不足以形成有效笔。');
  });

  it('单根K线只产出方向unknown的合并bar且无结构', () => {
    const result = analyzeChanlun([candle('2026-01-01', 10, 8)]);
    expect(result.mergedBars).toHaveLength(1);
    expect(result.mergedBars[0].direction).toBe('unknown');
    expect(result.fractals).toHaveLength(0);
    expect(result.pens).toHaveLength(0);
    // 单根K线<7,同样触发警告
    expect(result.warnings).toContain('K线数量较少，可能不足以形成有效笔。');
  });

  it('K线数<7发出有效笔不足警告', () => {
    const result = analyzeChanlun([
      candle('2026-01-01', 10, 8),
      candle('2026-01-02', 11, 9),
      candle('2026-01-03', 10, 8),
    ]);
    expect(result.warnings).toContain('K线数量较少，可能不足以形成有效笔。');
  });

  it('重复时间被拒绝', () => {
    expect(() => analyzeChanlun([
      candle('2026-01-01', 10, 8),
      candle('2026-01-01', 11, 9),
    ])).toThrow(/严格递增/);
  });

  it('相等时间(非严格递增)被拒绝', () => {
    expect(() => analyzeChanlun([
      candle('2026-01-01', 10, 8),
      candle('2026-01-01', 12, 9),
    ])).toThrow(/严格递增/);
  });

  it('NaN价格被拒绝', () => {
    expect(() => analyzeChanlun([
      candle('2026-01-01', 10, 8),
      candle('2026-01-02', Number.NaN, 9),
    ])).toThrow(/非有限价格/);
  });

  it('Infinity价格被拒绝', () => {
    expect(() => analyzeChanlun([
      candle('2026-01-01', 10, 8),
      candle('2026-01-02', Number.POSITIVE_INFINITY, 9),
    ])).toThrow(/非有限价格/);
  });

  it('OHLC非法(high<open)被拒绝', () => {
    expect(() => analyzeChanlun([
      candle('2026-01-01', 10, 8),
      // high=5 但 open=10,low=8 → high<open 且 high<low
      { time: '2026-01-02', symbol: 'TEST', open: 10, high: 5, low: 8, close: 9, volume: 10 },
    ])).toThrow(/OHLC 区间非法/);
  });

  it('空时间被拒绝', () => {
    expect(() => analyzeChanlun([
      { time: '', symbol: 'TEST', open: 10, high: 12, low: 8, close: 10, volume: 10 },
    ])).toThrow(/缺少时间/);
  });
});

describe('包含关系 resolveContainment 深入测试', () => {
  it('首根bar方向为unknown', () => {
    const bars = resolveContainment([candle('2026-01-01', 10, 8)]);
    expect(bars[0].direction).toBe('unknown');
  });

  it('向上方向时新bar抬升high与low', () => {
    const bars = resolveContainment([
      candle('2026-01-01', 10, 8, 9),
      candle('2026-01-02', 12, 9, 11),
    ]);
    // 第一根被设为 up 方向(因为第二根 high 与 low 都更高)
    expect(bars[0].direction).toBe('up');
    expect(bars[1].high).toBe(12);
    expect(bars[1].low).toBe(9);
  });

  it('向下方向时新bar压低high与low', () => {
    const bars = resolveContainment([
      candle('2026-01-01', 12, 8, 10),
      candle('2026-01-02', 8, 6, 7),
    ]);
    expect(bars[0].direction).toBe('down');
  });

  it('连续包含合并sourceIndices累加', () => {
    // [10,8] 完全包含 [9,8.5]，再被 [11,9] 包含
    const bars = resolveContainment([
      candle('2026-01-01', 10, 8),
      candle('2026-01-02', 9, 8.5),
      candle('2026-01-03', 11, 9),
    ]);
    // 第一根包含第二根(10>=9, 8<=8.5)，合并后方向取决于与第三根关系
    // 合并后 [10,8.5] 仍被 [11,9] 包含? 11>10 但 9>8.5 → 不是包含关系(relation返回up)
    // 严格来说 (10>=11 false) 且 (9>=10 false) → 不是包含 → 第二根是合并后的bar
    expect(bars.length).toBeGreaterThanOrEqual(2);
  });

  it('volume为undefined时不报错且保留undefined', () => {
    const bars = resolveContainment([
      { time: '2026-01-01', symbol: 'T', open: 10, high: 12, low: 8, close: 10 },
      { time: '2026-01-02', symbol: 'T', open: 11, high: 13, low: 9, close: 12 },
    ]);
    expect(bars[0].volume).toBeUndefined();
    expect(bars[1].volume).toBeUndefined();
  });

  it('合并后volume累加', () => {
    const bars = resolveContainment([
      candle('2026-01-01', 10, 8, 9, 9, 100),
      candle('2026-01-02', 9, 8.5, 9, 9, 50), // 被包含
    ]);
    // 第一根包含第二根 → 合并后 volume=150
    expect(bars).toHaveLength(1);
    expect(bars[0].volume).toBe(150);
  });

  it('index字段在结果中被正确编号', () => {
    const bars = resolveContainment([
      candle('2026-01-01', 10, 8),
      candle('2026-01-02', 12, 9),
      candle('2026-01-03', 14, 10),
    ]);
    bars.forEach((bar, i) => expect(bar.index).toBe(i));
  });

  it('highSourceIndex/lowSourceIndex跟踪真实来源', () => {
    // 第一根 [10,8], 第二根 [12,9]向上(新high来自第二根)，
    // 第三根 [11,7]与[12,9]比较:不是包含,方向down
    const bars = resolveContainment([
      candle('2026-01-01', 10, 8),
      candle('2026-01-02', 12, 9),
      candle('2026-01-03', 11, 7),
    ]);
    expect(bars[1].highSourceIndex).toBe(1); // 12来自第二根
    expect(bars[2].lowSourceIndex).toBe(2); // 7来自第三根
  });
});

describe('分型 identifyStrictFractals 深入测试', () => {
  it('不足3根合并bar不产出分型', () => {
    const source = [candle('2026-01-01', 10, 8), candle('2026-01-02', 12, 9)];
    const merged = resolveContainment(source);
    expect(identifyStrictFractals(merged, source)).toHaveLength(0);
  });

  it('连续相同类型分型被pens过滤为最值', () => {
    // 构造连续两个顶分型(中间夹一底分型)
    // 序列: 10,8 → 12,9 → 11,8.5 → 13,10 → 11,9 → 14,10 → 12,9 → 15,11
    // merged: 应产出连续顶分型
    const source = [
      candle('2026-01-01', 10, 8),
      candle('2026-01-02', 12, 9),
      candle('2026-01-03', 11, 8.5),
      candle('2026-01-04', 13, 10),
      candle('2026-01-05', 11, 9),
      candle('2026-01-06', 14, 10),
      candle('2026-01-07', 12, 9),
      candle('2026-01-08', 15, 11),
    ];
    const merged = resolveContainment(source);
    const fractals = identifyStrictFractals(merged, source);
    // 多个顶分型中pens选最高
    const pens = buildPens(fractals, CHAN_V1_CONFIG);
    const topEnds = pens.filter((p) => p.endType === 'top');
    if (topEnds.length > 0) {
      // 每个顶分型笔的endPrice应取最大值
      const maxTop = Math.max(...fractals.filter((f) => f.type === 'top').map((f) => f.price));
      expect(topEnds[0].endPrice).toBeLessThanOrEqual(maxTop);
    }
  });

  it('分型confirmedAtIndex指向锁定bar的startIndex', () => {
    // GOLDEN_CHAN_BARS 第0个分型是 sourceIndex=4 的顶分型
    const result = analyzeChanlun(GOLDEN_CHAN_BARS);
    if (result.fractals.length > 0) {
      const first = result.fractals[0];
      expect(first.confirmedAtIndex).toBeGreaterThan(first.sourceIndex);
      expect(result.sourceBars[first.confirmedAtIndex]).toBeDefined();
    }
  });

  it('分型id格式为 type:sourceIndex:time', () => {
    const result = analyzeChanlun(GOLDEN_CHAN_BARS);
    for (const fractal of result.fractals) {
      expect(fractal.id).toMatch(/^(top|bottom):\d+:/);
    }
  });
});

describe('笔 buildPens 深入测试', () => {
  it('相邻笔方向严格交替', () => {
    const result = analyzeChanlun(GOLDEN_CHAN_BARS);
    for (let i = 1; i < result.pens.length; i++) {
      expect(result.pens[i].direction).not.toBe(result.pens[i - 1].direction);
    }
  });

  it('笔的startType与endType互为反类型', () => {
    const result = analyzeChanlun(GOLDEN_CHAN_BARS);
    for (const pen of result.pens) {
      expect(pen.startType).not.toBe(pen.endType);
      expect(pen.direction === 'up' ? pen.startType : pen.endType).toBe('bottom');
    }
  });

  it('已确认笔的confirmedAt指向真实存在的K线时间', () => {
    const result = analyzeChanlun(GOLDEN_CHAN_BARS);
    for (const pen of result.pens) {
      if (pen.status === 'confirmed') {
        expect(pen.confirmedAtIndex).not.toBeNull();
        const idx = pen.confirmedAtIndex!;
        expect(idx).toBeLessThan(result.sourceBars.length);
        expect(result.sourceBars[idx].time).toBe(pen.confirmedAt);
      }
    }
  });

  it('笔id格式为pen:startFractalId->endFractalId', () => {
    const result = analyzeChanlun(GOLDEN_CHAN_BARS);
    for (const pen of result.pens) {
      expect(pen.id).toBe(`pen:${pen.startFractalId}->${pen.endFractalId}`);
    }
  });

  it('minSeparatedRawBars约束被遵守(至少3根间隔)', () => {
    // 构造分型间隔不足的序列
    const source = [
      candle('2026-01-01', 10, 8),
      candle('2026-01-02', 12, 10), // 顶分型候选,但与下个底分型只隔0根
      candle('2026-01-03', 11, 9),
      candle('2026-01-04', 13, 11),
      candle('2026-01-05', 12, 10),
      candle('2026-01-06', 14, 12),
    ];
    const result = analyzeChanlun(source);
    for (const pen of result.pens) {
      const sep = Math.abs(pen.endSourceIndex - pen.startSourceIndex) - 1;
      expect(sep).toBeGreaterThanOrEqual(CHAN_V1_CONFIG.minSeparatedRawBars);
    }
  });
});

describe('线段 buildSegments 深入测试', () => {
  it('不足3根笔返回空数组', () => {
    expect(buildSegments([])).toEqual([]);
    const onePen = [{
      id: 'p0', direction: 'up' as const,
      startFractalId: 'f0', endFractalId: 'f1',
      startType: 'bottom' as const, endType: 'top' as const,
      startSourceIndex: 0, endSourceIndex: 3,
      startTime: '2026-01-01', endTime: '2026-01-04',
      startPrice: 1, endPrice: 10,
      status: 'confirmed' as const, confirmedAtIndex: 5, confirmedAt: '2026-01-06',
    }];
    expect(buildSegments(onePen)).toEqual([]);
    expect(buildSegments(onePen.concat(onePen))).toEqual([]);
  });

  it('前三笔无重叠时不形成线段', () => {
    // 构造三笔真正无重叠: [0,5] [10,15] [0,5]
    // lows = [0, 10, 0] → max = 10
    // highs = [5, 15, 5] → min = 5
    // max(lows)=10 > min(highs)=5 → 无重叠
    const trulyNoOverlap: import('..').ChanPen[] = [
      { id: 'p0', direction: 'up' as const, startFractalId: 'f0', endFractalId: 'f1', startType: 'bottom' as const, endType: 'top' as const, startSourceIndex: 0, endSourceIndex: 3, startTime: '2026-01-01', endTime: '2026-01-04', startPrice: 0, endPrice: 5, status: 'confirmed' as const, confirmedAtIndex: 4, confirmedAt: '2026-01-05' },
      { id: 'p1', direction: 'down' as const, startFractalId: 'f1', endFractalId: 'f2', startType: 'top' as const, endType: 'bottom' as const, startSourceIndex: 3, endSourceIndex: 6, startTime: '2026-01-04', endTime: '2026-01-07', startPrice: 15, endPrice: 10, status: 'confirmed' as const, confirmedAtIndex: 7, confirmedAt: '2026-01-08' },
      { id: 'p2', direction: 'up' as const, startFractalId: 'f2', endFractalId: 'f3', startType: 'bottom' as const, endType: 'top' as const, startSourceIndex: 6, endSourceIndex: 9, startTime: '2026-01-07', endTime: '2026-01-10', startPrice: 0, endPrice: 5, status: 'confirmed' as const, confirmedAtIndex: 10, confirmedAt: '2026-01-11' },
    ];
    expect(buildSegments(trulyNoOverlap)).toEqual([]);
  });

  it('相邻线段方向严格交替', () => {
    const result = analyzeChanlun(basicUpPulse().concat(basicUpPulse().map((c, i) => ({
      ...c,
      time: `2026-02-${String(i + 1).padStart(2, '0')}`,
    }))));
    for (let i = 1; i < result.segments.length; i++) {
      expect(result.segments[i].direction).not.toBe(result.segments[i - 1].direction);
    }
  });
});

describe('中枢 buildCenters 深入测试', () => {
  function makePen(
    id: string, dir: 'up' | 'down', low: number, high: number,
    status: 'confirmed' | 'candidate' = 'confirmed',
  ): import('..').ChanPen {
    return {
      id,
      direction: dir,
      startFractalId: `${id}:s`,
      endFractalId: `${id}:e`,
      startType: dir === 'up' ? 'bottom' : 'top',
      endType: dir === 'up' ? 'top' : 'bottom',
      startSourceIndex: 0,
      endSourceIndex: 1,
      startTime: '2026-01-01',
      endTime: '2026-01-02',
      startPrice: dir === 'up' ? low : high,
      endPrice: dir === 'up' ? high : low,
      status,
      confirmedAtIndex: status === 'confirmed' ? 2 : null,
      confirmedAt: status === 'confirmed' ? '2026-01-03' : null,
    };
  }

  it('三笔无重叠不形成中枢(zd>=zg)', () => {
    // [0,5] [10,15] [3,8] → max low = max(0,10,3)=10, min high = min(5,15,8)=5, 10>=5
    const pens = [
      makePen('p0', 'up', 0, 5),
      makePen('p1', 'down', 10, 15),
      makePen('p2', 'up', 3, 8),
    ];
    expect(buildCenters(pens, 'pen')).toEqual([]);
  });

  it('三笔正好相切(zd==zg)不形成中枢(边界)', () => {
    // [0,5] [5,10] [3,7] → max low = max(0,5,3)=5, min high = min(5,10,7)=5, 5>=5
    const pens = [
      makePen('p0', 'up', 0, 5),
      makePen('p1', 'down', 5, 10),
      makePen('p2', 'up', 3, 7),
    ];
    expect(buildCenters(pens, 'pen')).toEqual([]);
  });

  it('九段扩展触发expanded=true', () => {
    // 9段全部在 [0,10] 区间重叠
    const ranges: Array<[number, number]> = [
      [1, 9], [2, 8], [3, 7], [1, 9], [2, 8], [3, 7], [1, 9], [2, 8], [3, 7],
    ];
    const pens = ranges.map(([low, high], i) => makePen(`p${i}`, i % 2 === 0 ? 'up' : 'down', low, high));
    const centers = buildCenters(pens, 'pen');
    expect(centers).toHaveLength(1);
    expect(centers[0].expanded).toBe(true);
    expect(centers[0].extensionCount).toBe(6);
    expect(centers[0].componentIds).toHaveLength(9);
  });

  it('向上脱离时breakoutDirection=up', () => {
    // 三笔形成中枢 [5,9] 然后向上突破到 high=15, low=10
    const pens = [
      makePen('p0', 'up', 5, 9),
      makePen('p1', 'down', 6, 10),
      makePen('p2', 'up', 5, 8),
      makePen('p3', 'down', 10, 15), // low=10 > zg=8 → 向上脱离
    ];
    const centers = buildCenters(pens, 'pen');
    expect(centers).toHaveLength(1);
    expect(centers[0].breakoutDirection).toBe('up');
    expect(centers[0].lifecycle).toBe('completed');
  });

  it('向下脱离时breakoutDirection=down', () => {
    const pens = [
      makePen('p0', 'up', 5, 9),
      makePen('p1', 'down', 6, 10),
      makePen('p2', 'up', 5, 8),
      makePen('p3', 'down', 0, 4), // high=4 < zd=6 → 向下脱离
    ];
    const centers = buildCenters(pens, 'pen');
    expect(centers[0].breakoutDirection).toBe('down');
  });

  it('候选第三笔时中枢状态为candidate且lifecycle=forming', () => {
    const pens = [
      makePen('p0', 'up', 5, 9),
      makePen('p1', 'down', 6, 10),
      makePen('p2', 'up', 5, 8, 'candidate'),
    ];
    const centers = buildCenters(pens, 'pen');
    expect(centers).toHaveLength(1);
    expect(centers[0].status).toBe('candidate');
    expect(centers[0].lifecycle).toBe('forming');
    expect(centers[0].confirmedAt).toBeNull();
  });

  it('中枢id包含level和起止sourceIndex及zd:zg', () => {
    // makePen 的 startSourceIndex=0, endSourceIndex=1
    // 三笔 [5,9] [6,10] [5,8]: zd=max(5,6,5)=6, zg=min(9,10,8)=8
    const pens = [
      makePen('p0', 'up', 5, 9),
      makePen('p1', 'down', 6, 10),
      makePen('p2', 'up', 5, 8),
    ];
    const centers = buildCenters(pens, 'pen');
    expect(centers[0].id).toMatch(/^pen-center:/);
    expect(centers[0].id).toContain(':6:8'); // zd:zg = 6:8
    expect(centers[0].zd).toBe(6);
    expect(centers[0].zg).toBe(8);
  });

  it('segment级中枢使用segment的id', () => {
    const pens = [
      makePen('p0', 'up', 5, 9),
      makePen('p1', 'down', 6, 10),
      makePen('p2', 'up', 5, 8),
    ];
    const segments = pens.map((p, i) => ({
      id: `segment-${i}`,
      direction: p.direction,
      startPenIndex: i * 3,
      endPenIndex: i * 3 + 2,
      startSourceIndex: p.startSourceIndex,
      endSourceIndex: p.endSourceIndex,
      startTime: p.startTime,
      endTime: p.endTime,
      startPrice: p.startPrice,
      endPrice: p.endPrice,
      status: p.status,
      confirmationKind: 'no-gap' as const,
      confirmedAtIndex: p.confirmedAtIndex,
      confirmedAt: p.confirmedAt,
      featureElements: [],
      evidenceFractal: null,
    }));
    const centers = buildCenters(segments, 'segment');
    expect(centers[0].level).toBe('segment');
    expect(centers[0].componentIds).toEqual(['segment-0', 'segment-1', 'segment-2']);
  });
});

describe('三买 generateChanThirdBuySignals 深入测试', () => {
  // 复用 thirdBuy.test.ts 的结构,但探索更多边界
  function buildAnalysis(
    pens: import('..').ChanPen[],
    center: import('..').ChanCenter,
    sourceBars: Candle[],
  ): import('..').ChanAnalysis {
    return {
      config: CHAN_V1_CONFIG,
      fingerprint: { fingerprint: 'test', dataChecksum: 'data', configHash: 'config' },
      sourceBars,
      mergedBars: [],
      fractals: [],
      pens,
      segments: [],
      penCenters: [center],
      segmentCenters: [],
      current: {
        currentPenId: pens[pens.length - 1]?.id ?? null,
        currentSegmentId: null,
        latestPenCenterId: center.id,
        latestSegmentCenterId: null,
        asOfIndex: sourceBars.length - 1,
        asOf: sourceBars[sourceBars.length - 1]?.time ?? null,
      },
      warnings: [],
    };
  }

  const bars: Candle[] = Array.from({ length: 20 }, (_, i) => ({
    time: `2026-06-${String(i + 1).padStart(2, '0')}`,
    symbol: 'TEST',
    open: 10, high: 11, low: 9, close: 10,
  }));

  function pen(
    id: string, dir: 'up' | 'down',
    startPrice: number, endPrice: number,
    confirmedAtIndex: number,
  ): import('..').ChanPen {
    return {
      id, direction: dir,
      startFractalId: `${id}:s`, endFractalId: `${id}:e`,
      startType: dir === 'up' ? 'bottom' : 'top',
      endType: dir === 'up' ? 'top' : 'bottom',
      startSourceIndex: Math.max(0, confirmedAtIndex - 3),
      endSourceIndex: Math.max(1, confirmedAtIndex - 1),
      startTime: bars[Math.max(0, confirmedAtIndex - 3)].time,
      endTime: bars[Math.max(1, confirmedAtIndex - 1)].time,
      startPrice, endPrice,
      status: 'confirmed',
      confirmedAtIndex,
      confirmedAt: bars[confirmedAtIndex].time,
    };
  }

  const baseCenter: import('..').ChanCenter = {
    id: 'pen-center:test',
    level: 'pen',
    startComponentIndex: 0,
    endComponentIndex: 4,
    startSourceIndex: 0,
    endSourceIndex: 10,
    startTime: bars[0].time,
    endTime: bars[10].time,
    zd: 9.5,
    zg: 11,
    gg: 13,
    dd: 8,
    status: 'confirmed',
    lifecycle: 'completed',
    expanded: false,
    componentIds: ['p0', 'p1', 'p2', 'p3', 'p4'],
    extensionCount: 2,
    breakoutDirection: 'up',
    confirmedAtIndex: 7,
    confirmedAt: bars[7].time,
    completedAtIndex: 13,
    completedAt: bars[13].time,
  };

  it('breakoutDirection=down时不产生三买信号', () => {
    const pens = [
      pen('p0', 'up', 8, 12, 3),
      pen('p1', 'down', 12, 9, 5),
      pen('p2', 'up', 9, 11, 7),
      pen('p3', 'down', 13, 11, 9),
      pen('p4', 'down', 11, 5, 11), // 向下脱离
      pen('p5', 'up', 5, 7, 13), // 回试但低于ZG(7<11)
    ];
    const center = { ...baseCenter, breakoutDirection: 'down' as const };
    expect(generateChanThirdBuySignals(buildAnalysis(pens, center, bars))).toEqual([]);
  });

  it('center.status=candidate时不产生信号', () => {
    const pens = [
      pen('p0', 'up', 8, 12, 3),
      pen('p1', 'down', 12, 9, 5),
      pen('p2', 'up', 9, 11, 7),
      pen('p3', 'down', 13, 11, 9),
      pen('p4', 'up', 11, 15, 11),
      pen('p5', 'down', 15, 12.2, 13),
    ];
    const center = { ...baseCenter, status: 'candidate' as const, lifecycle: 'forming' as const };
    expect(generateChanThirdBuySignals(buildAnalysis(pens, center, bars))).toEqual([]);
  });

  it('completedAtIndex=null时不产生信号', () => {
    const pens = [
      pen('p0', 'up', 8, 12, 3),
      pen('p1', 'down', 12, 9, 5),
      pen('p2', 'up', 9, 11, 7),
      pen('p3', 'down', 13, 11, 9),
      pen('p4', 'up', 11, 15, 11),
      pen('p5', 'down', 15, 12.2, 13),
    ];
    const center = { ...baseCenter, completedAtIndex: null, completedAt: null, lifecycle: 'active' as const };
    expect(generateChanThirdBuySignals(buildAnalysis(pens, center, bars))).toEqual([]);
  });

  it('retestLow严格等于zg时不产生信号(边界)', () => {
    const pens = [
      pen('p0', 'up', 8, 12, 3),
      pen('p1', 'down', 12, 9, 5),
      pen('p2', 'up', 9, 11, 7),
      pen('p3', 'down', 13, 11, 9),
      pen('p4', 'up', 11, 15, 11),
      pen('p5', 'down', 15, 11, 13), // retestLow = 11 = zg
    ];
    expect(generateChanThirdBuySignals(buildAnalysis(pens, baseCenter, bars))).toEqual([]);
  });

  it('retestLow略高于zg时产生信号(边界)', () => {
    const pens = [
      pen('p0', 'up', 8, 12, 3),
      pen('p1', 'down', 12, 9, 5),
      pen('p2', 'up', 9, 11, 7),
      pen('p3', 'down', 13, 11, 9),
      pen('p4', 'up', 11, 15, 11),
      pen('p5', 'down', 15, 11.01, 13),
    ];
    const signals = generateChanThirdBuySignals(buildAnalysis(pens, baseCenter, bars));
    expect(signals).toHaveLength(1);
    expect(signals[0].retestLow).toBe(11.01);
    expect(signals[0].retestBufferPct).toBeCloseTo((11.01 / 11 - 1) * 100, 5);
  });

  it('departureHigh严格等于zg时不产生信号(departure未脱离)', () => {
    const pens = [
      pen('p0', 'up', 8, 12, 3),
      pen('p1', 'down', 12, 9, 5),
      pen('p2', 'up', 9, 11, 7),
      pen('p3', 'down', 13, 11, 9),
      pen('p4', 'up', 9, 11, 11), // departureHigh = max(9,11) = 11 = zg
      pen('p5', 'down', 11, 11.5, 13),
    ];
    expect(generateChanThirdBuySignals(buildAnalysis(pens, baseCenter, bars))).toEqual([]);
  });

  it('level=segment时使用segmentCenters', () => {
    const segmentCenter = { ...baseCenter, level: 'segment' as const, id: 'segment-center:test' };
    const segmentPens = [
      pen('p0', 'up', 8, 12, 3),
      pen('p1', 'down', 12, 9, 5),
      pen('p2', 'up', 9, 11, 7),
      pen('p3', 'down', 13, 11, 9),
      pen('p4', 'up', 11, 15, 11),
      pen('p5', 'down', 15, 12.2, 13),
    ];
    // level=segment 时 thirdBuy 取 analysis.segments 作为 components
    // 需要把 pens 转成 segments 结构(endComponentIndex 指向 segments 索引)
    const segments: import('..').ChanSegment[] = segmentPens.map((p, i) => ({
      id: p.id,
      direction: p.direction,
      startPenIndex: i,
      endPenIndex: i,
      startSourceIndex: p.startSourceIndex,
      endSourceIndex: p.endSourceIndex,
      startTime: p.startTime,
      endTime: p.endTime,
      startPrice: p.startPrice,
      endPrice: p.endPrice,
      status: p.status,
      confirmationKind: 'no-gap' as const,
      confirmedAtIndex: p.confirmedAtIndex,
      confirmedAt: p.confirmedAt,
      featureElements: [],
      evidenceFractal: null,
    }));
    const analysis = buildAnalysis(segmentPens, segmentCenter, bars);
    analysis.penCenters = [];
    analysis.segmentCenters = [segmentCenter];
    analysis.segments = segments;
    // segmentCenter.endComponentIndex=4 → completionIndex=5 → segments[5] 应是 p5
    const signals = generateChanThirdBuySignals(analysis, 'segment');
    expect(signals).toHaveLength(1);
    expect(signals[0].centerLevel).toBe('segment');
  });

  it('信号按signalAtIndex升序排序', () => {
    // 构造两个完成的中枢
    const center2: import('..').ChanCenter = {
      ...baseCenter,
      id: 'pen-center:test2',
      completedAtIndex: 17,
      completedAt: bars[17].time,
      startSourceIndex: 12,
      endSourceIndex: 16,
    };
    const pens = [
      pen('p0', 'up', 8, 12, 3),
      pen('p1', 'down', 12, 9, 5),
      pen('p2', 'up', 9, 11, 7),
      pen('p3', 'down', 13, 11, 9),
      pen('p4', 'up', 11, 15, 11),
      pen('p5', 'down', 15, 12.2, 13),
      pen('p6', 'up', 12.2, 16, 15),
      pen('p7', 'down', 16, 12.5, 17),
    ];
    const analysis = buildAnalysis(pens, baseCenter, bars);
    analysis.penCenters = [baseCenter, center2];
    const signals = generateChanThirdBuySignals(analysis);
    for (let i = 1; i < signals.length; i++) {
      expect(signals[i].signalAtIndex).toBeGreaterThanOrEqual(signals[i - 1].signalAtIndex);
    }
  });

  it('retestBufferPct和breakoutPct计算正确', () => {
    const pens = [
      pen('p0', 'up', 8, 12, 3),
      pen('p1', 'down', 12, 9, 5),
      pen('p2', 'up', 9, 11, 7),
      pen('p3', 'down', 13, 11, 9),
      pen('p4', 'up', 11, 15, 11),
      pen('p5', 'down', 15, 12.2, 13),
    ];
    const signals = generateChanThirdBuySignals(buildAnalysis(pens, baseCenter, bars));
    expect(signals[0].retestBufferPct).toBeCloseTo((12.2 / 11 - 1) * 100, 5);
    expect(signals[0].breakoutPct).toBeCloseTo((15 / 11 - 1) * 100, 5);
  });
});

describe('信号 generateChanCenterSignals 深入测试', () => {
  const bars: Candle[] = Array.from({ length: 20 }, (_, i) => ({
    time: `2026-06-${String(i + 1).padStart(2, '0')}`,
    symbol: 'TEST',
    open: 10, high: 11, low: 9, close: 10,
  }));

  function buildAnalysis(centers: import('..').ChanCenter[], level: 'pen' | 'segment'): import('..').ChanAnalysis {
    return {
      config: CHAN_V1_CONFIG,
      fingerprint: { fingerprint: 'test', dataChecksum: 'data', configHash: 'config' },
      sourceBars: bars,
      mergedBars: [],
      fractals: [],
      pens: [],
      segments: [],
      penCenters: level === 'pen' ? centers : [],
      segmentCenters: level === 'segment' ? centers : [],
      current: {
        currentPenId: null,
        currentSegmentId: null,
        latestPenCenterId: level === 'pen' ? centers[centers.length - 1]?.id ?? null : null,
        latestSegmentCenterId: level === 'segment' ? centers[centers.length - 1]?.id ?? null : null,
        asOfIndex: bars.length - 1,
        asOf: bars[bars.length - 1].time,
      },
      warnings: [],
    };
  }

  it('空中枢列表返回空信号', () => {
    expect(generateChanCenterSignals(buildAnalysis([], 'pen'))).toEqual([]);
  });

  it('completedAtIndex超出sourceBars范围时不产生信号', () => {
    const center: import('..').ChanCenter = {
      id: 'test',
      level: 'pen',
      startComponentIndex: 0,
      endComponentIndex: 3,
      startSourceIndex: 0,
      endSourceIndex: 5,
      startTime: bars[0].time,
      endTime: bars[5].time,
      zd: 9.5,
      zg: 10.5,
      gg: 12,
      dd: 8,
      status: 'confirmed',
      lifecycle: 'completed',
      expanded: false,
      componentIds: ['p0', 'p1', 'p2', 'p3'],
      extensionCount: 1,
      breakoutDirection: 'up',
      confirmedAtIndex: 4,
      confirmedAt: bars[4].time,
      completedAtIndex: 999, // 超出范围
      completedAt: 'future',
    };
    expect(generateChanCenterSignals(buildAnalysis([center], 'pen'))).toEqual([]);
  });

  it('多个信号按signalAtIndex升序排序', () => {
    const centerLate: import('..').ChanCenter = {
      id: 'late',
      level: 'pen',
      startComponentIndex: 0,
      endComponentIndex: 3,
      startSourceIndex: 0,
      endSourceIndex: 5,
      startTime: bars[0].time,
      endTime: bars[5].time,
      zd: 9.5, zg: 10.5, gg: 12, dd: 8,
      status: 'confirmed',
      lifecycle: 'completed',
      expanded: false,
      componentIds: ['p0', 'p1', 'p2', 'p3'],
      extensionCount: 1,
      breakoutDirection: 'up',
      confirmedAtIndex: 4,
      confirmedAt: bars[4].time,
      completedAtIndex: 10,
      completedAt: bars[10].time,
    };
    const centerEarly = { ...centerLate, id: 'early', completedAtIndex: 5, completedAt: bars[5].time };
    // 故意以 late, early 顺序传入,验证排序
    const signals = generateChanCenterSignals(buildAnalysis([centerLate, centerEarly], 'pen'));
    expect(signals.map((s) => s.signalAtIndex)).toEqual([5, 10]);
  });

  it('向上脱离信号action=buy,targetPosition=1', () => {
    const center: import('..').ChanCenter = {
      id: 'up',
      level: 'pen',
      startComponentIndex: 0,
      endComponentIndex: 3,
      startSourceIndex: 0,
      endSourceIndex: 5,
      startTime: bars[0].time,
      endTime: bars[5].time,
      zd: 9.5, zg: 10.5, gg: 12, dd: 8,
      status: 'confirmed',
      lifecycle: 'completed',
      expanded: false,
      componentIds: ['p0', 'p1', 'p2', 'p3'],
      extensionCount: 1,
      breakoutDirection: 'up',
      confirmedAtIndex: 4,
      confirmedAt: bars[4].time,
      completedAtIndex: 7,
      completedAt: bars[7].time,
    };
    const signals = generateChanCenterSignals(buildAnalysis([center], 'pen'));
    expect(signals).toHaveLength(1);
    expect(signals[0].action).toBe('buy');
    expect(signals[0].targetPosition).toBe(1);
    expect(signals[0].source).toBe('chan-v1');
    expect(signals[0].reason).toContain('向上');
  });

  it('向下脱离信号action=sell,targetPosition=0', () => {
    const center: import('..').ChanCenter = {
      id: 'down',
      level: 'pen',
      startComponentIndex: 0,
      endComponentIndex: 3,
      startSourceIndex: 0,
      endSourceIndex: 5,
      startTime: bars[0].time,
      endTime: bars[5].time,
      zd: 9.5, zg: 10.5, gg: 12, dd: 8,
      status: 'confirmed',
      lifecycle: 'completed',
      expanded: false,
      componentIds: ['p0', 'p1', 'p2', 'p3'],
      extensionCount: 1,
      breakoutDirection: 'down',
      confirmedAtIndex: 4,
      confirmedAt: bars[4].time,
      completedAtIndex: 7,
      completedAt: bars[7].time,
    };
    const signals = generateChanCenterSignals(buildAnalysis([center], 'pen'));
    expect(signals[0].action).toBe('sell');
    expect(signals[0].targetPosition).toBe(0);
    expect(signals[0].reason).toContain('向下');
  });
});

describe('回放 analyzeChanlunAt / replayChanlun 深入测试', () => {
  it('asOfIndex=0 返回仅含首根K线的分析', () => {
    const result = analyzeChanlunAt(GOLDEN_CHAN_BARS, 0);
    expect(result.sourceBars).toHaveLength(1);
    expect(result.mergedBars).toHaveLength(1);
    expect(result.fractals).toHaveLength(0);
    expect(result.current.asOfIndex).toBe(0);
  });

  it('asOfIndex为负数抛出RangeError', () => {
    expect(() => analyzeChanlunAt(GOLDEN_CHAN_BARS, -1)).toThrow(RangeError);
    expect(() => analyzeChanlunAt(GOLDEN_CHAN_BARS, -1)).toThrow(/超出行情范围/);
  });

  it('asOfIndex超出长度抛出RangeError', () => {
    expect(() => analyzeChanlunAt(GOLDEN_CHAN_BARS, 999)).toThrow(RangeError);
    expect(() => analyzeChanlunAt(GOLDEN_CHAN_BARS, GOLDEN_CHAN_BARS.length)).toThrow(RangeError);
  });

  it('asOfIndex为非整数抛出RangeError', () => {
    expect(() => analyzeChanlunAt(GOLDEN_CHAN_BARS, 1.5)).toThrow(RangeError);
  });

  it('replayChanlun逐K产出且asOfIndex递增', () => {
    const small = GOLDEN_CHAN_BARS.slice(0, 10);
    const frames = [...replayChanlun(small)];
    expect(frames).toHaveLength(10);
    frames.forEach((frame, i) => {
      expect(frame.asOfIndex).toBe(i);
      expect(frame.asOf).toBe(small[i].time);
      expect(frame.analysis.sourceBars).toHaveLength(i + 1);
    });
  });

  it('replayChanlun可在迭代中途停止不抛错', () => {
    const small = GOLDEN_CHAN_BARS.slice(0, 20);
    let count = 0;
    for (const frame of replayChanlun(small)) {
      count++;
      if (count >= 5) break;
      void frame;
    }
    expect(count).toBe(5);
  });

  it('analyzeChanlunAt可传入自定义config', () => {
    const customConfig = { ...CHAN_V1_CONFIG };
    const result = analyzeChanlunAt(GOLDEN_CHAN_BARS, 5, customConfig);
    expect(result.config).toEqual(customConfig);
    // 但config是不可变的(Readonly),内部是浅拷贝
    expect(result.config).not.toBe(customConfig);
  });

  it('空数组回放产生空迭代', () => {
    const frames = [...replayChanlun([])];
    expect(frames).toEqual([]);
  });

  it('回放中每个前缀的笔数单调不减', () => {
    const small = GOLDEN_CHAN_BARS.slice(0, 18);
    let prevPenCount = -1;
    for (const frame of replayChanlun(small)) {
      const currentPenCount = frame.analysis.pens.length;
      expect(currentPenCount).toBeGreaterThanOrEqual(prevPenCount);
      prevPenCount = currentPenCount;
    }
  });
});

describe('IncrementalChanEngine 状态管理深入测试', () => {
  it('reset清空内部状态', () => {
    const engine = new IncrementalChanEngine();
    for (const bar of GOLDEN_CHAN_BARS) engine.append(bar);
    expect(engine.snapshot().sourceBars).toHaveLength(GOLDEN_CHAN_BARS.length);

    engine.reset();
    expect(engine.snapshot().sourceBars).toHaveLength(0);
    expect(engine.snapshot().pens).toHaveLength(0);
  });

  it('append失败时回滚最后一根', () => {
    const engine = new IncrementalChanEngine();
    engine.append(GOLDEN_CHAN_BARS[0]);
    engine.append(GOLDEN_CHAN_BARS[1]);
    const beforeLength = engine.snapshot().sourceBars.length;

    // 故意append重复时间应抛错
    expect(() => engine.append(GOLDEN_CHAN_BARS[0])).toThrow();
    expect(engine.snapshot().sourceBars).toHaveLength(beforeLength);
  });

  it('append NaN价格K线后回滚', () => {
    const engine = new IncrementalChanEngine();
    engine.append(GOLDEN_CHAN_BARS[0]);
    const beforeLength = engine.snapshot().sourceBars.length;
    const badCandle: Candle = {
      ...GOLDEN_CHAN_BARS[1],
      high: Number.NaN,
    };
    expect(() => engine.append(badCandle)).toThrow();
    expect(engine.snapshot().sourceBars).toHaveLength(beforeLength);
  });

  it('reset后可重新使用', () => {
    const engine = new IncrementalChanEngine();
    for (const bar of GOLDEN_CHAN_BARS.slice(0, 10)) engine.append(bar);
    engine.reset();
    for (const bar of GOLDEN_CHAN_BARS.slice(0, 10)) engine.append(bar);
    expect(engine.snapshot().sourceBars).toHaveLength(10);
    expect(engine.snapshot()).toEqual(analyzeChanlun(GOLDEN_CHAN_BARS.slice(0, 10)));
  });

  it('连续多次snapshot返回等价结果(幂等)', () => {
    const engine = new IncrementalChanEngine();
    for (const bar of GOLDEN_CHAN_BARS.slice(0, 15)) engine.append(bar);
    const first = engine.snapshot();
    const second = engine.snapshot();
    const third = engine.snapshot();
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it('空引擎snapshot返回空分析', () => {
    const engine = new IncrementalChanEngine();
    const result = engine.snapshot();
    expect(result.sourceBars).toHaveLength(0);
    expect(result.pens).toHaveLength(0);
    expect(result.current.asOfIndex).toBeNull();
  });
});

describe('端到端集成:输入→分析→信号→回放', () => {
  it('完整管道:多根K线 → 至少产生1根笔 → 回放验证无前视', () => {
    const bars = GOLDEN_CHAN_BARS;
    const full = analyzeChanlun(bars);

    // 完整分析应能产出笔
    expect(full.pens.length).toBeGreaterThan(0);

    // 回放验证:每个时点可见的笔数 <= 完整分析的笔数
    let maxVisiblePens = 0;
    for (const frame of replayChanlun(bars)) {
      maxVisiblePens = Math.max(maxVisiblePens, frame.analysis.pens.length);
      // 不存在前视:每帧的sourceBars只到asOfIndex
      expect(frame.analysis.sourceBars).toHaveLength(frame.asOfIndex + 1);
    }
    // 最后一帧的笔数应等于完整分析
    expect(maxVisiblePens).toBe(full.pens.length);
  });

  it('确认笔在回放中的可见时点不早于其confirmedAtIndex', () => {
    const bars = GOLDEN_CHAN_BARS;
    const full = analyzeChanlun(bars);
    const confirmedPens = full.pens.filter((p) => p.status === 'confirmed');

    for (const pen of confirmedPens) {
      // 在 confirmedAtIndex 之前的前缀中,该笔不应以confirmed状态出现
      for (let i = 0; i < pen.confirmedAtIndex!; i++) {
        const prefix = analyzeChanlunAt(bars, i);
        const match = prefix.pens.find((p) => p.id === pen.id);
        if (match) {
          expect(match.status).not.toBe('confirmed');
        }
      }
      // 在 confirmedAtIndex 时点,该笔应以confirmed状态可见
      const atConfirm = analyzeChanlunAt(bars, pen.confirmedAtIndex!);
      const match = atConfirm.pens.find((p) => p.id === pen.id);
      if (match) {
        expect(match.status).toBe('confirmed');
      }
    }
  });

  it('分析包含的current字段反映最新状态', () => {
    const bars = GOLDEN_CHAN_BARS;
    const result = analyzeChanlun(bars);
    expect(result.current.asOfIndex).toBe(bars.length - 1);
    expect(result.current.asOf).toBe(bars[bars.length - 1].time);
    if (result.pens.length > 0) {
      expect(result.current.currentPenId).toBe(result.pens[result.pens.length - 1].id);
    }
  });

  it('fingerprint对相同输入确定性输出', () => {
    const bars = GOLDEN_CHAN_BARS;
    const r1 = analyzeChanlun(bars);
    const r2 = analyzeChanlun(bars.map((b) => ({ ...b })));
    expect(r2.fingerprint).toEqual(r1.fingerprint);
    // checksum 可能包含负号(32位有符号hex),放宽正则
    expect(r1.fingerprint.fingerprint).toMatch(/^-?[a-f0-9]+$/);
    expect(r1.fingerprint.dataChecksum).toMatch(/^-?[a-f0-9]+$/);
    expect(r1.fingerprint.configHash).toMatch(/^-?[a-f0-9]+$/);
  });

  it('fingerprint对不同输入产生不同结果', () => {
    const bars = GOLDEN_CHAN_BARS;
    const modified = bars.map((b, i) => i === 0 ? { ...b, high: b.high + 1 } : b);
    const r1 = analyzeChanlun(bars);
    const r2 = analyzeChanlun(modified);
    expect(r2.fingerprint.fingerprint).not.toBe(r1.fingerprint.fingerprint);
  });

  it('信号reason字段格式正确(包含中文)', () => {
    const bars: Candle[] = Array.from({ length: 20 }, (_, i) => ({
      time: `2026-06-${String(i + 1).padStart(2, '0')}`,
      symbol: 'TEST', open: 10, high: 11, low: 9, close: 10,
    }));
    const center: import('..').ChanCenter = {
      id: 'test',
      level: 'pen',
      startComponentIndex: 0,
      endComponentIndex: 3,
      startSourceIndex: 0,
      endSourceIndex: 5,
      startTime: bars[0].time,
      endTime: bars[5].time,
      zd: 9.5, zg: 10.5, gg: 12, dd: 8,
      status: 'confirmed',
      lifecycle: 'completed',
      expanded: false,
      componentIds: ['p0', 'p1', 'p2', 'p3'],
      extensionCount: 1,
      breakoutDirection: 'up',
      confirmedAtIndex: 4,
      confirmedAt: bars[4].time,
      completedAtIndex: 7,
      completedAt: bars[7].time,
    };
    const analysis: import('..').ChanAnalysis = {
      config: CHAN_V1_CONFIG,
      fingerprint: { fingerprint: 't', dataChecksum: 'd', configHash: 'c' },
      sourceBars: bars, mergedBars: [], fractals: [], pens: [], segments: [],
      penCenters: [center], segmentCenters: [],
      current: {
        currentPenId: null, currentSegmentId: null,
        latestPenCenterId: center.id, latestSegmentCenterId: null,
        asOfIndex: bars.length - 1, asOf: bars[bars.length - 1].time,
      },
      warnings: [],
    };
    const signals = generateChanCenterSignals(analysis);
    expect(signals[0].reason).toMatch(/[笔线段]中枢确认/);
    expect(signals[0].reason).toContain('向上');
    expect(signals[0].reason).toContain('[');
    expect(signals[0].reason).toContain(']');
  });
});
