import { OAuthError } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { StaticTokenVerifier } from '../src/auth/static-token-verifier.js';
import { captureLogger } from './helpers.js';

const TOKEN = 'c2c_' + 'a'.repeat(40);

function build(credentials = [{ email: 'Pat@Example.com', token: TOKEN, label: 'laptop' }]) {
  const { logger, entries } = captureLogger();
  return { verifier: new StaticTokenVerifier({ credentials }, [], logger), entries };
}

describe('StaticTokenVerifier', () => {
  it('maps a known token to its (lower-cased) e-mail identity with an expiry', async () => {
    const { verifier } = build();
    const info = await verifier.verifyAccessToken(TOKEN);
    expect(info.extra).toEqual({ identity: 'pat@example.com' });
    expect(info.clientId).toBe('laptop');
    expect(info.expiresAt).toBeGreaterThan(Date.now() / 1000);
  });

  it('rejects unknown tokens without logging them', async () => {
    const { verifier, entries } = build();
    const wrong = 'c2c_' + 'b'.repeat(40);
    await expect(verifier.verifyAccessToken(wrong)).rejects.toBeInstanceOf(OAuthError);
    expect(JSON.stringify(entries)).not.toContain(wrong);
  });

  it('refuses duplicate tokens at load time', () => {
    expect(() =>
      build([
        { email: 'a@example.com', token: TOKEN, label: 'a' },
        { email: 'b@example.com', token: TOKEN, label: 'b' },
      ]),
    ).toThrow(/Duplicate/);
  });

  it('refuses short tokens and malformed e-mails in the credentials file', async () => {
    const { logger } = captureLogger();
    const { writeFile, mkdtemp } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(join(tmpdir(), 'c2c-cred-'));

    const shortToken = join(dir, 'short.json');
    await writeFile(shortToken, JSON.stringify({ credentials: [{ email: 'a@example.com', token: 'short' }] }));
    await expect(StaticTokenVerifier.fromFile(shortToken, [], logger)).rejects.toThrow();

    const badEmail = join(dir, 'email.json');
    await writeFile(badEmail, JSON.stringify({ credentials: [{ email: 'not-an-email', token: TOKEN }] }));
    await expect(StaticTokenVerifier.fromFile(badEmail, [], logger)).rejects.toThrow();
  });
});
