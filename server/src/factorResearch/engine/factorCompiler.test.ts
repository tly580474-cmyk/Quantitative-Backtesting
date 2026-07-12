import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import type { FactorAstNode, FactorDefinition } from '../definitions/schema.js';
import { compileFactorSql } from './factorCompiler.js';

function astFactor(root: FactorAstNode): FactorDefinition {
  return {
    id: 'candidate_test', name: '候选测试', description: 'test', direction: 'research',
    dependencies: ['close', 'previousClose'], warmupDays: 5,
    expression: { type: 'ast', version: 1, root },
  };
}

describe('factor AST compiler', () => {
  it('compiles a versioned rolling AST to DuckDB SQL', () => {
    const sql = compileFactorSql(astFactor({
      type: 'operator', op: 'ts_mean', window: 5,
      args: [{ type: 'terminal', name: 'returns' }],
    }));
    expect(sql).toContain('AVG(');
    expect(sql).toContain('ROWS BETWEEN 4 PRECEDING');
    expect(sql).toContain('previousClose');
  });

  it('rejects operators outside the whitelist', () => {
    expect(() => compileFactorSql(astFactor({
      type: 'operator', op: 'arbitrary_sql', args: [],
    }))).toThrow('不支持的因子算子');
  });

  it('requires declared dependencies and sufficient warmup', () => {
    const factor = astFactor({
      type: 'operator', op: 'ts_mean', window: 20,
      args: [{ type: 'terminal', name: 'close' }],
    });
    expect(() => compileFactorSql(factor)).toThrow('预热期');
  });

  it('matches the shared Python/DuckDB parity fixture', async () => {
    const serverRelative = resolve('src/factorResearch/engine/factorAstParity.fixture.json');
    const fixturePath = existsSync(serverRelative) ? serverRelative
      : resolve('server/src/factorResearch/engine/factorAstParity.fixture.json');
    const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as {
      expression: FactorDefinition['expression'];
      rows: Array<{ tradeDate: string; close: number; previousClose: number; logMktCap: number }>;
      compareFrom: string; expected: number[]; tolerance: number;
      scalarExpression: FactorDefinition['expression']; scalarExpected: number[];
      neutralExpression: FactorDefinition['expression']; neutralExpected: number[];
      rankExpression: FactorDefinition['expression']; rankValues: Array<number | null>;
      rankExpected: Array<number | null>;
    };
    const factor: FactorDefinition = {
      id: 'parity', name: 'parity', description: 'parity', direction: 'research',
      dependencies: ['close', 'previousClose'], warmupDays: 5, expression: fixture.expression,
    };
    const sql = compileFactorSql(factor);
    const values = fixture.rows.map((row) =>
      `(1, DATE '${row.tradeDate}', ${row.close}, ${row.previousClose}, EXP(${row.logMktCap}), 'fixture')`).join(',');
    const neutralValues = fixture.rows.map((row, index) =>
      `(${index + 1}, DATE '2024-01-02', ${row.close}, ${row.previousClose}, EXP(${row.logMktCap}), 'fixture')`).join(',');
    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();
    try {
      const reader = await connection.runAndReadAll(`
        WITH source(instrumentKey, tradeDate, close, previousClose, totalMarketCap, industry) AS (VALUES ${values}),
        scored AS (
          SELECT tradeDate, ${sql} AS factorValue FROM source
          WINDOW instrument_window AS (PARTITION BY instrumentKey ORDER BY tradeDate)
        )
        SELECT factorValue FROM scored WHERE tradeDate >= DATE '${fixture.compareFrom}'
        ORDER BY tradeDate
      `);
      const actual = reader.getRowObjectsJson().map((row) => Number(row.factorValue));
      expect(actual).toHaveLength(fixture.expected.length);
      actual.forEach((value, index) => {
        expect(Math.abs(value - fixture.expected[index])).toBeLessThanOrEqual(fixture.tolerance);
      });
      const scalarSql = compileFactorSql({ ...factor, expression: fixture.scalarExpression, warmupDays: 0 });
      const scalarReader = await connection.runAndReadAll(`
        WITH source(instrumentKey, tradeDate, close, previousClose, totalMarketCap, industry) AS (VALUES ${values})
        SELECT ${scalarSql} AS factorValue FROM source ORDER BY tradeDate
      `);
      const scalarActual = scalarReader.getRowObjectsJson().map((row) => Number(row.factorValue));
      scalarActual.forEach((value, index) => {
        expect(Math.abs(value - fixture.scalarExpected[index])).toBeLessThanOrEqual(fixture.tolerance);
      });
      const neutralFactor = { ...factor, expression: fixture.neutralExpression,
        dependencies: ['close', 'totalMarketCap'] as FactorDefinition['dependencies'], warmupDays: 0 };
      const neutralSql = compileFactorSql(neutralFactor);
      const neutralReader = await connection.runAndReadAll(`
        WITH source(instrumentKey, tradeDate, close, previousClose, totalMarketCap, industry) AS (VALUES ${neutralValues})
        SELECT instrumentKey, ${neutralSql} AS factorValue FROM source ORDER BY instrumentKey
      `);
      neutralReader.getRowObjectsJson().forEach((row, index) => {
        expect(Math.abs(Number(row.factorValue) - fixture.neutralExpected[index])).toBeLessThanOrEqual(1e-10);
      });
      const rankSql = compileFactorSql({ ...factor, expression: fixture.rankExpression,
        dependencies: ['close'], warmupDays: 0 });
      const rankValues = fixture.rankValues.map((value, index) =>
        `(${index + 1}, DATE '2024-01-02', ${value === null ? 'NULL' : value})`).join(',');
      const rankReader = await connection.runAndReadAll(`
        WITH source(instrumentKey, tradeDate, close) AS (VALUES ${rankValues})
        SELECT instrumentKey, ${rankSql} AS factorValue FROM source ORDER BY instrumentKey
      `);
      rankReader.getRowObjectsJson().forEach((row, index) => {
        const expected = fixture.rankExpected[index];
        if (expected === null) expect(row.factorValue).toBeNull();
        else expect(Math.abs(Number(row.factorValue) - expected)).toBeLessThanOrEqual(fixture.tolerance);
      });
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
  });
});
