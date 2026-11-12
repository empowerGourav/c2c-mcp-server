import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import type { C2cAccount, C2cPrincipal } from '../src/auth/principal.js';
import type { QueryLimits } from '../src/config.js';
import type { QueryExecutor, SqlParam, SqlRow } from '../src/data/database.js';
import type { Logger, LogFields } from '../src/logger.js';

export const TEST_LIMITS: QueryLimits = {
  defaultWindowDays: 30,
  maxLookbackDays: 90,
  maxRows: 500,
  maxResponseBytes: 131072,
};

export const FIXED_TODAY = new Date('2026-11-11T12:00:00Z');

export const MARKETPLACE: C2cAccount = {
  accountId: 11,
  type: 'marketplace',
  roleId: 2,
  customerId: 100,
  advertiserId: null,
  publisherId: null,
  customerName: 'Acme Marketplace',
  accountName: 'Acme Marketplace',
};

export const ADVERTISER: C2cAccount = {
  accountId: 12,
  type: 'advertiser',
  roleId: 2,
  customerId: 100,
  advertiserId: 200,
  publisherId: null,
  customerName: 'Acme Marketplace',
  accountName: 'Buyer Co',
};

export const PUBLISHER: C2cAccount = {
  accountId: 13,
  type: 'publisher',
  roleId: 2,
  customerId: 100,
  advertiserId: null,
  publisherId: 300,
  customerName: 'Acme Marketplace',
  accountName: 'Source Co',
};

export const SUPER_ADMIN: C2cAccount = {
  accountId: 0,
  type: 'superadmin',
  roleId: 1,
  customerId: null,
  advertiserId: null,
  publisherId: null,
  customerName: null,
  accountName: 'All customers',
};

export function makePrincipal(accounts: C2cAccount[] = [MARKETPLACE], timezone = 'America/Chicago'): C2cPrincipal {
  return { auditId: 'audit-1234', accounts, timezone };
}

export type Responder = (sql: string, params: readonly SqlParam[]) => SqlRow[] | Promise<SqlRow[]>;

/** Records every statement and returns canned rows. Procedure calls are recorded as `CALL <name>`. */
export class FakeExecutor implements QueryExecutor {
  readonly calls: { sql: string; params: readonly SqlParam[] }[] = [];

  constructor(private readonly respond: Responder = () => []) {}

  async select(sql: string, params: readonly SqlParam[]): Promise<SqlRow[]> {
    this.calls.push({ sql, params });
    return this.respond(sql, params);
  }

  async callProcedure(procedureName: string, params: readonly SqlParam[]): Promise<SqlRow[]> {
    const sql = `CALL ${procedureName}`;
    this.calls.push({ sql, params });
    return this.respond(sql, params);
  }

  async ping(): Promise<void> {}

  async close(): Promise<void> {}

  procedureCalls(): string[] {
    return this.calls.filter((call) => call.sql.startsWith('CALL ')).map((call) => call.sql.slice(5));
  }
}

/** Ownership checks answer "yes" only for the given (sql fragment, id, owner) triples. */
export function ownershipResponder(owned: [table: string, id: number, ownerId: number][], fallback: Responder = () => []): Responder {
  return (sql, params) => {
    if (sql.startsWith('SELECT 1 AS ok FROM ')) {
      const table = sql.slice('SELECT 1 AS ok FROM '.length).split(' ')[0];
      const match = owned.some(([t, id, owner]) => t === table && params[0] === id && params[1] === owner);
      return match ? [{ ok: 1 }] : [];
    }
    return fallback(sql, params);
  };
}

export interface CapturedLog {
  level: string;
  event: string;
  fields: LogFields;
}

export function captureLogger(): { logger: Logger; entries: CapturedLog[] } {
  const entries: CapturedLog[] = [];
  const at = (level: string) => (event: string, fields: LogFields = {}) => {
    entries.push({ level, event, fields });
  };
  return { logger: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') }, entries };
}

export const TEST_ISSUER = 'https://login.example.test/tenant/v2.0';
export const TEST_AUDIENCE = 'api://c2c-mcp-test';

/** A local signing key + matching JWKS so token tests need no network. */
export async function createTestIssuer() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const publicJwk: JWK = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
  const getKey = createLocalJWKSet({ keys: [publicJwk] });

  const sign = async (
    claims: Record<string, unknown>,
    overrides: { issuer?: string; audience?: string; expiresIn?: string | number; key?: Parameters<SignJWT['sign']>[0] } = {},
  ): Promise<string> => {
    const jwt = new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuedAt()
      .setIssuer(overrides.issuer ?? TEST_ISSUER)
      .setAudience(overrides.audience ?? TEST_AUDIENCE)
      .setExpirationTime(overrides.expiresIn ?? '5m');
    return jwt.sign(overrides.key ?? privateKey);
  };

  return { getKey, sign };
}
