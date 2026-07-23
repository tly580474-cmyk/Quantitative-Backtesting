import type { ChanConfig, ChanFractal, ChanPen } from './types';

function moreExtreme(candidate: ChanFractal, existing: ChanFractal): boolean {
  return candidate.type === 'top'
    ? candidate.price > existing.price
    : candidate.price < existing.price;
}

function validOppositePair(a: ChanFractal, b: ChanFractal, config: ChanConfig): boolean {
  const separatedBars = Math.abs(b.sourceIndex - a.sourceIndex) - 1;
  const priceDirectionValid = a.type === 'bottom'
    ? b.price > a.price
    : b.price < a.price;
  return separatedBars >= config.minSeparatedRawBars && priceDirectionValid;
}

export function selectPenPivots(
  fractals: readonly ChanFractal[],
  config: ChanConfig,
): ChanFractal[] {
  const pivots: ChanFractal[] = [];

  for (const fractal of fractals) {
    if (pivots.length === 0) {
      pivots.push(fractal);
      continue;
    }
    const last = pivots[pivots.length - 1];
    if (fractal.type === last.type) {
      if (moreExtreme(fractal, last)) pivots[pivots.length - 1] = fractal;
      continue;
    }
    if (validOppositePair(last, fractal, config)) pivots.push(fractal);
  }

  return pivots;
}

export function buildPens(fractals: readonly ChanFractal[], config: ChanConfig): ChanPen[] {
  const pivots = selectPenPivots(fractals, config);
  const pens: ChanPen[] = [];

  for (let i = 0; i < pivots.length - 1; i += 1) {
    const start = pivots[i];
    const end = pivots[i + 1];
    const hasConfirmingPivot = pivots[i + 2] != null;
    // The next selected pivot may later move to a more extreme same-type fractal.
    // Freeze confirmation at the first valid opposite fractal that was observable
    // after the pen endpoint, rather than backfilling the eventual pivot's time.
    const confirmingEvidence = hasConfirmingPivot
      ? fractals.find((fractal) => (
        fractal.mergedIndex > end.mergedIndex
        && fractal.type === start.type
        && validOppositePair(end, fractal, config)
      ))
      : undefined;
    pens.push({
      id: `pen:${start.id}->${end.id}`,
      direction: start.type === 'bottom' ? 'up' : 'down',
      startFractalId: start.id,
      endFractalId: end.id,
      startType: start.type,
      endType: end.type,
      startSourceIndex: start.sourceIndex,
      endSourceIndex: end.sourceIndex,
      startTime: start.time,
      endTime: end.time,
      startPrice: start.price,
      endPrice: end.price,
      status: confirmingEvidence ? 'confirmed' : 'candidate',
      confirmedAtIndex: confirmingEvidence?.confirmedAtIndex ?? null,
      confirmedAt: confirmingEvidence?.confirmedAt ?? null,
    });
  }

  return pens;
}
