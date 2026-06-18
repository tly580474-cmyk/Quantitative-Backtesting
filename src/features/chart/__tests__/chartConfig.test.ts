import { describe, expect, it } from 'vitest';
import {
  calculateMainChartHeight,
  formatVolumeInYi,
  getMacdHistogramColor,
  MAIN_CHART_MIN_HEIGHT,
  CHART_COLORS,
} from '../chartConfig';

describe('formatVolumeInYi', () => {
  it('formats raw volume values in hundred millions', () => {
    expect(formatVolumeInYi(30_390_837_800)).toBe('303.91亿');
    expect(formatVolumeInYi(100_000_000)).toBe('1.00亿');
  });
});

describe('getMacdHistogramColor', () => {
  it('uses red above zero and green below zero', () => {
    expect(getMacdHistogramColor(1)).toBe(CHART_COLORS.up);
    expect(getMacdHistogramColor(0)).toBe(CHART_COLORS.up);
    expect(getMacdHistogramColor(-1)).toBe(CHART_COLORS.down);
  });
});

describe('calculateMainChartHeight', () => {
  it('fills viewport when no panes', () => {
    expect(calculateMainChartHeight(900)).toBe(900);
    expect(calculateMainChartHeight(720)).toBe(720);
  });

  it('deducts pane space when panes are provided', () => {
    expect(calculateMainChartHeight(900, 2)).toBe(600);
    expect(calculateMainChartHeight(900, 3)).toBe(450);
  });

  it('keeps the main chart usable in a short viewport', () => {
    expect(calculateMainChartHeight(500, 2)).toBe(MAIN_CHART_MIN_HEIGHT);
    expect(calculateMainChartHeight(500, 3)).toBe(MAIN_CHART_MIN_HEIGHT);
  });
});
