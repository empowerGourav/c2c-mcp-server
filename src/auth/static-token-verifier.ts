import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { OAuthError, OAuthErrorCode, type AuthInfo, type OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Logger } from '../logger.js';
import type { VerifiedTokenExtra } from './token-verifier.js';

const MIN_TOKEN_LENGTH = 32;
/** The SDK rejects AuthInfo without an expiry; static tokens are re-validated on every request anyway. */
const SESSION_EXPIRY_SECONDS = 300;

const credentialsSchema = z.strictObject({
  credentials: z
    .array(
      z.strictObject({
        email: z.email(),
        token: z.string().min(MIN_TOKEN_LENGTH).max(512),
        label: z.string().max(100).optional(),
      }),
    )
    .min(1),
});

export type StaticCredentials = z.infer<typeof credentialsSchema>;

/**
 * Interim authentication for local testing and early environments: a fixed set of long random bearer tokens,
 * each bound to a C2C user e-mail. The e-mail then goes through the same users → user_role_association
 * resolution as OAuth, so data scoping is identical. Only SHA-256 hashes of the tokens are kept in memory.
 *
 * Replace with AUTH_MODE=oauth before wider rollout: static tokens cannot expire or be revoked individually
 * without a restart.
 */
export class StaticTokenVerifier implements OAuthTokenVerifier {
  private readonly byHash: Map<string, { email: string; label: string }>;

  constructor(
    credentials: StaticCredentials,
    private readonly scopes: string[],
    private readonly logger: Logger,
  ) {
    this.byHash = new Map();
    for (const entry of credentials.credentials) {
      const hash = sha256(entry.token);
      if (this.byHash.has(hash)) throw new Error('Duplicate token in static credentials');
      this.byHash.set(hash, { email: entry.email.toLowerCase(), label: entry.label ?? 'static' });
    }
  }

  /**
   * Load and validate a credentials file.
   *
   * @throws {Error} When the file is unreadable, malformed, or contains short/duplicate tokens.
   */
  static async fromFile(path: string, scopes: string[], logger: Logger): Promise<StaticTokenVerifier> {
    const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
    return new StaticTokenVerifier(credentialsSchema.parse(raw), scopes, logger);
  }

  get credentialCount(): number {
    return this.byHash.size;
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    // Map lookup is on a hash of the token, so timing reveals nothing about valid tokens.
    const match = this.byHash.get(sha256(token));
    if (!match) {
      this.logger.warn('auth.token_rejected', { reason: 'unknown_static_token' });
      throw new OAuthError(OAuthErrorCode.InvalidToken, 'Access token is invalid');
    }
    const extra: VerifiedTokenExtra = { identity: match.email };
    return {
      token,
      clientId: match.label,
      scopes: this.scopes,
      expiresAt: Math.floor(Date.now() / 1000) + SESSION_EXPIRY_SECONDS,
      extra: { ...extra },
    };
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
