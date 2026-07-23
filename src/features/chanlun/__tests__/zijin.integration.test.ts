import { describe, expect, it } from 'vitest';
import type { Candle } from '@/models';
import {
  analyzeChanlun,
  generateChanCenterSignals,
  IncrementalChanEngine,
  replayChanlun,
} from '..';
import zijinBarsJson from './fixtures/zijin-601899-daily-500.json';

const zijinBars = zijinBarsJson as Candle[];

describe('601899.SH 500-day offline golden sample', () => {
  it('keeps a frozen structure summary for the fixed adjusted daily sample', () => {
    const analysis = analyzeChanlun(zijinBars);
    const summary = {
      fingerprint: analysis.fingerprint.fingerprint,
      mergedBars: analysis.mergedBars.length,
      fractals: analysis.fractals.length,
      confirmedPens: analysis.pens.filter((item) => item.status === 'confirmed').length,
      candidatePens: analysis.pens.filter((item) => item.status === 'candidate').length,
      confirmedSegments: analysis.segments.filter((item) => item.status === 'confirmed').length,
      candidateSegments: analysis.segments.filter((item) => item.status === 'candidate').length,
      penCenters: analysis.penCenters.length,
      segmentCenters: analysis.segmentCenters.length,
      penSignals: generateChanCenterSignals(analysis, 'pen').length,
      segmentSignals: generateChanCenterSignals(analysis, 'segment').length,
    };

    expect(zijinBars).toHaveLength(500);
    expect(zijinBars[0].time).toBe('2024-07-01');
    expect(zijinBars[499].time).toBe('2026-07-22');
    expect(summary).toEqual({
      fingerprint: '5e0d7df3',
      mergedBars: 408,
      fractals: 189,
      confirmedPens: 50,
      candidatePens: 1,
      confirmedSegments: 2,
      candidateSegments: 1,
      penCenters: 7,
      segmentCenters: 0,
      penSignals: 6,
      segmentSignals: 0,
    });
  });

  it('matches append-only and batch results byte-for-byte', () => {
    const engine = new IncrementalChanEngine();
    for (const candle of zijinBars) engine.append(candle);
    expect(engine.snapshot()).toEqual(analyzeChanlun(zijinBars));
  });

  it('keeps structural endpoints and confirmation evidence inside the source range', () => {
    const analysis = analyzeChanlun(zijinBars);
    const structures = [...analysis.pens, ...analysis.segments];

    for (const structure of structures) {
      expect(structure.startSourceIndex).toBeGreaterThanOrEqual(0);
      expect(structure.endSourceIndex).toBeLessThan(zijinBars.length);
      if (structure.status === 'confirmed') {
        expect(structure.confirmedAtIndex).not.toBeNull();
        expect(structure.confirmedAtIndex!).toBeLessThan(zijinBars.length);
        expect(structure.confirmedAt).toBe(zijinBars[structure.confirmedAtIndex!].time);
      }
    }
    for (let index = 1; index < analysis.pens.length; index += 1) {
      expect(analysis.pens[index].direction).not.toBe(analysis.pens[index - 1].direction);
    }
    for (let index = 1; index < analysis.segments.length; index += 1) {
      expect(analysis.segments[index].direction).not.toBe(analysis.segments[index - 1].direction);
    }
  });

  it('replays signals only on the prefix where their confirmation becomes visible', () => {
    const audited = [...replayChanlun(zijinBars)]
      .flatMap(({ asOfIndex, analysis }) => [
        ...generateChanCenterSignals(analysis, 'pen'),
        ...generateChanCenterSignals(analysis, 'segment'),
      ].filter((signal) => signal.signalAtIndex === asOfIndex))
      .map((signal) => `${signal.centerLevel}:${signal.centerId}:${signal.signalAtIndex}:${signal.action}`);
    const full = ['pen', 'segment']
      .flatMap((level) => generateChanCenterSignals(
        analyzeChanlun(zijinBars),
        level as 'pen' | 'segment',
      ))
      .map((signal) => `${signal.centerLevel}:${signal.centerId}:${signal.signalAtIndex}:${signal.action}`);

    expect(audited).toEqual(full);
  });
});
