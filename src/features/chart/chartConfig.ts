export const CHART_COLORS = {
  up: '#EF4444',       // Red for up (Chinese market)
  down: '#22C55E',     // Green for down (Chinese market)
  wickUp: '#EF4444',
  wickDown: '#22C55E',
  volume: 'rgba(239, 68, 68, 0.5)',
  volumeDown: 'rgba(34, 197, 94, 0.5)',
  crosshair: '#9CA3AF',
  grid: '#F0F0F0',
  text: '#333333',
  background: '#FFFFFF',
};

export const MAIN_CHART_HEIGHT_PERCENT = 60;
export const INDICATOR_PANE_HEIGHT = 150;
export const MAIN_CHART_MIN_HEIGHT = 320;

export function calculateMainChartHeight(viewportHeight: number): number {
  return Math.max(
    MAIN_CHART_MIN_HEIGHT,
    Math.round(viewportHeight * MAIN_CHART_HEIGHT_PERCENT / 100),
  );
}

export function formatVolumeInYi(value: number): string {
  return `${(value / 1e8).toFixed(2)}亿`;
}

export const VOLUME_PRICE_FORMAT = {
  type: 'custom' as const,
  minMove: 1,
  formatter: formatVolumeInYi,
};

export function getMacdHistogramColor(value: number): string {
  return value >= 0 ? CHART_COLORS.up : CHART_COLORS.down;
}
