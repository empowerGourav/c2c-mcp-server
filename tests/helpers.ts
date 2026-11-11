import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import type { C2cPrincipal } from '../src/auth/principal.js';
import type { AppConfig, QueryLimits } from '../src/config.js';
import { VIEW_CONTRACTS } from '../src/data/allowlist.js';
import type { QueryExecutor, SqlParam, SqlRow } from '../src/data/database.js';
import type { Logger, LogFields } from '../src/logger.js';

export const TEST_LIMITS: QueryLimits = {
  defaultWindowDays: 30,
  maxLookbackDays: 90,
  maxRows: 500,
  maxResponseBytes: 131072,
  minAggregateGroupSize: 10,
  maxCampaignRefsPerPrincipal: 1000,
};

export const ALL_VIEWS_APPROVED: AppConfig['reporting'] = {
  approvedViews: new Set([VIEW_CONTRACTS.campaignDaily.view, VIEW_CONTRACTS.callOutcomeDaily.view]),
  outcomeCodes: ['ANSWERED', 'CONVERTED', 'NO_ANSWER'],
  freshnessNote: 'Test data',
};

export const FIXED_TODAY = new Date('2026-11-11T12:00:00Z');

export function makePrincipal(campaignRefs: string[] = ['CMP-A', 'CMP-B']): C2cPrincipal {
  return { auditId: 'audit-1234', campaignRefs: new Set(campaignRefs) };
}

/** Records every statement and returns canned rows. */
export class FakeExecutor implements QueryExecutor {
  readonly calls: { sql: string; params: readonly SqlParam[] }[] = [];

  constructor(private readonly respond: (sql: string, params: readonly SqlParam[]) => SqlRow[] | Promise<SqlRow[]> = () => []) {}

  async select(sql: string, params: readonly SqlParam[]): Promise<SqlRow[]> {
    this.calls.push({ sql, params });
    return this.respond(sql, params);
  }

  async ping(): Promise<void> {}

  async close(): Promise<void> {}
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
    overrides: { issuer?: string; audience?: string; expiresIn?: string | number; key?: Parameters<SignJWT["sign"]>[0] } = {},
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
