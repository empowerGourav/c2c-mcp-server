import { describe, expect, it } from 'vitest';
import { DiscoveryError, discoverIssuer } from '../src/auth/oidc-discovery.js';

const ISSUER = 'https://login.example.test/tenant/v2.0';

describe('discoverIssuer', () => {
  it('explains how to fix a failing issuer, including static mode for local testing', async () => {
    const fakeFetch = (async () => new Response('bad tenant', { status: 400 })) as typeof fetch;
    const error = await discoverIssuer(ISSUER, 1000, fakeFetch).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DiscoveryError);
    expect((error as Error).message).toMatch(/HTTP 400.*OAUTH_ISSUER.*AUTH_MODE=static/);
  });

  it('wraps network failures with the same hint', async () => {
    const fakeFetch = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await expect(discoverIssuer(ISSUER, 1000, fakeFetch)).rejects.toThrow(/AUTH_MODE=static/);
  });

  it('rejects a document whose issuer does not match', async () => {
    const doc = {
      issuer: 'https://other.example/',
      authorization_endpoint: 'https://other.example/authorize',
      token_endpoint: 'https://other.example/token',
      jwks_uri: 'https://other.example/keys',
    };
    const fakeFetch = (async () => Response.json(doc)) as typeof fetch;
    await expect(discoverIssuer(ISSUER, 1000, fakeFetch)).rejects.toThrow(/does not match/);
  });
});
