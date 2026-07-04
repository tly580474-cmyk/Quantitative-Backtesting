import { describe, expect, it } from 'vitest';
import { amountYuanToYi } from '../historyBar';

describe('amountYuanToYi', () => {
  it('converts history-v2 amount from yuan to 亿元', () => {
    expect(amountYuanToYi(1_500_287_176.22)).toBeCloseTo(15.0028717622, 10);
  });

  it('preserves a missing amount', () => {
    expect(amountYuanToYi(undefined)).toBeUndefined();
  });
});
