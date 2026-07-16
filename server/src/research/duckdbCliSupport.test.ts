import { describe, expect, it } from 'vitest';
import {
  formatRows,
  groupRowsByColumn,
  parseParameterAssignments,
  resolveTemplate,
  splitSqlStatements,
} from './duckdbCliSupport.js';

describe('duckdb CLI support', () => {
  it('parses typed repeated parameters', () => {
    expect(parseParameterAssignments([
      'symbol=002155',
      'limit=10',
      'enabled=true',
      'optional=null',
    ])).toEqual({
      symbol: '002155',
      limit: 10,
      enabled: true,
      optional: null,
    });
  });

  it('splits multi-statement SQL without breaking quoted semicolons or comments', () => {
    const statements = splitSqlStatements(`
      CREATE TEMP TABLE sample AS SELECT 'a;b' AS value;
      -- a comment with ;
      INSERT INTO sample VALUES ('c');
      SELECT * FROM sample WHERE value <> 'x; y';
    `);
    expect(statements).toHaveLength(3);
    expect(statements[0]).toContain("'a;b'");
    expect(statements[1]).toContain('INSERT INTO sample');
    expect(statements[2]).toContain("'x; y'");
  });

  it('resolves safe output path templates', () => {
    expect(resolveTemplate('out/${symbol}-${date}.csv', {
      symbol: '002155',
      date: '2026/07/16',
    })).toBe('out/002155-2026_07_16.csv');
    expect(() => resolveTemplate('${missing}.csv', {})).toThrow('缺少参数');
  });

  it('formats CJK table cells without corrupting alignment content', () => {
    const content = formatRows([
      { symbol: '002155', name: '湖南黄金', value: 1.23 },
    ], 'table');
    expect(content).toContain('湖南黄金');
    expect(content).toContain('(1 rows)');
  });

  it('groups result rows for dynamic split exports', () => {
    const groups = groupRowsByColumn([
      { symbol: '000001', value: 1 },
      { symbol: '600000', value: 2 },
      { symbol: '000001', value: 3 },
    ], 'symbol');
    expect([...groups.keys()]).toEqual(['000001', '600000']);
    expect(groups.get('000001')).toHaveLength(2);
    expect(() => groupRowsByColumn([{ value: 1 }], 'symbol')).toThrow('不存在');
  });
});
