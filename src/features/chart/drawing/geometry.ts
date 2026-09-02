import type {
  Drawing,
  DrawingCoordinateAdapter,
  DrawingHit,
  DrawingPoint2D,
  DrawingViewport,
} from './types';

export interface DrawingLineSegment {
  from: DrawingPoint2D;
  to: DrawingPoint2D;
}

export interface DrawingRectangle {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ResolvedDrawingGeometry {
  id: string;
  type: Drawing['type'];
  /** Screen coordinates for interactive control points. Null means the time
   * or price is not currently representable by the chart scale. */
  anchors: readonly (DrawingPoint2D | null)[];
  /** Stroke segments clipped to the current pane viewport. */
  strokes: readonly DrawingLineSegment[];
  /** The rectangle interior, when the drawing has a rectangular body. */
  body?: DrawingRectangle;
}

export const DEFAULT_HIT_TEST_TOLERANCE = 8;
export const DEFAULT_ANCHOR_HIT_TEST_TOLERANCE = 10;

const EPSILON = 1e-7;

function finitePoint(x: number | null, y: number | null): DrawingPoint2D | null {
  return x != null && y != null && Number.isFinite(x) && Number.isFinite(y)
    ? { x, y }
    : null;
}

function mapPoint(
  point: { time: string; price: number } | undefined,
  adapter: DrawingCoordinateAdapter,
): DrawingPoint2D | null {
  if (!point || !Number.isFinite(point.price)) return null;
  return finitePoint(
    adapter.timeToCoordinate(point.time),
    adapter.priceToCoordinate(point.price),
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function samePoint(a: DrawingPoint2D, b: DrawingPoint2D): boolean {
  return Math.abs(a.x - b.x) <= EPSILON && Math.abs(a.y - b.y) <= EPSILON;
}

function addUniquePoint(points: DrawingPoint2D[], point: DrawingPoint2D): void {
  if (!points.some((item) => samePoint(item, point))) points.push(point);
}

function inViewport(point: DrawingPoint2D, viewport: DrawingViewport): boolean {
  return point.x >= -EPSILON
    && point.x <= viewport.width + EPSILON
    && point.y >= -EPSILON
    && point.y <= viewport.height + EPSILON;
}

/**
 * Clips a finite segment to the pane rectangle using Liang-Barsky clipping.
 * Returning a clipped segment keeps hit testing and drawing stable while an
 * anchor is just outside the visible viewport.
 */
export function clipSegmentToViewport(
  from: DrawingPoint2D,
  to: DrawingPoint2D,
  viewport: DrawingViewport,
): DrawingLineSegment | null {
  if (viewport.width <= 0 || viewport.height <= 0) return null;

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  let t0 = 0;
  let t1 = 1;
  const checks: Array<[number, number]> = [
    [-dx, from.x],
    [dx, viewport.width - from.x],
    [-dy, from.y],
    [dy, viewport.height - from.y],
  ];

  for (const [p, q] of checks) {
    if (Math.abs(p) <= EPSILON) {
      if (q < 0) return null;
      continue;
    }
    const ratio = q / p;
    if (p < 0) {
      if (ratio > t1) return null;
      if (ratio > t0) t0 = ratio;
    } else {
      if (ratio < t0) return null;
      if (ratio < t1) t1 = ratio;
    }
  }

  return {
    from: { x: from.x + t0 * dx, y: from.y + t0 * dy },
    to: { x: from.x + t1 * dx, y: from.y + t1 * dy },
  };
}

/**
 * Returns the portion of an infinite line through two points that intersects
 * the pane rectangle. Degenerate points have no meaningful line and return an
 * empty list.
 */
export function clipInfiniteLineToViewport(
  first: DrawingPoint2D,
  second: DrawingPoint2D,
  viewport: DrawingViewport,
): DrawingLineSegment[] {
  if (viewport.width <= 0 || viewport.height <= 0) return [];
  const dx = second.x - first.x;
  const dy = second.y - first.y;
  if (Math.abs(dx) <= EPSILON && Math.abs(dy) <= EPSILON) return [];

  const intersections: DrawingPoint2D[] = [];
  const addAt = (t: number) => {
    const point = { x: first.x + t * dx, y: first.y + t * dy };
    if (inViewport(point, viewport)) addUniquePoint(intersections, point);
  };

  if (Math.abs(dx) > EPSILON) {
    addAt((0 - first.x) / dx);
    addAt((viewport.width - first.x) / dx);
  }
  if (Math.abs(dy) > EPSILON) {
    addAt((0 - first.y) / dy);
    addAt((viewport.height - first.y) / dy);
  }

  if (intersections.length < 2) return [];
  let bestFrom = intersections[0];
  let bestTo = intersections[1];
  let bestDistance = distanceSquared(bestFrom, bestTo);
  for (let fromIndex = 0; fromIndex < intersections.length - 1; fromIndex += 1) {
    for (let toIndex = fromIndex + 1; toIndex < intersections.length; toIndex += 1) {
      const distance = distanceSquared(intersections[fromIndex], intersections[toIndex]);
      if (distance > bestDistance) {
        bestDistance = distance;
        bestFrom = intersections[fromIndex];
        bestTo = intersections[toIndex];
      }
    }
  }
  return [{ from: bestFrom, to: bestTo }];
}

function rectangleFromPoints(first: DrawingPoint2D, second: DrawingPoint2D): DrawingRectangle {
  return {
    left: Math.min(first.x, second.x),
    top: Math.min(first.y, second.y),
    width: Math.abs(first.x - second.x),
    height: Math.abs(first.y - second.y),
  };
}

function rectangleAnchors(rectangle: DrawingRectangle): DrawingPoint2D[] {
  const right = rectangle.left + rectangle.width;
  const bottom = rectangle.top + rectangle.height;
  return [
    { x: rectangle.left, y: rectangle.top },
    { x: right, y: rectangle.top },
    { x: right, y: bottom },
    { x: rectangle.left, y: bottom },
  ];
}

function rectangleStrokes(rectangle: DrawingRectangle): DrawingLineSegment[] {
  const corners = rectangleAnchors(rectangle);
  return corners.map((corner, index) => ({ from: corner, to: corners[(index + 1) % corners.length] }));
}

function clipRectangleStrokes(
  rectangle: DrawingRectangle,
  viewport: DrawingViewport,
): DrawingLineSegment[] {
  return rectangleStrokes(rectangle).flatMap((stroke) => {
    const clipped = clipSegmentToViewport(stroke.from, stroke.to, viewport);
    return clipped ? [clipped] : [];
  });
}

function pointInRectangle(point: DrawingPoint2D, rectangle: DrawingRectangle): boolean {
  return point.x >= rectangle.left - EPSILON
    && point.x <= rectangle.left + rectangle.width + EPSILON
    && point.y >= rectangle.top - EPSILON
    && point.y <= rectangle.top + rectangle.height + EPSILON;
}

/**
 * Converts a domain-space drawing into screen-space geometry. The source
 * drawing remains untouched, and missing coordinates only hide the affected
 * part (for example an off-screen anchor) instead of throwing.
 */
export function resolveDrawingGeometry(
  drawing: Drawing,
  adapter: DrawingCoordinateAdapter,
  viewport: DrawingViewport,
): ResolvedDrawingGeometry | null {
  const mapped = drawing.points.map((point) => mapPoint(point, adapter));
  const first = mapped[0] ?? null;

  if (drawing.type === 'horizontal') {
    if (!first) return null;
    return {
      id: drawing.id,
      type: drawing.type,
      anchors: [first],
      strokes: [{ from: { x: 0, y: first.y }, to: { x: viewport.width, y: first.y } }],
    };
  }

  const second = mapped[1] ?? null;
  if (!first && !second) return null;

  if (drawing.type === 'rectangle') {
    if (!first || !second) {
      return {
        id: drawing.id,
        type: drawing.type,
        anchors: [first, second],
        strokes: [],
      };
    }
    const body = rectangleFromPoints(first, second);
    return {
      id: drawing.id,
      type: drawing.type,
      anchors: rectangleAnchors(body),
      strokes: clipRectangleStrokes(body, viewport),
      body,
    };
  }

  if (!first || !second) {
    return {
      id: drawing.id,
      type: drawing.type,
      anchors: [first, second],
      strokes: [],
    };
  }

  const strokes = drawing.type === 'infinite-line'
    ? clipInfiniteLineToViewport(first, second, viewport)
    : (() => {
      const clipped = clipSegmentToViewport(first, second, viewport);
      return clipped ? [clipped] : [];
    })();

  return {
    id: drawing.id,
    type: drawing.type,
    anchors: [first, second],
    strokes,
  };
}

function distanceSquared(a: DrawingPoint2D, b: DrawingPoint2D): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export function distanceToSegment(point: DrawingPoint2D, segment: DrawingLineSegment): number {
  const dx = segment.to.x - segment.from.x;
  const dy = segment.to.y - segment.from.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= EPSILON) return Math.sqrt(distanceSquared(point, segment.from));
  const projection = clamp(
    ((point.x - segment.from.x) * dx + (point.y - segment.from.y) * dy) / lengthSquared,
    0,
    1,
  );
  return Math.hypot(
    point.x - (segment.from.x + projection * dx),
    point.y - (segment.from.y + projection * dy),
  );
}

function nearestAnchorHit(
  geometries: readonly ResolvedDrawingGeometry[],
  point: DrawingPoint2D,
  tolerance: number,
): DrawingHit | null {
  let best: DrawingHit | null = null;
  geometries.forEach((geometry) => {
    geometry.anchors.forEach((anchor, anchorIndex) => {
      if (!anchor) return;
      const distance = Math.hypot(point.x - anchor.x, point.y - anchor.y);
      if (distance > tolerance || (best && distance >= best.distance)) return;
      best = { drawingId: geometry.id, part: 'anchor', anchorIndex, distance };
    });
  });
  return best;
}

function nearestStrokeHit(
  geometries: readonly ResolvedDrawingGeometry[],
  point: DrawingPoint2D,
  tolerance: number,
): DrawingHit | null {
  let best: DrawingHit | null = null;
  geometries.forEach((geometry) => {
    geometry.strokes.forEach((stroke) => {
      const distance = distanceToSegment(point, stroke);
      if (distance > tolerance || (best && distance >= best.distance)) return;
      best = { drawingId: geometry.id, part: 'stroke', distance };
    });
  });
  return best;
}

function nearestBodyHit(
  geometries: readonly ResolvedDrawingGeometry[],
  point: DrawingPoint2D,
): DrawingHit | null {
  for (const geometry of geometries) {
    if (geometry.body && pointInRectangle(point, geometry.body)) {
      return { drawingId: geometry.id, part: 'body', distance: 0 };
    }
  }
  return null;
}

/**
 * Hit tests all drawings in interaction-priority order: anchors first, then
 * strokes, then rectangle bodies. This guarantees a corner remains selectable
 * even if it lies on top of a stroke or another drawing body.
 */
export function hitTestDrawings(
  drawings: readonly Drawing[],
  point: DrawingPoint2D,
  adapter: DrawingCoordinateAdapter,
  viewport: DrawingViewport,
  tolerance = DEFAULT_HIT_TEST_TOLERANCE,
): DrawingHit | null {
  const geometries = drawings
    .map((drawing) => resolveDrawingGeometry(drawing, adapter, viewport))
    .filter((geometry): geometry is ResolvedDrawingGeometry => geometry != null);

  return nearestAnchorHit(geometries, point, Math.max(tolerance, DEFAULT_ANCHOR_HIT_TEST_TOLERANCE))
    ?? nearestStrokeHit(geometries, point, tolerance)
    ?? nearestBodyHit(geometries, point);
}

export function isPointInDrawingBody(
  geometry: ResolvedDrawingGeometry,
  point: DrawingPoint2D,
): boolean {
  return geometry.body != null && pointInRectangle(point, geometry.body);
}
