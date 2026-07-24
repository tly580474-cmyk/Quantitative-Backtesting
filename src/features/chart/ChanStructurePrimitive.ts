import type {
  Coordinate,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  Time,
} from 'lightweight-charts';
import type { ChanAnalysis, ChanCenter, ChanFractal, ChanPen, ChanSegment } from '@/features/chanlun';
import { toChartTime } from './chartTime';

export interface ChanLayerVisibility {
  pens: boolean;
  fractals: boolean;
  segments: boolean;
  penCenters: boolean;
  segmentCenters: boolean;
}

export interface ChanRenderModel {
  pens: readonly ChanPen[];
  fractals: readonly ChanFractal[];
  segments: readonly ChanSegment[];
  penCenters: readonly ChanCenter[];
  segmentCenters: readonly ChanCenter[];
}

const CONFIRMED_PEN_COLOR = '#7C3AED';
const CANDIDATE_PEN_COLOR = '#F59E0B';
const TOP_COLOR = '#DC2626';
const BOTTOM_COLOR = '#16A34A';
const CONFIRMED_SEGMENT_COLOR = '#2563EB';
const CANDIDATE_SEGMENT_COLOR = '#60A5FA';
const PEN_CENTER_COLOR = '#7C3AED';
const SEGMENT_CENTER_COLOR = '#2563EB';

export interface ChanPenStyle {
  color: string;
  lineWidth: number;
  lineDash: number[];
  alpha: number;
}

export function getChanPenStyle(status: ChanPen['status']): ChanPenStyle {
  return status === 'candidate'
    ? { color: CANDIDATE_PEN_COLOR, lineWidth: 2, lineDash: [7, 5], alpha: 0.9 }
    : { color: CONFIRMED_PEN_COLOR, lineWidth: 2.25, lineDash: [], alpha: 1 };
}

export function getChanSegmentStyle(status: ChanSegment['status']): ChanPenStyle {
  return status === 'candidate'
    ? { color: CANDIDATE_SEGMENT_COLOR, lineWidth: 3, lineDash: [9, 6], alpha: 0.9 }
    : { color: CONFIRMED_SEGMENT_COLOR, lineWidth: 3.25, lineDash: [], alpha: 0.95 };
}

export interface ChanCenterStyle {
  stroke: string;
  fill: string;
  lineDash: number[];
}

export function getChanCenterStyle(level: ChanCenter['level'], status: ChanCenter['status']): ChanCenterStyle {
  const color = level === 'pen' ? PEN_CENTER_COLOR : SEGMENT_CENTER_COLOR;
  return {
    stroke: color,
    fill: level === 'pen' ? 'rgba(124, 58, 237, 0.10)' : 'rgba(37, 99, 235, 0.10)',
    lineDash: status === 'candidate' ? [5, 4] : [],
  };
}

export function buildChanRenderModel(
  analysis: ChanAnalysis | null,
  visibility: ChanLayerVisibility,
): ChanRenderModel {
  return {
    pens: visibility.pens ? analysis?.pens ?? [] : [],
    fractals: visibility.fractals ? analysis?.fractals ?? [] : [],
    segments: visibility.segments ? analysis?.segments ?? [] : [],
    penCenters: visibility.penCenters ? analysis?.penCenters ?? [] : [],
    segmentCenters: visibility.segmentCenters ? analysis?.segmentCenters ?? [] : [],
  };
}

class ChanStructureRenderer implements IPrimitivePaneRenderer {
  constructor(
    private readonly getModel: () => ChanRenderModel,
    private readonly timeToCoordinate: (time: string) => Coordinate | null,
    private readonly priceToCoordinate: (price: number) => Coordinate | null,
  ) {}

  // Lightweight Charts provides a fancy-canvas target at runtime.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  draw(target: any): void {
    target.useMediaCoordinateSpace((scope: {
      context: CanvasRenderingContext2D;
      mediaSize: { width: number; height: number };
    }) => {
      const { context: ctx, mediaSize } = scope;
      const model = this.getModel();
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      for (const center of [...model.penCenters, ...model.segmentCenters]) {
        const x1 = this.timeToCoordinate(center.startTime);
        const x2 = this.timeToCoordinate(center.endTime);
        const upper = this.priceToCoordinate(center.zg);
        const lower = this.priceToCoordinate(center.zd);
        if (x1 == null || x2 == null || upper == null || lower == null) continue;
        if (Math.max(x1, x2) < 0 || Math.min(x1, x2) > mediaSize.width) continue;
        const style = getChanCenterStyle(center.level, center.status);
        const left = Math.min(x1, x2);
        const top = Math.min(upper, lower);
        const width = Math.max(1, Math.abs(x2 - x1));
        const height = Math.max(1, Math.abs(lower - upper));
        ctx.fillStyle = style.fill;
        ctx.strokeStyle = style.stroke;
        ctx.lineWidth = center.level === 'segment' ? 1.75 : 1.25;
        ctx.setLineDash(style.lineDash);
        ctx.fillRect(left, top, width, height);
        ctx.strokeRect(left, top, width, height);
      }
      ctx.setLineDash([]);

      for (const segment of model.segments) {
        const x1 = this.timeToCoordinate(segment.startTime);
        const y1 = this.priceToCoordinate(segment.startPrice);
        const x2 = this.timeToCoordinate(segment.endTime);
        const y2 = this.priceToCoordinate(segment.endPrice);
        if (x1 == null || y1 == null || x2 == null || y2 == null) continue;
        if (Math.max(x1, x2) < 0 || Math.min(x1, x2) > mediaSize.width) continue;
        const style = getChanSegmentStyle(segment.status);
        ctx.strokeStyle = style.color;
        ctx.lineWidth = style.lineWidth;
        ctx.globalAlpha = style.alpha;
        ctx.setLineDash(style.lineDash);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;

      for (const pen of model.pens) {
        const x1 = this.timeToCoordinate(pen.startTime);
        const y1 = this.priceToCoordinate(pen.startPrice);
        const x2 = this.timeToCoordinate(pen.endTime);
        const y2 = this.priceToCoordinate(pen.endPrice);
        if (x1 == null || y1 == null || x2 == null || y2 == null) continue;
        if (Math.max(x1, x2) < 0 || Math.min(x1, x2) > mediaSize.width) continue;

        const style = getChanPenStyle(pen.status);
        ctx.strokeStyle = style.color;
        ctx.lineWidth = style.lineWidth;
        ctx.globalAlpha = style.alpha;
        ctx.setLineDash(style.lineDash);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;

      for (const fractal of model.fractals) {
        const x = this.timeToCoordinate(fractal.time);
        const y = this.priceToCoordinate(fractal.price);
        if (x == null || y == null || x < -12 || x > mediaSize.width + 12) continue;
        const top = fractal.type === 'top';
        const markerY = y + (top ? -9 : 9);
        ctx.fillStyle = top ? TOP_COLOR : BOTTOM_COLOR;
        ctx.beginPath();
        if (top) {
          ctx.moveTo(x, markerY + 6);
          ctx.lineTo(x - 5, markerY - 2);
          ctx.lineTo(x + 5, markerY - 2);
        } else {
          ctx.moveTo(x, markerY - 6);
          ctx.lineTo(x - 5, markerY + 2);
          ctx.lineTo(x + 5, markerY + 2);
        }
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    });
  }
}

class ChanStructurePaneView implements IPrimitivePaneView {
  constructor(private readonly paneRenderer: ChanStructureRenderer) {}
  zOrder(): 'top' { return 'top'; }
  renderer(): IPrimitivePaneRenderer { return this.paneRenderer; }
}

export class ChanStructurePrimitive implements ISeriesPrimitive<Time> {
  private analysis: ChanAnalysis | null = null;
  private visibility: ChanLayerVisibility = {
    pens: true,
    fractals: true,
    segments: true,
    penCenters: true,
    segmentCenters: true,
  };
  private requestUpdate?: () => void;
  private chart?: SeriesAttachedParameter<Time>['chart'];
  private series?: SeriesAttachedParameter<Time>['series'];

  setAnalysis(analysis: ChanAnalysis | null): void {
    this.analysis = analysis;
    this.requestUpdate?.();
  }

  setVisibility(visibility: ChanLayerVisibility): void {
    this.visibility = { ...visibility };
    this.requestUpdate?.();
  }

  getRenderModel(): ChanRenderModel {
    return buildChanRenderModel(this.analysis, this.visibility);
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this.requestUpdate = param.requestUpdate;
    this.chart = param.chart;
    this.series = param.series;
  }

  detached(): void {
    this.requestUpdate = undefined;
    this.chart = undefined;
    this.series = undefined;
  }

  updateAllViews(): void {
    this.requestUpdate?.();
  }

  paneViews(): IPrimitivePaneView[] {
    return [new ChanStructurePaneView(new ChanStructureRenderer(
      () => this.getRenderModel(),
      (time) => this.chart?.timeScale().timeToCoordinate(toChartTime(time)) ?? null,
      (price) => this.series?.priceToCoordinate(price) ?? null,
    ))];
  }
}
