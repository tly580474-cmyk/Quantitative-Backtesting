import { describe, expect, it } from 'vitest';
import { normalizeSectorConstituents } from './hotSectorService.js';

describe('sector constituents', () => {
  it('normalizes Eastmoney rows and skips invalid stocks', () => {
    const result = normalizeSectorConstituents([
      {
        f2: 12.22, f3: 9.99, f6: 2_510_000_000, f8: 4.25, f10: 0.43,
        f12: '600909', f14: '华安证券', f15: 12.22, f16: 11.21,
        f17: 11.28, f18: 11.11, f62: 310_000_000, f184: 12.34,
      },
      { f12: '', f14: '无效数据' },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      rank: 1,
      code: '600909',
      name: '华安证券',
      amountYi: 25.1,
      mainNetInYi: 3.1,
      changePct: 9.99,
    });
  });
});
