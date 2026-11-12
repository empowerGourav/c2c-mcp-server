import { OAuthError } from '@modelcontextprotocol/server';
import { generateKeyPair } from 'jose';
import { describe, expect, it } from 'vitest';
import { DbPrincipalResolver } from '../src/auth/db-principal-resolver.js';
import { hashIdentity } from '../src/auth/principal.js';
import { JwtTokenVerifier } from '../src/auth/token-verifier.js';
import type { SqlRow } from '../src/data/database.js';
import { captureLogger, createTestIssuer, FakeExecutor, TEST_AUDIENCE, TEST_ISSUER } from './helpers.js';

async function buildVerifier() {
  const issuer = await createTestIssuer();
  const { logger, entries } = captureLogger();
  const verifier = new JwtTokenVerifier({
    issuer: TEST_ISSUER,
    audience: TEST_AUDIENCE,
    algorithms: ['RS256'],
    identityClaim: 'email',
    getKey: issuer.getKey,
    logger,
  });
  return { verifier, sign: issuer.sign, entries };
}

describe('JwtTokenVerifier', () => {
  it('accepts a valid token and carries only the identity claim', async () => {
    const { verifier, sign } = await buildVerifier();
    const token = await sign({ email: 'pat@example.com', scp: 'c2c.reporting.read other', azp: 'claude-client' });
    const info = await verifier.verifyAccessToken(token);
    expect(info.scopes).toEqual(['c2c.reporting.read', 'other']);
    expect(info.clientId).toBe('claude-client');
    expect(info.extra).toEqual({ identity: 'pat@example.com' });
  });

  it.each([
    ['wrong issuer', { issuer: 'https://evil.example/' }],
    ['wrong audience', { audience: 'api://other' }],
    ['expired', { expiresIn: Math.floor(Date.now() / 1000) - 60 }],
  ])('rejects a token with %s', async (_label, overrides) => {
    const { verifier, sign } = await buildVerifier();
    await expect(verifier.verifyAccessToken(await sign({ email: 'pat@example.com' }, overrides))).rejects.toBeInstanceOf(OAuthError);
  });

  it('rejects a token signed by an unknown key', async () => {
    const { verifier, sign } = await buildVerifier();
    const { privateKey } = await generateKeyPair('RS256');
    await expect(verifier.verifyAccessToken(await sign({ email: 'a@b.c' }, { key: privateKey }))).rejects.toBeInstanceOf(OAuthError);
  });

  it('rejects a token without the identity claim and never logs the token', async () => {
    const { verifier, sign, entries } = await buildVerifier();
    const token = await sign({ sub: 'only-a-subject' });
    await expect(verifier.verifyAccessToken(token)).rejects.toBeInstanceOf(OAuthError);
    expect(JSON.stringify(entries)).not.toContain(token);
  });
});

const SALT = 'test-salt-0123456789';

// Columns of the live C2C `users` table (staging Aurora, checked 2026-11-12). It has no role column.
const USERS_COLUMNS = new Set([
  'id', 'terms_conditions_id', 'first_name', 'last_name', 'designation_title', 'email', 'phone', 'password',
  'email_verified_status', 'status', 'approval_status', 'remember_token', 'is_work_with_representative',
  'representative_user_id', 'signature_string', 'ip_address', 'approver', 'is_stop_notification',
  'login_attempt_count', 'account_sid', 'auth_token', 'time_zone', 'created_at', 'updated_at',
]);

/** Fail like MySQL (ER_BAD_FIELD_ERROR) when a `users` query names a column the real table lacks. */
function assertUsersColumns(sql: string): void {
  const match = /^SELECT (.+?) FROM users WHERE (.+?) LIMIT/.exec(sql);
  if (!match) return;
  const referenced = [...match[1]!.split(','), ...match[2]!.split(/\bAND\b/).map((part) => part.split('=')[0]!)];
  for (const column of referenced.map((name) => name.trim())) {
    if (!USERS_COLUMNS.has(column)) throw new Error(`ER_BAD_FIELD_ERROR: Unknown column '${column}'`);
  }
}

function buildResolver(
  users: SqlRow[],
  associations: SqlRow[],
  options: { allowSuperAdmin?: boolean; superAdmin?: boolean; now?: () => number } = {},
) {
  const executor = new FakeExecutor((sql) => {
    assertUsersColumns(sql);
    if (/ FROM users /.test(sql)) return users;
    if (sql.startsWith('SELECT id FROM user_role_association')) return options.superAdmin ? [{ id: 1 }] : [];
    return associations;
  });
  const { logger } = captureLogger();
  const resolver = new DbPrincipalResolver({
    executor,
    auditHashSalt: SALT,
    allowSuperAdmin: options.allowSuperAdmin ?? false,
    cacheTtlMs: 60_000,
    logger,
    now: options.now,
  });
  return { resolver, executor };
}

const association = (overrides: SqlRow): SqlRow => ({
  id: 11,
  role_id: 2,
  user_type_id: 1,
  customer_id: 100,
  advertiser_id: null,
  publisher_id: null,
  customer_name: 'Acme',
  advertiser_name: null,
  publisher_name: null,
  ...overrides,
});

describe('DbPrincipalResolver', () => {
  it('maps active associations to typed accounts and hashes the identity', async () => {
    const { resolver, executor } = buildResolver(
      [{ id: 7 }],
      [
        association({}),
        association({ id: 12, user_type_id: 2, advertiser_id: 200, advertiser_name: 'Buyer Co' }),
        association({ id: 13, user_type_id: 3, publisher_id: 300, publisher_name: 'Source Co' }),
      ],
    );
    const principal = await resolver.resolve('Pat@Example.com');

    expect(executor.calls[0]!.params).toEqual(['pat@example.com', 8]);
    expect(executor.calls[1]!.params).toEqual([7, 1, 8]);
    expect(executor.calls[2]!.params).toEqual([7, 8, 8]);
    expect(principal?.auditId).toBe(hashIdentity('pat@example.com', SALT));
    expect(principal?.accounts.map((a) => [a.type, a.customerId, a.advertiserId, a.publisherId, a.accountName])).toEqual([
      ['marketplace', 100, null, null, 'Acme'],
      ['advertiser', 100, 200, null, 'Buyer Co'],
      ['publisher', 100, null, 300, 'Source Co'],
    ]);
  });

  it.each([
    ['unknown e-mail', [], [association({})]],
    ['duplicate e-mail', [{ id: 7 }, { id: 8 }], [association({})]],
    ['no active associations', [{ id: 7 }], []],
    ['advertiser row without advertiser_id', [{ id: 7 }], [association({ user_type_id: 2 })]],
    ['partner/unknown user type', [{ id: 7 }], [association({ user_type_id: 4 })]],
  ])('fails closed for %s', async (_label, users, associations) => {
    const { resolver } = buildResolver(users as SqlRow[], associations as SqlRow[]);
    expect(await resolver.resolve('pat@example.com')).toBeNull();
  });

  it('queries only columns that exist on the real users table', async () => {
    const { resolver, executor } = buildResolver([{ id: 7 }], [association({})]);
    await expect(resolver.resolve('pat@example.com')).resolves.not.toBeNull();
    expect(executor.calls[0]!.sql).not.toMatch(/role_id/);
  });

  it('detects super admins from an active role_id 1 association, not from users', async () => {
    const blocked = buildResolver([{ id: 1 }], [], { superAdmin: true });
    expect(await blocked.resolver.resolve('root@example.com')).toBeNull();

    const allowed = buildResolver([{ id: 1 }], [], { superAdmin: true, allowSuperAdmin: true });
    const principal = await allowed.resolver.resolve('root@example.com');
    expect(allowed.executor.calls[1]!.sql).toMatch(/FROM user_role_association WHERE user_id = \? AND role_id = \? AND status = \?/);
    expect(allowed.executor.calls[1]!.params).toEqual([1, 1, 8]);
    expect(principal?.accounts).toEqual([expect.objectContaining({ accountId: 0, type: 'superadmin', customerId: null })]);
  });

  it('does not treat a user without a role_id 1 association as super admin', async () => {
    const { resolver } = buildResolver([{ id: 1 }], [], { allowSuperAdmin: true });
    expect(await resolver.resolve('root@example.com')).toBeNull();
  });

  it('caches lookups for the TTL', async () => {
    let now = 0;
    const { resolver, executor } = buildResolver([{ id: 7 }], [association({})], { now: () => now });
    await resolver.resolve('pat@example.com');
    await resolver.resolve('pat@example.com');
    expect(executor.calls).toHaveLength(3);
    now = 60_001;
    await resolver.resolve('pat@example.com');
    expect(executor.calls).toHaveLength(6);
  });
});
