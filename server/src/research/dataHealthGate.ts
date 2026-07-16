import type { Pool, RowDataPacket } from 'mysql2/promise';
import { getMinuteDataCatalog } from '../minuteData/minuteDataService.js';
import { getResearchSnapshotFreshness, type SnapshotFreshnessReport } from './snapshotFreshness.js';
import { readCurrentSnapshot } from './snapshotManifest.js';

export type DataHealthStatus = 'pass' | 'warn' | 'fail';

export interface DataHealthCheck {
  key: 'mysql_snapshot' | 'reference_snapshot' | 'minute_lake' | 'dividend_coverage'
    | 'index_constituents' | 'sw_industry';
  status: DataHealthStatus;
  message: string;
  details: Record<string, unknown>;
}

export interface ReferenceDataState {
  dividends: {
    totalStocks: number;
    completed: number;
    noData: number;
    failed: number;
    attempted: number;
    events: number;
    symbolsWithEvents: number;
  };
  indexConstituents: {
    snapshots: number;
    distinctDates: number;
    weightedSnapshots: number;
    minDate: string | null;
    maxDate: string | null;
  };
  swIndustry: {
    activeStocks: number;
    coveredStocks: number;
    barMaxDate: string | null;
    industries: number;
    barRows: number;
  };
}

export interface ReferenceSnapshotState {
  datasets: Record<string, { rows: number; maxDate: string | null }>;
}

export interface DataHealthGateReport {
  status: DataHealthStatus;
  checkedAt: string;
  checks: DataHealthCheck[];
}

interface DividendStateRow extends RowDataPacket {
  totalStocks: number | string;
  completed: number | string;
  noData: number | string;
  failed: number | string;
  attempted: number | string;
  events: number | string;
  symbolsWithEvents: number | string;
}

interface IndexStateRow extends RowDataPacket {
  snapshots: number | string;
  distinctDates: number | string;
  weightedSnapshots: number | string;
  minDate: string | null;
  maxDate: string | null;
}

interface SwStateRow extends RowDataPacket {
  activeStocks: number | string;
  coveredStocks: number | string;
  barMaxDate: string | null;
  industries: number | string;
  barRows: number | string;
}

export async function getDataHealthGate(
  pool: Pool,
  snapshotRoot: string,
  minuteRoot: string,
): Promise<DataHealthGateReport> {
  const [snapshot, minute, references, currentSnapshot] = await Promise.all([
    getResearchSnapshotFreshness(pool, snapshotRoot),
    getMinuteDataCatalog(minuteRoot),
    readReferenceDataState(pool),
    readCurrentSnapshot(snapshotRoot),
  ]);
  const referenceSnapshot: ReferenceSnapshotState = {
    datasets: Object.fromEntries(
      (currentSnapshot?.manifest.datasets ?? []).map((dataset) => [
        dataset.name,
        { rows: dataset.rows, maxDate: dataset.maxDate },
      ]),
    ),
  };
  return evaluateDataHealthGate(snapshot, minute, references, referenceSnapshot);
}

export function evaluateDataHealthGate(
  snapshot: SnapshotFreshnessReport,
  minute: Awaited<ReturnType<typeof getMinuteDataCatalog>>,
  references: ReferenceDataState,
  referenceSnapshot?: ReferenceSnapshotState,
): DataHealthGateReport {
  const checks: DataHealthCheck[] = [];
  checks.push({
    key: 'mysql_snapshot',
    status: snapshot.status === 'current' ? 'pass' : 'fail',
    message: snapshot.message,
    details: { snapshot: snapshot.snapshot, mysql: snapshot.mysql, missingDates: snapshot.missingDates },
  });

  const referenceComparisons = [
    ['dividend_events', references.dividends.events, null],
    ['index_constituent_snapshots', references.indexConstituents.snapshots, references.indexConstituents.maxDate],
    ['sw_industry_bars', references.swIndustry.barRows, references.swIndustry.barMaxDate],
  ] as const;
  const staleReferenceDatasets = referenceSnapshot
    ? referenceComparisons.flatMap(([name, rows, maxDate]) => {
        const dataset = referenceSnapshot.datasets[name];
        return !dataset || dataset.rows !== rows || (maxDate !== null && dataset.maxDate !== maxDate)
          ? [{ name, mysqlRows: rows, mysqlMaxDate: maxDate, snapshot: dataset ?? null }]
          : [];
      })
    : [];
  const referenceSnapshotCurrent = referenceSnapshot !== undefined
    && staleReferenceDatasets.length === 0;
  checks.push({
    key: 'reference_snapshot',
    status: referenceSnapshotCurrent ? 'pass' : 'fail',
    message: referenceSnapshotCurrent
      ? '研究快照中的分红、指数成分和申万行业数据已追平 MySQL'
      : '研究快照中的参考数据落后或缺失，需要重新构建并发布快照',
    details: { staleDatasets: staleReferenceDatasets },
  });

  const authoritativeDate = snapshot.mysql.maxDate;
  const minuteReady = minute.status === 'ready';
  const minuteCurrent = minuteReady
    && authoritativeDate !== null
    && minute.lastDate !== null
    && minute.lastDate >= authoritativeDate;
  checks.push({
    key: 'minute_lake',
    status: minuteCurrent ? 'pass' : 'fail',
    message: minuteCurrent
      ? `分钟湖已覆盖权威日线日期 ${authoritativeDate}`
      : `分钟湖未覆盖权威日线日期 ${authoritativeDate ?? 'N/A'}`,
    details: minute,
  });

  const dividendCovered = references.dividends.completed + references.dividends.noData;
  const dividendComplete = references.dividends.totalStocks > 0
    && dividendCovered >= references.dividends.totalStocks
    && references.dividends.failed === 0;
  checks.push({
    key: 'dividend_coverage',
    status: dividendComplete ? 'pass' : 'fail',
    message: dividendComplete
      ? '分红历史已对全部股票形成 completed/no_data 明确状态'
      : '分红历史仍有未尝试或失败股票，不能把缺失事件解释为零分红',
    details: {
      ...references.dividends,
      covered: dividendCovered,
      remaining: Math.max(0, references.dividends.totalStocks - dividendCovered),
    },
  });

  const constituentsReady = references.indexConstituents.distinctDates >= 12
    && references.indexConstituents.weightedSnapshots >= 12;
  checks.push({
    key: 'index_constituents',
    status: constituentsReady ? 'pass' : 'fail',
    message: constituentsReady
      ? '指数成分与权重至少覆盖 12 个历史截面'
      : '指数成分或权重历史截面不足 12 个，不能可靠开展动态指数回测',
    details: references.indexConstituents,
  });

  const swCoverage = references.swIndustry.activeStocks === 0
    ? 0
    : references.swIndustry.coveredStocks / references.swIndustry.activeStocks;
  const swCurrent = authoritativeDate !== null
    && references.swIndustry.barMaxDate !== null
    && references.swIndustry.barMaxDate >= authoritativeDate;
  const swReady = swCoverage >= 0.99 && swCurrent && references.swIndustry.industries > 0;
  checks.push({
    key: 'sw_industry',
    status: swReady ? 'pass' : 'fail',
    message: swReady
      ? '申万行业成员覆盖与行业日线均满足回测门禁'
      : '申万行业成员覆盖不足或行业日线落后于权威日线',
    details: { ...references.swIndustry, activeCoverage: swCoverage },
  });

  return {
    status: checks.some((check) => check.status === 'fail')
      ? 'fail'
      : checks.some((check) => check.status === 'warn') ? 'warn' : 'pass',
    checkedAt: new Date().toISOString(),
    checks,
  };
}

async function readReferenceDataState(pool: Pool): Promise<ReferenceDataState> {
  const [[dividendRows], [indexRows], [swRows]] = await Promise.all([
    pool.query<DividendStateRow[]>(`
      SELECT
        (SELECT COUNT(*) FROM instruments WHERE type='stock') AS totalStocks,
        SUM(item.status='completed') AS completed,
        SUM(item.status='no_data') AS noData,
        SUM(item.status='failed') AS failed,
        COUNT(item.instrument_key) AS attempted,
        (SELECT COUNT(*) FROM dividend_events) AS events,
        (SELECT COUNT(DISTINCT instrument_key) FROM dividend_events) AS symbolsWithEvents
      FROM reference_data_backfill_items AS item
      WHERE item.task_key='dividend-history-akshare-em'
    `),
    pool.query<IndexStateRow[]>(`
      SELECT COUNT(*) AS snapshots,
             COUNT(DISTINCT CASE
               WHEN weight_date IS NOT NULL
                AND (
                  weight_method='official'
                  OR (
                    weight_method='price_drift_verified'
                    AND validation_half_l1_pct <= 1.5
                  )
                )
               THEN constituent_date
             END) AS distinctDates,
             SUM(
               weight_date IS NOT NULL
               AND (
                 weight_method='official'
                 OR (
                   weight_method='price_drift_verified'
                   AND validation_half_l1_pct <= 1.5
                 )
               )
             ) AS weightedSnapshots,
             DATE_FORMAT(MIN(constituent_date), '%Y-%m-%d') AS minDate,
             DATE_FORMAT(MAX(constituent_date), '%Y-%m-%d') AS maxDate
      FROM index_constituent_snapshots
      WHERE status='published'
    `),
    pool.query<SwStateRow[]>(`
      SELECT
        (SELECT COUNT(*) FROM instruments WHERE type='stock' AND status='active') AS activeStocks,
        (
          SELECT COUNT(DISTINCT membership.instrument_key)
          FROM sw_industry_memberships AS membership
          INNER JOIN instruments AS instrument
            ON instrument.instrument_key=membership.instrument_key
           AND instrument.type='stock'
           AND instrument.status='active'
          WHERE membership.taxonomy_key='SW2021'
            AND membership.effective_to IS NULL
        ) AS coveredStocks,
        (
          SELECT DATE_FORMAT(MAX(trade_date), '%Y-%m-%d')
          FROM sw_industry_daily_bars
          WHERE taxonomy_key='SW2021'
        ) AS barMaxDate,
        (
          SELECT COUNT(*)
          FROM sw_industry_definitions
          WHERE taxonomy_key='SW2021' AND industry_level=1
        ) AS industries
        ,
        (
          SELECT COUNT(*)
          FROM sw_industry_daily_bars
          WHERE taxonomy_key='SW2021'
        ) AS barRows
    `),
  ]);
  const dividends = dividendRows[0];
  const constituents = indexRows[0];
  const sw = swRows[0];
  return {
    dividends: {
      totalStocks: numberOf(dividends?.totalStocks),
      completed: numberOf(dividends?.completed),
      noData: numberOf(dividends?.noData),
      failed: numberOf(dividends?.failed),
      attempted: numberOf(dividends?.attempted),
      events: numberOf(dividends?.events),
      symbolsWithEvents: numberOf(dividends?.symbolsWithEvents),
    },
    indexConstituents: {
      snapshots: numberOf(constituents?.snapshots),
      distinctDates: numberOf(constituents?.distinctDates),
      weightedSnapshots: numberOf(constituents?.weightedSnapshots),
      minDate: constituents?.minDate ?? null,
      maxDate: constituents?.maxDate ?? null,
    },
    swIndustry: {
      activeStocks: numberOf(sw?.activeStocks),
      coveredStocks: numberOf(sw?.coveredStocks),
      barMaxDate: sw?.barMaxDate ?? null,
      industries: numberOf(sw?.industries),
      barRows: numberOf(sw?.barRows),
    },
  };
}

function numberOf(value: number | string | null | undefined): number {
  return Number(value ?? 0);
}
