import type {
  Coordinate,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  Time,
} from 'lightweight-charts';

export interface TrainingDrawingPoint {
  time: string;
  price: number;
}

export interface TrainingDrawing {
  id: string;
  type: 'horizontal' | 'trend';
  points: [TrainingDrawingPoint] | [TrainingDrawingPoint, TrainingDrawingPoint];
}

class TrainingDrawingRenderer implements IPrimitivePaneRenderer {
  constructor(
    private readonly getDrawings: () => readonly TrainingDrawing[],
    private readonly timeToCoordinate: (time: string) => Coordinate | null,
    private readonly priceToCoordinate: (price: number) => Coordinate | null,
  ) {}

  // Lightweight Charts provides this canvas target at runtime.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  draw(target: any): void {
    target.useMediaCoordinateSpace((scope: {
      context: CanvasRenderingContext2D;
      mediaSize: { width: number; height: number };
    }) => {
      const { context, mediaSize } = scope;
      context.save();
      context.strokeStyle = '#2563eb';
      context.fillStyle = '#2563eb';
      context.lineWidth = 2;
      context.lineCap = 'round';
      context.lineJoin = 'round';

      for (const drawing of this.getDrawings()) {
        const first = drawing.points[0];
        const y1 = this.priceToCoordinate(first.price);
        if (y1 == null) continue;
        context.beginPath();
        if (drawing.type === 'horizontal') {
          context.setLineDash([7, 5]);
          context.moveTo(0, y1);
          context.lineTo(mediaSize.width, y1);
        } else {
          const second = drawing.points[1];
          if (!second) continue;
          const x1 = this.timeToCoordinate(first.time);
          const x2 = this.timeToCoordinate(second.time);
          const y2 = this.priceToCoordinate(second.price);
          if (x1 == null || x2 == null || y2 == null) continue;
          context.setLineDash([]);
          context.moveTo(x1, y1);
          context.lineTo(x2, y2);
          for (const [x, y] of [[x1, y1], [x2, y2]]) {
            context.moveTo(x + 4, y);
            context.arc(x, y, 4, 0, Math.PI * 2);
          }
        }
        context.stroke();
      }
      context.restore();
    });
  }
}

class TrainingDrawingPaneView implements IPrimitivePaneView {
  constructor(private readonly paneRenderer: TrainingDrawingRenderer) {}
  zOrder(): 'top' { return 'top'; }
  renderer(): IPrimitivePaneRenderer { return this.paneRenderer; }
}

export class TrainingDrawingPrimitive implements ISeriesPrimitive<Time> {
  private drawings: readonly TrainingDrawing[] = [];
  private requestUpdate?: () => void;
  private chart?: SeriesAttachedParameter<Time>['chart'];
  private series?: SeriesAttachedParameter<Time>['series'];

  setDrawings(drawings: readonly TrainingDrawing[]): void {
    this.drawings = drawings;
    this.requestUpdate?.();
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

  updateAllViews(): void { this.requestUpdate?.(); }

  paneViews(): IPrimitivePaneView[] {
    return [new TrainingDrawingPaneView(new TrainingDrawingRenderer(
      () => this.drawings,
      (time) => this.chart?.timeScale().timeToCoordinate(time as Time) ?? null,
      (price) => this.series?.priceToCoordinate(price) ?? null,
    ))];
  }
}
