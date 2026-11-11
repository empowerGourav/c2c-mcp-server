import {
  CALL_LOG_PROCEDURE,
  callLogArgs,
  type CallLogArgs,
  FINANCIALS_PROCEDURE,
  KPI_PROCEDURES,
  type AccountType,
  type FinancialPeriod,
  type KpiArgs,
  type KpiProcedure,
} from './allowlist.js';
import type { QueryExecutor, SqlParam, SqlRow } from './database.js';

export interface KpiResult {
  metrics: Record<string, number | null>;
  unavailable: string[];
}

export interface FinancialSummary {
  period: FinancialPeriod;
  revenue: number;
  cost: number;
  profit: number;
  marginPercent: number | null;
}

/** Row-level scope for the `calls` trend query. Exactly one owner key is set (none for super admin). */
export interface TrendScope {
  customerId: number | null;
  advertiserId: number | null;
  publisherId: number | null;
}

export interface TrendQuery extends TrendScope {
  startDateTime: string;
  endDateTime: string;
  timezone: string;
  verticalId: number | null;
  offerId: number | null;
  campaignId: number | null;
  maxRows: number;
}

export interface TrendRow {
  reportDate: string;
  totalCalls: number;
  billableCalls: number;
  payableCalls: number;
  avgDurationSeconds: number;
  advertiserRevenue: number;
  publisherPayout: number;
}

export class RowShapeError extends Error {
  override readonly name = 'RowShapeError';
}

/**
 * Daily trend over `calls`. Timestamps are stored in UTC; the range is converted once so the
 * `created_at` predicate stays index-friendly, and days are bucketed in the caller's timezone
 * (same CONVERT_TZ approach the Laravel reports use). Every optional filter uses the `(? IS NULL OR col = ?)` form.
 */
const TREND_SQL =
  'SELECT DATE(CONVERT_TZ(c.created_at, \'UTC\', ?)) AS report_date, ' +
  'COUNT(*) AS total_calls, ' +
  'SUM(c.is_billable = 1) AS billable_calls, ' +
  'SUM(c.is_payable = 1) AS payable_calls, ' +
  'COALESCE(ROUND(AVG(c.call_duration)), 0) AS avg_duration, ' +
  'COALESCE(SUM(c.customer_revenue), 0) AS advertiser_revenue, ' +
  'COALESCE(SUM(c.publisher_payout), 0) AS publisher_payout ' +
  'FROM calls c ' +
  'JOIN campaigns cp ON cp.id = c.campaign_id ' +
  'LEFT JOIN offers o ON o.id = c.offer_id ' +
  'WHERE c.created_at >= CONVERT_TZ(?, ?, \'UTC\') AND c.created_at <= CONVERT_TZ(?, ?, \'UTC\') ' +
  'AND (? IS NULL OR cp.customer_id = ?) ' +
  'AND (? IS NULL OR o.advertiser_id = ?) ' +
  'AND (? IS NULL OR cp.publisher_id = ?) ' +
  'AND (? IS NULL OR cp.vertical_id = ?) ' +
  'AND (? IS NULL OR c.offer_id = ?) ' +
  'AND (? IS NULL OR c.campaign_id = ?) ' +
  'GROUP BY report_date ORDER BY report_date LIMIT ?';

/** Calls the allowlisted reporting procedures and the fixed trend query. */
export class ReportingRepository {
  constructor(
    private readonly executor: QueryExecutor,
    private readonly maxParallelProcedures: number,
  ) {}

  /**
   * Run every dashboard KPI procedure for an account type. One failing procedure does not fail the rest;
   * it is reported in `unavailable`. If all fail, the first error is rethrown.
   */
  async dashboardKpis(type: AccountType, args: KpiArgs): Promise<KpiResult> {
    const procedures = KPI_PROCEDURES[type];
    const outcomes = await mapLimited(procedures, this.maxParallelProcedures, async (entry) => {
      const rows = await this.executor.callProcedure(entry.procedure, entry.args(args));
      return readKpiValue(entry, rows[0]);
    });

    const metrics: Record<string, number | null> = {};
    const unavailable: string[] = [];
    outcomes.forEach((outcome, index) => {
      const metric = procedures[index]!.metric;
      if (outcome.status === 'fulfilled') {
        metrics[metric] = outcome.value;
      } else {
        metrics[metric] = null;
        unavailable.push(metric);
      }
    });
    const firstFailure = outcomes.find((outcome) => outcome.status === 'rejected');
    if (unavailable.length === procedures.length && firstFailure?.status === 'rejected') throw firstFailure.reason;
    return { metrics, unavailable };
  }

  /** Marketplace financials for one period (`getCustomerDashboardFinancialsReplica`). */
  async financials(customerId: number | null, period: FinancialPeriod, timezone: string): Promise<FinancialSummary> {
    const rows = await this.executor.callProcedure(FINANCIALS_PROCEDURE, [customerId, period, timezone]);
    const row = rows[0] ?? {};
    const revenue = readMoney(row, 'call_revenue');
    const cost = readMoney(row, 'call_cost');
    const profit = round2(revenue - cost);
    return { period, revenue, cost, profit, marginPercent: revenue > 0 ? round2((profit / revenue) * 100) : null };
  }

  /** One raw call-log page; see {@link fetchCallLogPage}. */
  async callLog(args: CallLogArgs): Promise<CallLogPage> {
    return fetchCallLogPage(this.executor, args);
  }

  /** Daily aggregates over `calls` within the given scope. Fetches one extra row to detect truncation. */
  async dailyTrend(query: TrendQuery): Promise<{ rows: TrendRow[]; truncated: boolean }> {
    if (query.customerId === null && query.advertiserId === null && query.publisherId === null) {
      throw new RangeError('A trend query requires an owner scope');
    }
    const pair = (value: number | null): SqlParam[] => [value, value];
    const params: SqlParam[] = [
      query.timezone,
      query.startDateTime,
      query.timezone,
      query.endDateTime,
      query.timezone,
      ...pair(query.customerId),
      ...pair(query.advertiserId),
      ...pair(query.publisherId),
      ...pair(query.verticalId),
      ...pair(query.offerId),
      ...pair(query.campaignId),
      String(query.maxRows + 1),
    ];
    const rows = (await this.executor.select(TREND_SQL, params)).map(toTrendRow);
    return rows.length > query.maxRows ? { rows: rows.slice(0, query.maxRows), truncated: true } : { rows, truncated: false };
  }
}

/** Run `work` over `items` with at most `limit` in flight; preserves order. */
async function mapLimited<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { status: 'fulfilled', value: await work(items[index]!) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Take the KPI value from a single-row procedure result. Uses the known column when the Laravel caller names it;
 * otherwise the row must contain exactly one numeric value. Non-numeric values are never returned.
 */
function readKpiValue(entry: KpiProcedure, row: SqlRow | undefined): number | null {
  if (!row) return null;
  if (entry.column !== undefined) return toNumber(row[entry.column]) ?? 0;
  const numeric = Object.values(row).map(toNumber).filter((value): value is number => value !== null);
  if (numeric.length === 1) return numeric[0]!;
  if (Object.values(row).every((value) => value === null)) return 0;
  throw new RowShapeError(`Procedure ${entry.procedure} returned an unexpected shape`);
}

function toTrendRow(row: SqlRow): TrendRow {
  const reportDate = row['report_date'];
  if (typeof reportDate !== 'string') throw new RowShapeError('report_date is not a string');
  return {
    reportDate,
    totalCalls: readCount(row, 'total_calls'),
    billableCalls: readCount(row, 'billable_calls'),
    payableCalls: readCount(row, 'payable_calls'),
    avgDurationSeconds: readCount(row, 'avg_duration'),
    advertiserRevenue: readMoney(row, 'advertiser_revenue'),
    publisherPayout: readMoney(row, 'publisher_payout'),
  };
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value);
  return null;
}

function readCount(row: SqlRow, column: string): number {
  const value = toNumber(row[column] ?? 0);
  if (value === null || value < 0) throw new RowShapeError(`${column} is not a non-negative number`);
  return Math.round(value);
}

function readMoney(row: SqlRow, column: string): number {
  const value = toNumber(row[column] ?? 0);
  if (value === null) throw new RowShapeError(`${column} is not numeric`);
  return round2(value);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export interface CallLogPage {
  rows: SqlRow[];
  /** Total matching calls, from the procedure's `totalCount` column (0 when no rows). */
  totalCount: number;
}

/**
 * One page of the call log (`getCallLogReportReplica`). Rows are returned raw; the caller MUST project them
 * through `CALL_LOG_COLUMNS` — they contain caller numbers, recording URLs, and other excluded fields.
 */
export async function fetchCallLogPage(executor: QueryExecutor, args: CallLogArgs): Promise<CallLogPage> {
  if (args.customerId === null && args.advertiserId === null && args.publisherId === null) {
    throw new RangeError('A call log query requires an owner scope');
  }
  if (args.callTagIds !== '' && !/^\d{1,9}(,\d{1,9}){0,49}$/.test(args.callTagIds)) {
    throw new RangeError('callTagIds must be comma-separated integers');
  }
  const rows = await executor.callProcedure(CALL_LOG_PROCEDURE, callLogArgs(args));
  const first = rows[0];
  const totalCount = first ? (toNumber(first['totalCount']) ?? rows.length) : 0;
  return { rows, totalCount };
}
