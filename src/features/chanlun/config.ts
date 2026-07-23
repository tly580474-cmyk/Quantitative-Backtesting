import type { ChanConfig } from './types';

export const CHAN_V1_CONFIG: Readonly<ChanConfig> = Object.freeze({
  algorithmVersion: 'chan-v1',
  penMode: 'new',
  strictFractal: true,
  includeEqual: true,
  minSeparatedRawBars: 3,
  segmentMode: 'standard-feature-sequence',
  centerMode: 'standard',
});
