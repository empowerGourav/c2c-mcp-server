import type { OAuthMetadata } from '@modelcontextprotocol/server';
import { z } from 'zod';

const discoverySchema = z.looseObject({
  issuer: z.url(),
  authorization_endpoint: z.url(),
  token_endpoint: z.url(),
  jwks_uri: z.url(),
  response_types_supported: z.array(z.string()).default(['code']),
});

export interface IssuerMetadata {
  jwksUri: URL;
  /** Authorization Server metadata re-published at `/.well-known/oauth-authorization-server`. */
  oauthMetadata: OAuthMetadata;
}

export class DiscoveryError extends Error {
  override readonly name = 'DiscoveryError';
}

/**
 * Fetch the issuer's OpenID Provider configuration once at startup.
 *
 * @param issuer - Expected issuer URL (e.g. `https://login.microsoftonline.com/<tenant>/v2.0`).
 * @param timeoutMs - Network timeout.
 * @param fetchImpl - Injected for tests.
 * @throws {DiscoveryError} When the document is unreachable, malformed, or names a different issuer.
 */
export async function discoverIssuer(
  issuer: string,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<IssuerMetadata> {
  const url = new URL('.well-known/openid-configuration', issuer.endsWith('/') ? issuer : `${issuer}/`);
  let body: unknown;
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      // Drain the body so the socket is released before startup aborts.
      await response.body?.cancel();
      throw new DiscoveryError(
        `OIDC discovery at ${url.origin} returned HTTP ${response.status}. Check OAUTH_ISSUER, ` +
          'or set AUTH_MODE=static (with STATIC_CREDENTIALS_PATH) for local testing.',
      );
    }
    body = await response.json();
  } catch (error) {
    if (error instanceof DiscoveryError) throw error;
    throw new DiscoveryError(
      `Could not fetch OIDC discovery document from ${url.origin}. Check OAUTH_ISSUER and network access, ` +
        'or set AUTH_MODE=static for local testing.',
      { cause: error },
    );
  }

  const parsed = discoverySchema.safeParse(body);
  if (!parsed.success) throw new DiscoveryError('OIDC discovery document is malformed');
  if (parsed.data.issuer !== issuer) {
    throw new DiscoveryError('OIDC discovery issuer does not match OAUTH_ISSUER');
  }

  return {
    jwksUri: new URL(parsed.data.jwks_uri),
    oauthMetadata: {
      issuer: parsed.data.issuer,
      authorization_endpoint: parsed.data.authorization_endpoint,
      token_endpoint: parsed.data.token_endpoint,
      response_types_supported: parsed.data.response_types_supported,
      code_challenge_methods_supported: ['S256'],
    },
  };
}
