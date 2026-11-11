import { VIEW_CONTRACTS } from './allowlist.js';
import type { QueryExecutor, SqlParam, SqlRow } from './database.js';

export interface DateRange {
  startDate: string;
  endDate: string;
}

export interface ScopedQuery extends DateRange {
  /** Already-authorized campaign refs. Never empty; never client-supplied without authorization. */
  campaignRefs: readonly string[];
  /** Maximum rows to return. The repository fetches one extra row to detect truncation. */
  maxRows: number;
}

export interface CampaignDailyRow {
  reportDate: string;
  campaignRef: string;
  callCount: number;
  conversionCount: number;
}

export interface CallOutcomeRow {
  outcomeCode: string;
  callCount: number;
}

export interface QueryResult<Row> {
  rows: Row[];
  truncated: boolean;
}

export class RowShapeError extends Error {
  override readonly name = 'RowShapeError';
}

const campaign = VIEW_CONTRACTS.campaignDaily;
const outcome = VIEW_CONTRACTS.callOutcomeDaily;

/**
 * Fixed, parameterized queries against the approved reporting views (plan §5.1).
 * SQL text is built only from compile-time constants and placeholder counts; caller values are bound.
 */
export class ReportingRepository {
  constructor(private readonly executor: QueryExecutor) {}

  /**
   * Daily calls/conversions per campaign.
   *
   * @throws {RowShapeError} If the view returns unexpected column types.
   */
  async campaignDailySummary(query: ScopedQuery): Promise<QueryResult<CampaignDailyRow>> {
    assertScope(query);
    const sql =
      `SELECT report_date, campaign_ref, SUM(call_count) AS call_count, SUM(conversion_count) AS conversion_count ` +
      `FROM ${campaign.view} ` +
      `WHERE report_date BETWEEN ? AND ? AND campaign_ref IN (${placeholders(query.campaignRefs.length)}) ` +
      `GROUP BY report_date, campaign_ref ORDER BY report_date, campaign_ref LIMIT ?`;
    const params: SqlParam[] = [query.startDate, query.endDate, ...query.campaignRefs, limitParam(query.maxRows)];
    const rows = await this.executor.select(sql, params);
    return limitRows(rows.map(toCampaignDailyRow), query.maxRows);
  }

  /**
   * Call counts per approved outcome code over the whole date range.
   *
   * @param outcomeCodes - Approved outcome codes to include (validated by the caller). Never empty.
   * @throws {RowShapeError} If the view returns unexpected column types.
   */
  async callOutcomeSummary(query: ScopedQuery & { outcomeCodes: readonly string[] }): Promise<QueryResult<CallOutcomeRow>> {
    assertScope(query);
    if (query.outcomeCodes.length === 0) throw new RangeError('outcomeCodes must not be empty');
    const sql =
      `SELECT outcome_code, SUM(call_count) AS call_count ` +
      `FROM ${outcome.view} ` +
      `WHERE report_date BETWEEN ? AND ? AND campaign_ref IN (${placeholders(query.campaignRefs.length)}) ` +
      `AND outcome_code IN (${placeholders(query.outcomeCodes.length)}) ` +
      `GROUP BY outcome_code ORDER BY outcome_code LIMIT ?`;
    const params: SqlParam[] = [
      query.startDate,
      query.endDate,
      ...query.campaignRefs,
      ...query.outcomeCodes,
      limitParam(query.maxRows),
    ];
    const rows = await this.executor.select(sql, params);
    return limitRows(rows.map(toCallOutcomeRow), query.maxRows);
  }
}

function assertScope(query: ScopedQuery): void {
  // Fail closed: an empty scope must never become an unfiltered query.
  if (query.campaignRefs.length === 0) throw new RangeError('campaignRefs must not be empty');
  if (!Number.isInteger(query.maxRows) || query.maxRows <= 0) throw new RangeError('maxRows must be a positive integer');
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function limitRows<Row>(rows: Row[], maxRows: number): QueryResult<Row> {
  return rows.length > maxRows ? { rows: rows.slice(0, maxRows), truncated: true } : { rows, truncated: false };
}

function toCampaignDailyRow(row: SqlRow): CampaignDailyRow {
  return {
    reportDate: readString(row, 'report_date'),
    campaignRef: readString(row, 'campaign_ref'),
    callCount: readCount(row, 'call_count'),
    conversionCount: readCount(row, 'conversion_count'),
  };
}

function toCallOutcomeRow(row: SqlRow): CallOutcomeRow {
  return { outcomeCode: readString(row, 'outcome_code'), callCount: readCount(row, 'call_count') };
}

function readString(row: SqlRow, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw new RowShapeError(`Column ${column} is not a string`);
  return value;
}

function readCount(row: SqlRow, column: string): number {
  const value = typeof row[column] === 'string' ? Number(row[column]) : row[column];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new RowShapeError(`Column ${column} is not a non-negative integer`);
  }
  return value;
}

/**
 * Fetch one extra row to detect truncation. mysql2 `execute()` must bind LIMIT as a string:
 * numeric binding fails on MySQL >= 8.0.22 ("Incorrect arguments to mysqld_stmt_execute").
 */
function limitParam(maxRows: number): string {
  return String(maxRows + 1);
}
