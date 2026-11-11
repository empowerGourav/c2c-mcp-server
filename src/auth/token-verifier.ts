import { OAuthError, OAuthErrorCode, type AuthInfo, type OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { errors as joseErrors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { Logger } from '../logger.js';

export interface JwtVerifierOptions {
  issuer: string;
  audience: string;
  algorithms: string[];
  subjectClaim: string;
  /** Key resolver, normally `createRemoteJWKSet(jwksUri)`; injected so tests can use a local key set. */
  getKey: JWTVerifyGetKey;
  logger: Logger;
}

/** Claims we carry forward on `AuthInfo.extra`. Only the verified subject; never the raw token. */
export interface VerifiedTokenExtra {
  subject: string;
}

/**
 * Validates OAuth 2.1 / OIDC JWT access tokens locally against the issuer's JWKS (plan §7.1):
 * signature, issuer, audience, expiry (with `exp` mandatory), and allowed algorithms.
 * Required-scope enforcement is done by the SDK's `requireBearerAuth` using the scopes returned here.
 */
export class JwtTokenVerifier implements OAuthTokenVerifier {
  constructor(private readonly options: JwtVerifierOptions) {}

  /**
   * @param token - The raw bearer token.
   * @returns Verified token information for the MCP SDK.
   * @throws {OAuthError} `invalid_token` for any verification failure.
   */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.options.getKey, {
        issuer: this.options.issuer,
        audience: this.options.audience,
        algorithms: this.options.algorithms,
        requiredClaims: ['exp', 'iss', 'aud'],
      }));
    } catch (error) {
      this.options.logger.warn('auth.token_rejected', { reason: describeJoseError(error) });
      throw new OAuthError(OAuthErrorCode.InvalidToken, 'Access token is invalid or expired');
    }

    const subject = payload[this.options.subjectClaim];
    if (typeof subject !== 'string' || subject.length === 0) {
      this.options.logger.warn('auth.token_rejected', { reason: 'missing_subject_claim' });
      throw new OAuthError(OAuthErrorCode.InvalidToken, 'Access token has no subject');
    }

    const extra: VerifiedTokenExtra = { subject };
    return {
      token,
      clientId: readClientId(payload),
      scopes: readScopes(payload),
      expiresAt: payload.exp,
      extra: { ...extra },
    };
  }
}

/** Entra ID uses `scp` (space-delimited); generic OAuth servers use `scope`. Some issue arrays. */
function readScopes(payload: JWTPayload): string[] {
  const raw = payload['scp'] ?? payload['scope'];
  if (typeof raw === 'string') return raw.split(' ').filter((scope) => scope.length > 0);
  if (Array.isArray(raw)) return raw.filter((scope): scope is string => typeof scope === 'string');
  return [];
}

function readClientId(payload: JWTPayload): string {
  for (const claim of ['azp', 'appid', 'client_id'] as const) {
    const value = payload[claim];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return 'unknown';
}

function describeJoseError(error: unknown): string {
  if (error instanceof joseErrors.JOSEError) return error.code;
  return 'unexpected_error';
}
