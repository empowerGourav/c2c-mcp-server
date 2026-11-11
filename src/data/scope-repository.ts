import { STATUS_DELETED } from './allowlist.js';
import type { QueryExecutor, SqlParam } from './database.js';

/** Ownership checks: does entity `id` belong to `ownerId`? Fixed SQL; the key is chosen by code, never by input. */
const OWNERSHIP_SQL = {
  advertiserOfCustomer: 'SELECT 1 AS ok FROM advertisers WHERE id = ? AND customer_id = ? LIMIT 1',
  publisherOfCustomer: 'SELECT 1 AS ok FROM publishers WHERE id = ? AND customer_id = ? LIMIT 1',
  offerOfCustomer: 'SELECT 1 AS ok FROM offers WHERE id = ? AND customer_id = ? LIMIT 1',
  offerOfAdvertiser: 'SELECT 1 AS ok FROM offers WHERE id = ? AND advertiser_id = ? LIMIT 1',
  campaignOfCustomer: 'SELECT 1 AS ok FROM campaigns WHERE id = ? AND customer_id = ? LIMIT 1',
  campaignOfPublisher: 'SELECT 1 AS ok FROM campaigns WHERE id = ? AND publisher_id = ? LIMIT 1',
} as const;

export type OwnershipCheck = keyof typeof OWNERSHIP_SQL;

export const DIMENSION_KINDS = ['verticals', 'advertisers', 'publishers', 'offers', 'campaigns'] as const;
export type DimensionKind = (typeof DIMENSION_KINDS)[number];

/** How a dimension list is restricted. `none` is only used for globally shared lookups or super admin. */
export type DimensionScope =
  | { by: 'none' }
  | { by: 'customer'; customerId: number }
  | { by: 'advertiser'; advertiserId: number }
  | { by: 'publisher'; publisherId: number }
  | { by: 'self'; id: number };

export interface DimensionRow {
  id: number;
  name: string;
}

const NOT_DELETED_OFFER = 'status <> ? AND COALESCE(is_deleted, 0) = 0';
const NOT_DELETED_CAMPAIGN = 'status <> ? AND COALESCE(is_deleted, 0) = 0';

/** Fixed SQL per (kind, scope). Only `id` and a display name are ever selected. */
const DIMENSION_SQL: Record<DimensionKind, Partial<Record<DimensionScope['by'], string>>> = {
  verticals: { none: 'SELECT id, name FROM verticals WHERE status <> ? ORDER BY name LIMIT ?' },
  advertisers: {
    none: 'SELECT id, company_name AS name FROM advertisers WHERE status <> ? ORDER BY company_name LIMIT ?',
    customer: 'SELECT id, company_name AS name FROM advertisers WHERE customer_id = ? AND status <> ? ORDER BY company_name LIMIT ?',
    self: 'SELECT id, company_name AS name FROM advertisers WHERE id = ? AND status <> ? LIMIT ?',
  },
  publishers: {
    none: 'SELECT id, company_name AS name FROM publishers WHERE status <> ? ORDER BY company_name LIMIT ?',
    customer: 'SELECT id, company_name AS name FROM publishers WHERE customer_id = ? AND status <> ? ORDER BY company_name LIMIT ?',
    self: 'SELECT id, company_name AS name FROM publishers WHERE id = ? AND status <> ? LIMIT ?',
  },
  offers: {
    none: `SELECT id, offer_name AS name FROM offers WHERE ${NOT_DELETED_OFFER} ORDER BY offer_name LIMIT ?`,
    customer: `SELECT id, offer_name AS name FROM offers WHERE customer_id = ? AND ${NOT_DELETED_OFFER} ORDER BY offer_name LIMIT ?`,
    advertiser: `SELECT id, offer_name AS name FROM offers WHERE advertiser_id = ? AND ${NOT_DELETED_OFFER} ORDER BY offer_name LIMIT ?`,
  },
  campaigns: {
    none: `SELECT id, campaign_name AS name FROM campaigns WHERE ${NOT_DELETED_CAMPAIGN} ORDER BY campaign_name LIMIT ?`,
    customer: `SELECT id, campaign_name AS name FROM campaigns WHERE customer_id = ? AND ${NOT_DELETED_CAMPAIGN} ORDER BY campaign_name LIMIT ?`,
    publisher: `SELECT id, campaign_name AS name FROM campaigns WHERE publisher_id = ? AND ${NOT_DELETED_CAMPAIGN} ORDER BY campaign_name LIMIT ?`,
  },
};

export class UnsupportedScopeError extends Error {
  override readonly name = 'UnsupportedScopeError';
}

/** Read-only lookups used to authorize filters and to list filterable entities. */
export class ScopeRepository {
  constructor(private readonly executor: QueryExecutor) {}

  /** @returns true when entity `id` belongs to `ownerId` under the given relationship. */
  async owns(check: OwnershipCheck, id: number, ownerId: number): Promise<boolean> {
    const rows = await this.executor.select(OWNERSHIP_SQL[check], [id, ownerId]);
    return rows.length > 0;
  }

  /**
   * List active entities of one kind within a scope.
   *
   * @param maxRows - Row cap; one extra row is fetched to detect truncation.
   * @throws {UnsupportedScopeError} When the kind cannot be listed under that scope.
   */
  async listDimension(kind: DimensionKind, scope: DimensionScope, maxRows: number): Promise<{ rows: DimensionRow[]; truncated: boolean }> {
    const sql = DIMENSION_SQL[kind][scope.by];
    if (!sql) throw new UnsupportedScopeError(`${kind} cannot be listed by ${scope.by}`);

    const params: SqlParam[] = [];
    if (scope.by === 'customer') params.push(scope.customerId);
    if (scope.by === 'advertiser') params.push(scope.advertiserId);
    if (scope.by === 'publisher') params.push(scope.publisherId);
    if (scope.by === 'self') params.push(scope.id);
    params.push(STATUS_DELETED, String(maxRows + 1));

    const rows = await this.executor.select(sql, params);
    const mapped = rows
      .map((row) => ({ id: Number(row['id']), name: typeof row['name'] === 'string' ? row['name'].slice(0, 200) : '' }))
      .filter((row) => Number.isSafeInteger(row.id) && row.id > 0);
    return mapped.length > maxRows ? { rows: mapped.slice(0, maxRows), truncated: true } : { rows: mapped, truncated: false };
  }
}
