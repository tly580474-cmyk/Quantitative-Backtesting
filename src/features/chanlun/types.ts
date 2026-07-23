import type { Candle } from '@/models';

export type ChanDirection = 'up' | 'down';
export type ChanBarDirection = ChanDirection | 'unknown';
export type ChanFractalType = 'top' | 'bottom';
export type ChanStructureStatus = 'candidate' | 'confirmed';

export interface ChanConfig {
  algorithmVersion: 'chan-v1';
  penMode: 'new';
  strictFractal: true;
  includeEqual: true;
  minSeparatedRawBars: 3;
  segmentMode: 'standard-feature-sequence';
  centerMode: 'standard';
}

/** A candle after containment has been resolved. */
export interface ChanBar {
  index: number;
  startIndex: number;
  endIndex: number;
  startTime: string;
  endTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  direction: ChanBarDirection;
  sourceIndices: number[];
  highSourceIndex: number;
  lowSourceIndex: number;
  highSourceTime: string;
  lowSourceTime: string;
}

export interface ChanFractal {
  id: string;
  type: ChanFractalType;
  mergedIndex: number;
  sourceIndex: number;
  time: string;
  price: number;
  leftMergedIndex: number;
  rightMergedIndex: number;
  status: 'confirmed';
  confirmedAtIndex: number;
  confirmedAt: string;
}

export interface ChanPen {
  id: string;
  direction: ChanDirection;
  startFractalId: string;
  endFractalId: string;
  startType: ChanFractalType;
  endType: ChanFractalType;
  startSourceIndex: number;
  endSourceIndex: number;
  startTime: string;
  endTime: string;
  startPrice: number;
  endPrice: number;
  status: ChanStructureStatus;
  confirmedAtIndex: number | null;
  confirmedAt: string | null;
}

export interface ChanFeatureElement {
  id: string;
  direction: ChanDirection;
  startPenIndex: number;
  endPenIndex: number;
  high: number;
  low: number;
  highSourceIndex: number;
  lowSourceIndex: number;
  highSourceTime: string;
  lowSourceTime: string;
  highSourcePenIndex: number;
  lowSourcePenIndex: number;
  sourcePenIds: string[];
  gapFromPrevious: boolean;
}

export interface ChanFeatureFractal {
  type: ChanFractalType;
  leftElementId: string;
  centerElementId: string;
  rightElementId: string;
  gapBetweenFirstSecond: boolean;
  boundaryPenIndex: number;
  endpointSourceIndex: number;
  endpointTime: string;
  endpointPrice: number;
  evidenceEndPenIndex: number;
}

export interface ChanSegment {
  id: string;
  direction: ChanDirection;
  startPenIndex: number;
  endPenIndex: number;
  startSourceIndex: number;
  endSourceIndex: number;
  startTime: string;
  endTime: string;
  startPrice: number;
  endPrice: number;
  status: ChanStructureStatus;
  confirmationKind: 'no-gap' | 'gap-reversal' | null;
  confirmedAtIndex: number | null;
  confirmedAt: string | null;
  featureElements: ChanFeatureElement[];
  evidenceFractal: ChanFeatureFractal | null;
}

export type ChanCenterLevel = 'pen' | 'segment';
export type ChanCenterLifecycle = 'forming' | 'active' | 'completed';

export interface ChanCenter {
  id: string;
  level: ChanCenterLevel;
  startComponentIndex: number;
  endComponentIndex: number;
  startSourceIndex: number;
  endSourceIndex: number;
  startTime: string;
  endTime: string;
  /** 中枢区间下沿。 */
  zd: number;
  /** 中枢区间上沿。 */
  zg: number;
  /** 参与中枢结构的最高点。 */
  gg: number;
  /** 参与中枢结构的最低点。 */
  dd: number;
  status: ChanStructureStatus;
  lifecycle: ChanCenterLifecycle;
  expanded: boolean;
  componentIds: string[];
  extensionCount: number;
  breakoutDirection: ChanDirection | null;
  confirmedAtIndex: number | null;
  confirmedAt: string | null;
  completedAtIndex: number | null;
  completedAt: string | null;
}

export interface ChanCurrentState {
  currentPenId: string | null;
  currentSegmentId: string | null;
  latestPenCenterId: string | null;
  latestSegmentCenterId: string | null;
  asOfIndex: number | null;
  asOf: string | null;
}

export interface ChanFingerprint {
  fingerprint: string;
  dataChecksum: string;
  configHash: string;
}

export interface ChanAnalysis {
  config: ChanConfig;
  fingerprint: ChanFingerprint;
  sourceBars: readonly Candle[];
  mergedBars: ChanBar[];
  fractals: ChanFractal[];
  pens: ChanPen[];
  segments: ChanSegment[];
  penCenters: ChanCenter[];
  segmentCenters: ChanCenter[];
  current: ChanCurrentState;
  warnings: string[];
}
