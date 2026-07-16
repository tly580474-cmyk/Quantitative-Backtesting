import type { Pool, RowDataPacket } from 'mysql2/promise';

export type ReconciliationStatus = 'pass' | 'fail';

export interface ReconciliationCheck {
  key: string;
  status: ReconciliationStatus;
  message: string;
  issues: number;
  details?: Record<string, unknown>;
}

export interface DataReconciliationReport {
  status: ReconciliationStatus;
  checkedAt: string;
  checks: ReconciliationCheck[];
}

interface CountRow extends RowDataPacket {
  issues: number | string | null;
}

interface KeyRow extends RowDataPacket {
  columns: string | null;
}

export async function reconcileDatabase(pool: Pool): Promise<DataReconciliationReport> {
  const [
    [dailyKeyRows],
    [metricKeyRows],
    [snapshotCountRows],
    [weightRows],
    [derivedRows],
    [industryOverlapRows],
    [industryCurrentRows],
    [factorRows],
    [dividendRows],
  ] = await Promise.all([
    pool.query<KeyRow[]>(`
      SELECT GROUP_CONCAT(column_name ORDER BY seq_in_index) AS columns
      FROM information_schema.statistics
      WHERE table_schema=DATABASE()
        AND table_name='daily_bars_v2'
        AND index_name='PRIMARY'
    `),
    pool.query<KeyRow[]>(`
      SELECT GROUP_CONCAT(column_name ORDER BY seq_in_index) AS columns
      FROM information_schema.statistics
      WHERE table_schema=DATABASE()
        AND table_name='daily_stock_metrics'
        AND index_name='PRIMARY'
    `),
    pool.query<CountRow[]>(`
      SELECT COUNT(*) AS issues
      FROM (
        SELECT snapshot.snapshot_id
        FROM index_constituent_snapshots AS snapshot
        LEFT JOIN index_constituent_members AS member
          ON member.snapshot_id=snapshot.snapshot_id
        WHERE snapshot.status='published'
        GROUP BY snapshot.snapshot_id, snapshot.member_count
        HAVING COUNT(member.constituent_code) <> snapshot.member_count
      ) AS mismatches
    `),
    pool.query<CountRow[]>(`
      SELECT COUNT(*) AS issues
      FROM index_constituent_snapshots
      WHERE status='published'
        AND weight_date IS NOT NULL
        AND (weight_sum_pct IS NULL OR weight_sum_pct < 99 OR weight_sum_pct > 101)
    `),
    pool.query<CountRow[]>(`
      SELECT COUNT(*) AS issues
      FROM index_constituent_snapshots
      WHERE status='published'
        AND weight_method='price_drift_verified'
        AND (
          anchor_snapshot_id IS NULL
          OR validation_snapshot_id IS NULL
          OR validation_half_l1_pct IS NULL
          OR validation_half_l1_pct > 1.5
        )
    `),
    pool.query<CountRow[]>(`
      SELECT COUNT(*) AS issues
      FROM (
        SELECT taxonomy_key, symbol, effective_from,
               LAG(effective_to) OVER (
                 PARTITION BY taxonomy_key, symbol ORDER BY effective_from
               ) AS previous_effective_to
        FROM sw_industry_memberships
      ) AS ranges
      WHERE previous_effective_to IS NULL
        AND effective_from <> (
          SELECT MIN(inner_membership.effective_from)
          FROM sw_industry_memberships AS inner_membership
          WHERE inner_membership.taxonomy_key=ranges.taxonomy_key
            AND inner_membership.symbol=ranges.symbol
        )
         OR previous_effective_to >= effective_from
    `),
    pool.query<CountRow[]>(`
      SELECT COUNT(*) AS issues
      FROM (
        SELECT taxonomy_key, symbol, COUNT(*) AS active_rows
        FROM sw_industry_memberships
        WHERE effective_to IS NULL
        GROUP BY taxonomy_key, symbol
        HAVING COUNT(*) <> 1
      ) AS invalid_current
    `),
    pool.query<CountRow[]>(`
      SELECT COUNT(*) AS issues
      FROM instruments AS instrument
      LEFT JOIN adjustment_factor_publications AS publication
        ON publication.instrument_key=instrument.instrument_key
      WHERE instrument.type='stock'
        AND instrument.status='active'
        AND publication.instrument_key IS NULL
    `),
    pool.query<CountRow[]>(`
      SELECT
        (SELECT COUNT(*) FROM instruments WHERE type='stock')
        - SUM(item.status IN ('completed', 'no_data'))
        + SUM(item.status='failed') AS issues
      FROM reference_data_backfill_items AS item
      WHERE item.task_key='dividend-history-akshare-em'
    `),
  ]);

  const checks = [
    keyCheck(
      'daily_primary_key',
      '日线主键约束',
      dailyKeyRows[0]?.columns,
      'instrument_key,trade_date',
    ),
    keyCheck(
      'valuation_primary_key',
      '估值主键约束',
      metricKeyRows[0]?.columns,
      'instrument_key,trade_date',
    ),
    countCheck(
      'index_member_count',
      '指数快照成员数对账',
      numberOf(snapshotCountRows[0]?.issues),
    ),
    countCheck(
      'index_weight_sum',
      '指数权重合计范围',
      numberOf(weightRows[0]?.issues),
    ),
    countCheck(
      'derived_weight_validation',
      '派生权重双锚点验证',
      numberOf(derivedRows[0]?.issues),
    ),
    countCheck(
      'industry_effective_ranges',
      '行业有效期无重叠',
      numberOf(industryOverlapRows[0]?.issues),
    ),
    countCheck(
      'industry_current_unique',
      '当前行业归属唯一',
      numberOf(industryCurrentRows[0]?.issues),
    ),
    countCheck(
      'adjustment_publications',
      '活跃股票复权发布完整',
      numberOf(factorRows[0]?.issues),
    ),
    countCheck(
      'dividend_backfill',
      '分红回补终态完整',
      numberOf(dividendRows[0]?.issues),
    ),
  ];
  return {
    status: aggregateReconciliationStatus(checks),
    checkedAt: new Date().toISOString(),
    checks,
  };
}

export function aggregateReconciliationStatus(
  checks: Pick<ReconciliationCheck, 'status'>[],
): ReconciliationStatus {
  return checks.some((check) => check.status === 'fail') ? 'fail' : 'pass';
}

function keyCheck(
  key: string,
  label: string,
  actual: string | null | undefined,
  expected: string,
): ReconciliationCheck {
  const pass = actual === expected;
  return {
    key,
    status: pass ? 'pass' : 'fail',
    message: pass ? `${label}正确` : `${label}异常：${actual ?? 'missing'}`,
    issues: pass ? 0 : 1,
    details: { expected, actual: actual ?? null },
  };
}

function countCheck(key: string, label: string, issues: number): ReconciliationCheck {
  return {
    key,
    status: issues === 0 ? 'pass' : 'fail',
    message: issues === 0 ? `${label}通过` : `${label}发现 ${issues} 项异常`,
    issues,
  };
}

function numberOf(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}
