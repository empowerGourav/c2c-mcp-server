import { OAuthError } from '@modelcontextprotocol/server';
import { generateKeyPair } from 'jose';
import { describe, expect, it } from 'vitest';
import { hashSubject, StaticPrincipalResolver } from '../src/auth/principal.js';
import { JwtTokenVerifier } from '../src/auth/token-verifier.js';
import { captureLogger, createTestIssuer, TEST_AUDIENCE, TEST_ISSUER } from './helpers.js';

async function buildVerifier() {
  const issuer = await createTestIssuer();
  const { logger, entries } = captureLogger();
  const verifier = new JwtTokenVerifier({
    issuer: TEST_ISSUER,
    audience: TEST_AUDIENCE,
    algorithms: ['RS256'],
    subjectClaim: 'sub',
    getKey: issuer.getKey,
    logger,
  });
  return { verifier, sign: issuer.sign, entries };
}

describe('JwtTokenVerifier', () => {
  it('accepts a valid token and maps scopes, client and subject', async () => {
    const { verifier, sign } = await buildVerifier();
    const token = await sign({ sub: 'user-1', scp: 'c2c.reporting.read other', azp: 'claude-client' });
    const info = await verifier.verifyAccessToken(token);

    expect(info.scopes).toEqual(['c2c.reporting.read', 'other']);
    expect(info.clientId).toBe('claude-client');
    expect(info.extra).toEqual({ subject: 'user-1' });
    expect(info.expiresAt).toBeGreaterThan(Date.now() / 1000);
  });

  it.each([
    ['wrong issuer', { issuer: 'https://evil.example/' }],
    ['wrong audience', { audience: 'api://other' }],
    ['expired', { expiresIn: Math.floor(Date.now() / 1000) - 60 }],
  ])('rejects a token with %s', async (_label, overrides) => {
    const { verifier, sign } = await buildVerifier();
    const token = await sign({ sub: 'user-1' }, overrides);
    await expect(verifier.verifyAccessToken(token)).rejects.toBeInstanceOf(OAuthError);
  });

  it('rejects a token signed by an unknown key', async () => {
    const { verifier, sign } = await buildVerifier();
    const { privateKey } = await generateKeyPair('RS256');
    await expect(verifier.verifyAccessToken(await sign({ sub: 'user-1' }, { key: privateKey }))).rejects.toBeInstanceOf(
      OAuthError,
    );
  });

  it('rejects a token without a subject and never logs the token', async () => {
    const { verifier, sign, entries } = await buildVerifier();
    const token = await sign({});
    await expect(verifier.verifyAccessToken(token)).rejects.toBeInstanceOf(OAuthError);
    expect(JSON.stringify(entries)).not.toContain(token);
  });

  it('rejects garbage input', async () => {
    const { verifier } = await buildVerifier();
    await expect(verifier.verifyAccessToken('not-a-jwt')).rejects.toBeInstanceOf(OAuthError);
  });
});

describe('StaticPrincipalResolver', () => {
  const salt = 'test-salt-0123456789';
  const resolver = new StaticPrincipalResolver(
    {
      version: 1,
      principals: [
        { subject: 'active-user', status: 'active', campaignRefs: ['CMP-A'] },
        { subject: 'disabled-user', status: 'disabled', campaignRefs: ['CMP-A'] },
        { subject: 'no-scope-user', status: 'active', campaignRefs: [] },
        { subject: 'dupe-user', status: 'active', campaignRefs: ['CMP-A'] },
        { subject: 'dupe-user', status: 'active', campaignRefs: ['CMP-B'] },
      ],
    },
    salt,
    100,
  );

  it('resolves an active user with a hashed audit id', async () => {
    const principal = await resolver.resolve('active-user');
    expect(principal?.campaignRefs).toEqual(new Set(['CMP-A']));
    expect(principal?.auditId).toBe(hashSubject('active-user', salt));
    expect(principal?.auditId).not.toContain('active-user');
  });

  it.each(['unknown-user', 'disabled-user', 'no-scope-user', 'dupe-user'])('fails closed for %s', async (subject) => {
    expect(await resolver.resolve(subject)).toBeNull();
  });
});
