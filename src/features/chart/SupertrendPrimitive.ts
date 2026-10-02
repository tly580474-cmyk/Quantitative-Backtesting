import type {
  AutoscaleInfo, IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesPrimitive,
  SeriesAttachedParameter, Time, Logical,
} from 'lightweight-charts';
import { type SupertrendBar, type SupertrendResult } from '@/features/indicators/supertrend';

import { getPriceColors, type PriceColors } from '@/priceColors';

interface PlotPoint { x: number; bandY: number; bodyY: number; direction: 1 | -1 }

// Both line and fill use the same contiguous runs. LineSeries can bridge
// whitespace, so draw explicit paths to guarantee breaks on every reversal.
export class SupertrendPrimitive implements ISeriesPrimitive<Time> {
  private attachedParams?: SeriesAttachedParameter<Time>;
  private times: readonly Time[] = [];
  private bars: readonly SupertrendBar[] = [];
  private result?: Pick<SupertrendResult, 'value' | 'direction'>;
  private visible = true;
  private colors: PriceColors = getPriceColors('red-up');
  private renderer: IPrimitivePaneRenderer = {
    draw: (target) => target.useMediaCoordinateSpace(({ context: ctx }) => {
      const params = this.attachedParams;
      if (!params || !this.visible || !this.result) return;
      const scale = params.chart.timeScale();
      const range = scale.getVisibleLogicalRange();
      if (!range) return;
      const first = Math.max(0, Math.floor(range.from) - 1);
      const last = Math.min(this.times.length - 1, Math.ceil(range.to) + 1);
      const halfBar = scale.options().barSpacing / 2;
      let run: PlotPoint[] = [];
      const flush = () => {
        if (!run.length) return;
        const color = run[0].direction === 1 ? this.colors.up : this.colors.down;
        // Extend single-bar trends too, without connecting opposite directions.
        const start = run[0];
        const end = run[run.length - 1];
        ctx.beginPath();
        ctx.moveTo(start.x - halfBar, start.bandY);
        for (const point of run) ctx.lineTo(point.x, point.bandY);
        ctx.lineTo(end.x + halfBar, end.bandY);
        ctx.lineTo(end.x + halfBar, end.bodyY);
        for (let i = run.length - 1; i >= 0; i--) ctx.lineTo(run[i].x, run[i].bodyY);
        ctx.lineTo(start.x - halfBar, start.bodyY);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.09;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.moveTo(start.x - halfBar, start.bandY);
        for (const point of run) ctx.lineTo(point.x, point.bandY);
        ctx.lineTo(end.x + halfBar, end.bandY);
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.stroke();
        run = [];
      };
      ctx.save();
      ctx.lineJoin = 'round';
      for (let index = first; index <= last; index++) {
        const value = this.result.value[index];
        const direction = this.result.direction[index];
        const x = scale.timeToCoordinate(this.times[index]);
        const bandY = value == null ? null : params.series.priceToCoordinate(value);
        const bodyY = params.series.priceToCoordinate((this.bars[index].open + this.bars[index].close) / 2);
        if (x == null || bandY == null || bodyY == null || direction == null) {
          flush();
          continue;
        }
        if (run.length && run[0].direction !== direction) flush();
        run.push({ x, bandY, bodyY, direction });
      }
      flush();
      ctx.restore();
    }),
  };
  private view: IPrimitivePaneView = {
    zOrder: () => 'bottom',
    renderer: () => this.renderer,
  };

  setData(times: readonly Time[], bars: readonly SupertrendBar[], result: Pick<SupertrendResult, 'value' | 'direction'>): void {
    this.times = times;
    this.bars = bars;
    this.result = result;
    this.attachedParams?.requestUpdate();
  }

  setColors(colors: PriceColors): void {
    this.colors = colors;
    this.attachedParams?.requestUpdate();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.attachedParams?.requestUpdate();
  }

  attached(params: SeriesAttachedParameter<Time>): void { this.attachedParams = params; }
  detached(): void { this.attachedParams = undefined; }
  paneViews(): IPrimitivePaneView[] { return [this.view]; }

  autoscaleInfo(start: Logical, end: Logical): AutoscaleInfo | null {
    if (!this.visible || !this.result || !this.attachedParams) return null;
    let minValue = Infinity;
    let maxValue = -Infinity;
    // All three host charts anchor every series to the same candle timestamps.
    // Scan only the visible slice so minute histories remain responsive.
    const first = Math.max(0, Math.floor(start) - 1);
    const last = Math.min(this.times.length - 1, Math.ceil(end) + 1);
    for (let index = first; index <= last; index++) {
      const value = this.result.value[index];
      if (value == null) continue;
      minValue = Math.min(minValue, value);
      maxValue = Math.max(maxValue, value);
    }
    return Number.isFinite(minValue) ? { priceRange: { minValue, maxValue } } : null;
  }
}
