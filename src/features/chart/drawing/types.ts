/**
 * Shared types for user-created chart drawings.
 *
 * Drawing coordinates are deliberately expressed as time/price anchors. The
 * chart can therefore resize, zoom, or change its pane layout without making
 * annotations drift as pixel coordinates would.
 */
export type DrawingTool =
  | 'select'
  | 'horizontal'
  | 'infinite-line'
  | 'segment'
  | 'freehand'
  | 'rectangle';

export type DrawingType = Exclude<DrawingTool, 'select'>;
/** Alias used by drawing primitives and mode selectors. */
export type DrawingMode = DrawingTool;

export interface DrawingPoint {
  time: string;
  price: number;
  /** Continuous chart index. It preserves anchors drawn in whitespace before
   * the first or after the last candle; old persisted drawings may omit it. */
  logical?: number;
}

/** Screen-space point used by the drawing renderer and hit tester. */
export interface DrawingPoint2D {
  x: number;
  y: number;
}

/** The chart-space conversion functions required by drawing primitives. */
export interface DrawingCoordinateAdapter {
  timeToCoordinate: (time: string) => number | null;
  logicalToCoordinate?: (logical: number) => number | null;
  priceToCoordinate: (price: number) => number | null;
}

export interface DrawingViewport {
  width: number;
  height: number;
}

export type DrawingHitPart = 'anchor' | 'stroke' | 'body';

export interface DrawingHit {
  drawingId: string;
  part: DrawingHitPart;
  anchorIndex?: number;
  distance: number;
}

export interface DrawingStyle {
  color?: string;
  width?: number;
  /** Canvas line dash pattern, e.g. [] for solid or [6, 4] for dashed. */
  dash?: number[];
  fill?: string;
  opacity?: number;
}

export interface Drawing {
  id: string;
  /** Present on committed drawings; omitted by transient primitive previews. */
  contextKey?: string;
  type: DrawingType;
  points: DrawingPoint[];
  style?: DrawingStyle;
  createdAt?: number;
}

export interface DrawingDraft {
  type: DrawingType;
  points: DrawingPoint[];
  previewPoint?: DrawingPoint;
  style?: DrawingStyle;
}

export type DrawingInput = Omit<Drawing, 'id' | 'contextKey'> & {
  id?: string;
  contextKey?: string;
};

export type DrawingPatch = Partial<Omit<Drawing, 'id' | 'contextKey'>>;

export function isDrawingTool(value: unknown): value is DrawingTool {
  return value === 'select'
    || value === 'horizontal'
    || value === 'infinite-line'
    || value === 'segment'
    || value === 'freehand'
    || value === 'rectangle';
}

export function isDrawingType(value: unknown): value is DrawingType {
  return isDrawingTool(value) && value !== 'select';
}
