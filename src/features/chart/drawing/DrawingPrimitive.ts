import type {
  Coordinate,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  PrimitiveHoveredItem,
  SeriesAttachedParameter,
  Logical,
  Time,
} from 'lightweight-charts';
import { chartTimeKey, toChartTime } from '../chartTime';
import {
  DEFAULT_ANCHOR_HIT_TEST_TOLERANCE,
  DEFAULT_HIT_TEST_TOLERANCE,
  hitTestDrawings,
  resolveDrawingGeometry,
  type ResolvedDrawingGeometry,
} from './geometry';
import type {
  Drawing,
  DrawingCoordinateAdapter,
  DrawingDraft,
  DrawingHit,
  DrawingPoint2D,
  DrawingStyle,
  DrawingViewport,
} from './types';

export { DEFAULT_ANCHOR_HIT_TEST_TOLERANCE, DEFAULT_HIT_TEST_TOLERANCE } from './geometry';
export type { DrawingMode, DrawingTool, DrawingType } from './types';

interface ResolvedDrawingStyle {
  color: string;
  width: number;
  dash: number[];
  fill: string;
  opacity: number;
}

const DEFAULT_STYLE: ResolvedDrawingStyle = {
  color: '#2563EB', width: 2, dash: [], fill: 'rgba(37, 99, 235, 0.10)', opacity: 1,
};

const DRAFT_STYLE: ResolvedDrawingStyle = {
  color: '#60A5FA',
  width: 2,
  dash: [6, 4],
  fill: 'rgba(96, 165, 250, 0.06)',
  opacity: 0.78,
};

const ANCHOR_RADIUS = 5;

function styleFor(drawing: Drawing, draft: boolean): ResolvedDrawingStyle {
  const base = draft ? DRAFT_STYLE : DEFAULT_STYLE;
  const color = drawing.style?.color ?? base.color;
  return {
    color,
    width: drawing.style?.width ?? base.width,
    dash: drawing.style?.dash ?? base.dash,
    fill: drawing.style?.fill ?? colorWithAlpha(color, draft ? 0.06 : 0.10, base.fill),
    opacity: drawing.style?.opacity ?? base.opacity,
  };
}

function colorWithAlpha(color: string, alpha: number, fallback: string): string {
  const match = color.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!match) return fallback;
  return `rgba(${Number.parseInt(match[1], 16)}, ${Number.parseInt(match[2], 16)}, ${Number.parseInt(match[3], 16)}, ${alpha})`;
}

function materializeDraft(draft: DrawingDraft | null): Drawing | null {
  if (!draft) return null;
  const points = [...draft.points];
  if (draft.previewPoint && points.length < 2) {
    const last = points[points.length - 1];
    if (!last || last.time !== draft.previewPoint.time || last.price !== draft.previewPoint.price) {
      points.push(draft.previewPoint);
    }
  }
  if (points.length === 0) return null;
  return {
    id: '__draft__',
    type: draft.type,
    points,
    style: draft.style,
  };
}

function clampOpacity(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 1));
}

function drawStroke(
  context: CanvasRenderingContext2D,
  from: DrawingPoint2D,
  to: DrawingPoint2D,
): void {
  context.beginPath();
  context.moveTo(from.x, from.y);
  context.lineTo(to.x, to.y);
  context.stroke();
}

function drawAnchor(
  context: CanvasRenderingContext2D,
  point: DrawingPoint2D,
  rectangle: boolean,
): void {
  const size = ANCHOR_RADIUS * 2;
  context.save();
  context.fillStyle = '#FFFFFF';
  context.strokeStyle = '#2563EB';
  context.lineWidth = 1.5;
  if (rectangle) {
    context.fillRect(point.x - ANCHOR_RADIUS, point.y - ANCHOR_RADIUS, size, size);
    context.strokeRect(point.x - ANCHOR_RADIUS, point.y - ANCHOR_RADIUS, size, size);
  } else {
    context.beginPath();
    context.arc(point.x, point.y, ANCHOR_RADIUS, 0, Math.PI * 2);
    context.fill();
    context.stroke();
  }
  context.restore();
}

function drawGeometry(
  context: CanvasRenderingContext2D,
  geometry: ResolvedDrawingGeometry,
  style: ResolvedDrawingStyle,
  showAnchors: boolean,
): void {
  context.strokeStyle = style.color;
  context.fillStyle = style.fill;
  context.globalAlpha = clampOpacity(style.opacity);
  context.lineWidth = Math.max(0.5, style.width);
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.setLineDash([...style.dash]);

  if (geometry.body && geometry.type === 'rectangle') {
    context.fillRect(
      geometry.body.left,
      geometry.body.top,
      geometry.body.width,
      geometry.body.height,
    );
  }
  for (const stroke of geometry.strokes) drawStroke(context, stroke.from, stroke.to);

  if (showAnchors) {
    // A rectangle exposes all four corners even though it stores two opposite
    // domain points; this makes the visual editing affordance unambiguous.
    for (const anchor of geometry.anchors) {
      if (anchor) drawAnchor(context, anchor, geometry.type === 'rectangle');
    }
  }
}

class DrawingRenderer implements IPrimitivePaneRenderer {
  constructor(
    private readonly getDrawings: () => readonly Drawing[],
    private readonly getDraft: () => DrawingDraft | null,
    private readonly getSelectedId: () => string | null,
    private readonly adapter: DrawingCoordinateAdapter,
  ) {}

  // Lightweight Charts supplies the fancy-canvas target at runtime.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  draw(target: any): void {
    target.useMediaCoordinateSpace((scope: {
      context: CanvasRenderingContext2D;
      mediaSize: { width: number; height: number };
    }) => {
      const { context, mediaSize } = scope;
      const viewport: DrawingViewport = {
        width: mediaSize.width,
        height: mediaSize.height,
      };
      const selectedId = this.getSelectedId();
      const drawings = this.getDrawings();
      const draft = materializeDraft(this.getDraft());

      context.save();
      // Fills are painted first so line strokes and handles remain legible.
      for (const drawing of drawings) {
        const geometry = resolveDrawingGeometry(drawing, this.adapter, viewport);
        if (geometry) drawGeometry(context, geometry, styleFor(drawing, false), geometry.id === selectedId);
      }
      if (draft) {
        const geometry = resolveDrawingGeometry(draft, this.adapter, viewport);
        if (geometry) drawGeometry(context, geometry, styleFor(draft, true), true);
      }
      context.restore();
    });
  }
}

class DrawingPaneView implements IPrimitivePaneView {
  constructor(private readonly paneRenderer: DrawingRenderer) {}

  zOrder(): 'top' { return 'top'; }

  renderer(): IPrimitivePaneRenderer { return this.paneRenderer; }
}

function hitExternalId(hit: DrawingHit): string {
  if (hit.part === 'anchor') return `drawing-${hit.drawingId}-anchor-${hit.anchorIndex ?? 0}`;
  return `drawing-${hit.drawingId}-${hit.part}`;
}

function hitCursor(hit: DrawingHit): string {
  if (hit.part === 'anchor') return 'move';
  if (hit.part === 'body') return 'grab';
  return 'pointer';
}

/**
 * A single lightweight-charts primitive for all user drawings in the main
 * price pane. It intentionally stores no pixel state: chart coordinate
 * transforms are evaluated on every render and hit test.
 */
export class DrawingPrimitive implements ISeriesPrimitive<Time> {
  private drawings: readonly Drawing[] = [];
  private draft: DrawingDraft | null = null;
  private selectedId: string | null = null;
  private requestUpdate?: () => void;
  private chart?: SeriesAttachedParameter<Time>['chart'];
  private series?: SeriesAttachedParameter<Time>['series'];

  setDrawings(drawings: readonly Drawing[]): void {
    this.drawings = drawings;
    if (this.selectedId && !drawings.some((drawing) => drawing.id === this.selectedId)) {
      this.selectedId = null;
    }
    this.requestUpdate?.();
  }

  setDraft(draft: DrawingDraft | null): void {
    this.draft = draft;
    this.requestUpdate?.();
  }

  setSelectedDrawing(id: string | null): void {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.requestUpdate?.();
  }

  getSelectedDrawingId(): string | null { return this.selectedId; }

  getDrawings(): readonly Drawing[] { return this.drawings; }

  getDraft(): DrawingDraft | null { return this.draft; }

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

  private adapter(): DrawingCoordinateAdapter {
    return {
      timeToCoordinate: (time: string): Coordinate | null => this.chart
        ?.timeScale()
        .timeToCoordinate(toChartTime(time)) ?? null,
      logicalToCoordinate: (logical: number): Coordinate | null => this.chart
        ?.timeScale()
        .logicalToCoordinate(logical as Logical) ?? null,
      priceToCoordinate: (price: number): Coordinate | null => this.series?.priceToCoordinate(price) ?? null,
    };
  }

  private viewport(): DrawingViewport {
    const size = this.chart?.paneSize?.(0);
    return {
      width: size?.width ?? 0,
      height: size?.height ?? 0,
    };
  }

  paneViews(): IPrimitivePaneView[] {
    return [new DrawingPaneView(new DrawingRenderer(
      () => this.drawings,
      () => this.draft,
      () => this.selectedId,
      this.adapter(),
    ))];
  }

  hitTest(x: number, y: number): PrimitiveHoveredItem | null {
    if (!this.chart || !this.series) return null;
    const hit = hitTestDrawings(
      this.drawings,
      { x, y },
      this.adapter(),
      this.viewport(),
    );
    if (!hit) return null;
    return {
      externalId: hitExternalId(hit),
      distance: hit.distance,
      hitTestPriority: hit.part === 'anchor' ? 2 : hit.part === 'stroke' ? 1 : 0,
      cursorStyle: hitCursor(hit),
      zOrder: 'top',
    };
  }
}

/**
 * Convenience helper for integrations that need to normalize a chart event's
 * time without depending on lightweight-charts' nominal `Time` type.
 */
export function drawingTimeKey(time: Time): string {
  return chartTimeKey(time);
}
