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

export const DIMENSION_KINDS = ['customers', 'verticals', 'advertisers', 'publishers', 'offers', 'campaigns'] as const;
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

interface DimensionSpec {
  table: string;
  nameColumn: string;
  /** Extra "is live" predicate; always starts with a `status <> ?` bound to STATUS_DELETED. */
  live: string;
  /** Owner column per scope kind; `self` always means `id`. Missing kinds are not listable that way. */
  scopes: Partial<Record<DimensionScope['by'], string | null>>;
}

const LIVE = 'status <> ?';
const LIVE_NOT_DELETED = 'status <> ? AND COALESCE(is_deleted, 0) = 0';

/** Fixed table/column names per kind. Only `id` and a display name are ever selected. */
const DIMENSIONS: Record<DimensionKind, DimensionSpec> = {
  customers: { table: 'customers', nameColumn: 'company_name', live: LIVE, scopes: { none: null, self: 'id' } },
  verticals: { table: 'verticals', nameColumn: 'name', live: LIVE, scopes: { none: null } },
  advertisers: {
    table: 'advertisers',
    nameColumn: 'company_name',
    live: LIVE,
    scopes: { none: null, customer: 'customer_id', self: 'id' },
  },
  publishers: {
    table: 'publishers',
    nameColumn: 'company_name',
    live: LIVE,
    scopes: { none: null, customer: 'customer_id', self: 'id' },
  },
  offers: {
    table: 'offers',
    nameColumn: 'offer_name',
    live: LIVE_NOT_DELETED,
    scopes: { none: null, customer: 'customer_id', advertiser: 'advertiser_id' },
  },
  campaigns: {
    table: 'campaigns',
    nameColumn: 'campaign_name',
    live: LIVE_NOT_DELETED,
    scopes: { none: null, customer: 'customer_id', publisher: 'publisher_id' },
  },
};

/**
 * Build the fixed SQL for one (kind, scope) pair. Identifiers come only from DIMENSIONS; the name filter uses
 * the `(? IS NULL OR name LIKE ?)` form so the statement text never depends on caller input.
 */
function dimensionSql(spec: DimensionSpec, ownerColumn: string | null): string {
  const owner = ownerColumn === null ? '' : `${ownerColumn} = ? AND `;
  return (
    `SELECT id, ${spec.nameColumn} AS name FROM ${spec.table} ` +
    `WHERE ${owner}${spec.live} AND (? IS NULL OR ${spec.nameColumn} LIKE ?) ` +
    `ORDER BY ${spec.nameColumn} LIMIT ?`
  );
}

/** Escape LIKE wildcards so a name filter is a plain substring match. */
function likeContains(value: string): string {
  return `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

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
   * @param nameContains - Optional case-insensitive substring filter on the display name.
   * @throws {UnsupportedScopeError} When the kind cannot be listed under that scope.
   */
  async listDimension(
    kind: DimensionKind,
    scope: DimensionScope,
    maxRows: number,
    nameContains?: string,
  ): Promise<{ rows: DimensionRow[]; truncated: boolean }> {
    const spec = DIMENSIONS[kind];
    const ownerColumn = spec.scopes[scope.by];
    if (ownerColumn === undefined) throw new UnsupportedScopeError(`${kind} cannot be listed by ${scope.by}`);

    const params: SqlParam[] = [];
    if (scope.by === 'customer') params.push(scope.customerId);
    if (scope.by === 'advertiser') params.push(scope.advertiserId);
    if (scope.by === 'publisher') params.push(scope.publisherId);
    if (scope.by === 'self') params.push(scope.id);
    const pattern = nameContains ? likeContains(nameContains) : null;
    params.push(STATUS_DELETED, pattern, pattern, String(maxRows + 1));

    const rows = await this.executor.select(dimensionSql(spec, ownerColumn), params);
    const mapped = rows
      .map((row) => ({ id: Number(row['id']), name: typeof row['name'] === 'string' ? row['name'].slice(0, 200) : '' }))
      .filter((row) => Number.isSafeInteger(row.id) && row.id > 0);
    return mapped.length > maxRows ? { rows: mapped.slice(0, maxRows), truncated: true } : { rows: mapped, truncated: false };
  }
}
