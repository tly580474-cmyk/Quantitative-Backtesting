import { describe, expect, it } from 'vitest';
import { analyzeChanlun } from '@/features/chanlun';
import { GOLDEN_CHAN_BARS } from '@/features/chanlun/__tests__/fixtures';
import {
  buildChanRenderModel,
  ChanStructurePrimitive,
  getChanCenterStyle,
  getChanPenStyle,
  getChanSegmentStyle,
} from '../ChanStructurePrimitive';

describe('ChanStructurePrimitive render model', () => {
  const analysis = analyzeChanlun(GOLDEN_CHAN_BARS.slice(0, 18));
  const hiddenCenters = { penCenters: false, segmentCenters: false };

  it('exposes pens and fractals independently', () => {
    expect(buildChanRenderModel(analysis, { pens: true, fractals: false, segments: false, ...hiddenCenters })).toEqual({
      pens: analysis.pens,
      fractals: [],
      segments: [],
      penCenters: [],
      segmentCenters: [],
    });
    expect(buildChanRenderModel(analysis, { pens: false, fractals: true, segments: false, ...hiddenCenters })).toEqual({
      pens: [],
      fractals: analysis.fractals,
      segments: [],
      penCenters: [],
      segmentCenters: [],
    });
  });

  it('updates visibility without mutating the analysis', () => {
    const primitive = new ChanStructurePrimitive();
    primitive.setAnalysis(analysis);
    primitive.setVisibility({ pens: false, fractals: true, segments: false, ...hiddenCenters });

    expect(primitive.getRenderModel().pens).toHaveLength(0);
    expect(primitive.getRenderModel().fractals).toHaveLength(3);
    expect(analysis.pens).toHaveLength(2);
  });

  it('preserves confirmed and candidate status for visual styling', () => {
    const model = buildChanRenderModel(analysis, {
      pens: true,
      fractals: true,
      segments: true,
      penCenters: true,
      segmentCenters: true,
    });
    expect(model.pens.map((pen) => pen.status)).toEqual(['confirmed', 'candidate']);
    expect(getChanPenStyle('confirmed')).toMatchObject({
      color: '#7C3AED',
      lineDash: [],
      alpha: 1,
    });
    expect(getChanPenStyle('candidate')).toMatchObject({
      color: '#F59E0B',
      lineDash: [7, 5],
      alpha: 0.9,
    });
    expect(getChanSegmentStyle('confirmed')).toMatchObject({ color: '#2563EB', lineDash: [] });
    expect(getChanSegmentStyle('candidate')).toMatchObject({ color: '#60A5FA', lineDash: [9, 6] });
    expect(getChanCenterStyle('pen', 'confirmed')).toMatchObject({ stroke: '#7C3AED', lineDash: [] });
    expect(getChanCenterStyle('segment', 'candidate')).toMatchObject({ stroke: '#2563EB', lineDash: [5, 4] });
  });
});
