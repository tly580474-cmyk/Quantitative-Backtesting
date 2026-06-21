import type {
  ISeriesPrimitive,
  SeriesAttachedParameter,
  IPrimitivePaneView,
  IPrimitivePaneRenderer,
  PrimitiveHoveredItem,
  Time,
  Coordinate,
} from 'lightweight-charts';

const HIT_DISTANCE = 12;
const LINE_COLOR = '#1677FF';
const HANDLE_COLOR = '#1677FF';
const FILL_COLOR = 'rgba(22, 119, 255, 0.06)';

interface RangeState {
  startTime: string | null;
  endTime: string | null;
  dragging: 'start' | 'end' | null;
  hovered: 'start' | 'end' | null;
}

class RangeLineRenderer {
  constructor(
    private getState: () => RangeState,
    private timeToCoord: (time: string) => Coordinate | null,
    private getChartHeight: () => number,
  ) {}

  // The draw target is a CanvasRenderingTarget2D from fancy-canvas.
  // It requires useMediaCoordinateSpace() to access the context.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  draw(target: any): void {
    target.useMediaCoordinateSpace((scope: { context: CanvasRenderingContext2D; mediaSize: { width: number; height: number } }) => {
      const ctx = scope.context;
      const width = scope.mediaSize.width;
      const height = this.getChartHeight();
      const { startTime, endTime, dragging, hovered } = this.getState();

      ctx.save();

      // Draw the range fill between the two lines
      if (startTime && endTime) {
        const x1 = this.timeToCoord(startTime);
        const x2 = this.timeToCoord(endTime);
        if (x1 != null && x2 != null && x1 < x2) {
          ctx.fillStyle = FILL_COLOR;
          ctx.fillRect(x1, 0, x2 - x1, height);
        }
      }

      const drawLine = (time: string | null, isActive: boolean, isHovered: boolean) => {
        if (!time) return;
        const x = this.timeToCoord(time);
        if (x == null || x < 0 || x > width) return;

        const alpha = isActive ? 1 : 0.85;
        const lineWidth = isHovered ? 3 : isActive ? 2.5 : 2;

        ctx.strokeStyle = LINE_COLOR;
        ctx.globalAlpha = alpha;
        ctx.lineWidth = lineWidth;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
        ctx.setLineDash([]);

        const handleW = 14;
        const handleH = 22;
        const hx = x - handleW / 2;
        const hy = 2;
        ctx.fillStyle = HANDLE_COLOR;
        ctx.globalAlpha = isHovered ? 1 : alpha;
        ctx.beginPath();
        ctx.roundRect(hx, hy, handleW, handleH, 3);
        ctx.fill();

        ctx.fillStyle = '#fff';
        for (let dot = 0; dot < 3; dot++) {
          ctx.beginPath();
          ctx.arc(x, hy + handleH / 2 - 3 + dot * 3, 1.2, 0, Math.PI * 2);
          ctx.fill();
        }
      };

      drawLine(startTime, dragging === 'start', hovered === 'start');
      drawLine(endTime, dragging === 'end', hovered === 'end');

      ctx.restore();
    });
  }
}

class RangeLinePaneView {
  constructor(private _renderer: RangeLineRenderer) {}
  zOrder(): 'top' { return 'top'; }
  renderer() { return this._renderer; }
}

export class RangeLinePrimitive implements ISeriesPrimitive<Time> {
  private state: RangeState = {
    startTime: null,
    endTime: null,
    dragging: null,
    hovered: null,
  };
  private _requestUpdate?: () => void;
  private _chart?: SeriesAttachedParameter<Time>['chart'];

  onChange?: (s: { startTime: string | null; endTime: string | null; dragging: 'start' | 'end' | null }) => void;

  getStartTime(): string | null { return this.state.startTime; }
  getEndTime(): string | null { return this.state.endTime; }
  getDragging(): 'start' | 'end' | null { return this.state.dragging; }
  getHovered(): 'start' | 'end' | null { return this.state.hovered; }

  private emitChange(): void {
    this.onChange?.({
      startTime: this.state.startTime,
      endTime: this.state.endTime,
      dragging: this.state.dragging,
    });
  }

  setStartTime(t: string | null): void {
    this.state.startTime = t;
    this._requestUpdate?.();
    this.emitChange();
  }

  setEndTime(t: string | null): void {
    this.state.endTime = t;
    this._requestUpdate?.();
    this.emitChange();
  }

  setDragging(d: 'start' | 'end' | null): void {
    this.state.dragging = d;
    this._requestUpdate?.();
    this.emitChange();
  }

  setHovered(h: 'start' | 'end' | null): void {
    if (this.state.hovered !== h) {
      this.state.hovered = h;
      this._requestUpdate?.();
    }
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this._requestUpdate = param.requestUpdate;
    this._chart = param.chart;
  }

  detached(): void {
    this._requestUpdate = undefined;
    this._chart = undefined;
  }

  private timeToCoord(time: string): Coordinate | null {
    if (!this._chart) return null;
    return this._chart.timeScale().timeToCoordinate(time as Time);
  }

  updateAllViews(): void {
    this._requestUpdate?.();
  }

  paneViews(): IPrimitivePaneView[] {
    return [new RangeLinePaneView(new RangeLineRenderer(
      () => this.state,
      (time: string) => this.timeToCoord(time),
      () => (this._chart as unknown as { paneSize?: () => { height: number } })?.paneSize?.()?.height ?? 400,
    ))];
  }

  hitTest(x: number, _y: number): PrimitiveHoveredItem | null {
    const { startTime, endTime } = this.state;
    let closest: 'start' | 'end' | null = null;
    let minDist = Infinity;

    const pairs: Array<[string | null, 'start' | 'end']> = [[startTime, 'start'], [endTime, 'end']];
    for (const [time, which] of pairs) {
      if (!time) continue;
      const coord = this.timeToCoord(time);
      if (coord == null) continue;
      const dist = Math.abs(x - coord);
      if (dist < HIT_DISTANCE && dist < minDist) {
        minDist = dist;
        closest = which;
      }
    }

    if (closest) {
      return {
        externalId: `range-line-${closest}`,
        cursorStyle: 'col-resize',
        zOrder: 'top',
      };
    }
    return null;
  }
}
