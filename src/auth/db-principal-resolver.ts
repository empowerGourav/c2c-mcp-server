import { STATUS_ACTIVE, SUPER_ADMIN_ROLE_ID, USER_TYPE, type AccountType, DEFAULT_USER_TIMEZONE, USER_TIMEZONES } from '../data/allowlist.js';
import type { QueryExecutor, SqlRow } from '../data/database.js';
import type { Logger } from '../logger.js';
import { hashIdentity, type C2cAccount, type C2cPrincipal, type PrincipalResolver } from './principal.js';

export interface DbPrincipalResolverOptions {
  executor: QueryExecutor;
  auditHashSalt: string;
  allowSuperAdmin: boolean;
  cacheTtlMs: number;
  logger: Logger;
  now?: () => number;
}

// `users` has no role column: roles live on `user_role_association`.
const USER_SQL = 'SELECT id, time_zone FROM users WHERE email = ? AND status = ? LIMIT 2';

// Super admins hold an active association with role_id 1 and no customer, so ACCOUNTS_SQL's
// inner join on `customers` never returns that row; it is checked separately.
const SUPER_ADMIN_SQL =
  'SELECT id FROM user_role_association WHERE user_id = ? AND role_id = ? AND status = ? LIMIT 1';

const ACCOUNTS_SQL =
  'SELECT ura.id, ura.role_id, ura.user_type_id, ura.customer_id, ura.advertiser_id, ura.publisher_id, ' +
  'cu.company_name AS customer_name, ad.company_name AS advertiser_name, pu.company_name AS publisher_name ' +
  'FROM user_role_association ura ' +
  'JOIN customers cu ON cu.id = ura.customer_id ' +
  'LEFT JOIN advertisers ad ON ad.id = ura.advertiser_id ' +
  'LEFT JOIN publishers pu ON pu.id = ura.publisher_id ' +
  'WHERE ura.user_id = ? AND ura.status = ? AND cu.status = ? ' +
  'ORDER BY ura.id LIMIT 50';

/**
 * Resolves the authenticated e-mail to the user's active C2C accounts, exactly as the Laravel login does:
 * `users` (status 8) → `user_role_association` (status 8). The scope comes only from these rows; super-admin
 * status is an active association with role_id 1, never a column on `users`.
 *
 * Results are cached briefly per identity so a burst of tool calls does not re-query the reader.
 */
export class DbPrincipalResolver implements PrincipalResolver {
  private readonly cache = new Map<string, { expiresAt: number; principal: C2cPrincipal | null }>();
  private readonly now: () => number;

  constructor(private readonly options: DbPrincipalResolverOptions) {
    this.now = options.now ?? Date.now;
  }

  async resolve(identity: string): Promise<C2cPrincipal | null> {
    const key = identity.trim().toLowerCase();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.principal;

    const principal = await this.load(key);
    this.cache.set(key, { expiresAt: this.now() + this.options.cacheTtlMs, principal });
    if (this.cache.size > 5000) this.cache.clear();
    return principal;
  }

  private async load(email: string): Promise<C2cPrincipal | null> {
    const users = await this.options.executor.select(USER_SQL, [email, STATUS_ACTIVE]);
    // Unknown or duplicated e-mail: fail closed.
    if (users.length !== 1) return null;
    const user = users[0]!;
    const userId = toId(user['id']);
    if (userId === null) return null;

    const accounts: C2cAccount[] = [];
    const superAdmin = await this.options.executor.select(SUPER_ADMIN_SQL, [userId, SUPER_ADMIN_ROLE_ID, STATUS_ACTIVE]);
    if (superAdmin.length > 0) {
      if (!this.options.allowSuperAdmin) {
        this.options.logger.warn('auth.super_admin_blocked');
        return null;
      }
      accounts.push({
        accountId: 0,
        type: 'superadmin',
        roleId: SUPER_ADMIN_ROLE_ID,
        customerId: null,
        advertiserId: null,
        publisherId: null,
        customerName: null,
        accountName: 'All customers',
      });
    }

    const rows = await this.options.executor.select(ACCOUNTS_SQL, [userId, STATUS_ACTIVE, STATUS_ACTIVE]);
    for (const row of rows) {
      const account = toAccount(row);
      if (account) accounts.push(account);
    }
    if (accounts.length === 0) return null;
    return { auditId: hashIdentity(email, this.options.auditHashSalt), accounts, timezone: toTimezone(user['time_zone']) };
  }
}

/** Map one association row; rows whose type and IDs are inconsistent are dropped (fail closed). */
function toAccount(row: SqlRow): C2cAccount | null {
  const accountId = toId(row['id']);
  const customerId = toId(row['customer_id']);
  const roleId = toId(row['role_id']) ?? 0;
  if (accountId === null || customerId === null) return null;

  const userType = toId(row['user_type_id']);
  let type: AccountType;
  let advertiserId: number | null = null;
  let publisherId: number | null = null;
  let accountName = toText(row['customer_name']);

  if (userType === USER_TYPE.customer) {
    type = 'marketplace';
  } else if (userType === USER_TYPE.advertiser) {
    advertiserId = toId(row['advertiser_id']);
    if (advertiserId === null) return null;
    type = 'advertiser';
    accountName = toText(row['advertiser_name']);
  } else if (userType === USER_TYPE.publisher) {
    publisherId = toId(row['publisher_id']);
    if (publisherId === null) return null;
    type = 'publisher';
    accountName = toText(row['publisher_name']);
  } else {
    return null; // Partner and unknown user types are not supported.
  }

  return {
    accountId,
    type,
    roleId,
    customerId,
    advertiserId,
    publisherId,
    customerName: toText(row['customer_name']),
    accountName,
  };
}

/** Same rule as the Laravel login: empty → EST; unknown abbreviations fall back to EST as well. */
function toTimezone(value: unknown): string {
  const abbreviation = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return USER_TIMEZONES[abbreviation] ?? DEFAULT_USER_TIMEZONE;
}

function toId(value: unknown): number | null {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function toText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, 200) : null;
}
