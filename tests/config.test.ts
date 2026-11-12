import { describe, expect, it } from 'vitest';
import { ConfigError, isIanaTimezone, loadConfig } from '../src/config.js';

const validEnv: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  MCP_PUBLIC_URL: 'https://c2c-mcp.example.test/mcp',
  OAUTH_ISSUER: 'https://login.example.test/tenant/v2.0',
  OAUTH_AUDIENCE: 'api://c2c-mcp',
  OAUTH_REQUIRED_SCOPES: 'c2c.reporting.read',
  DB_HOST: 'c2c.cluster-ro-abc.us-east-1.rds.amazonaws.com',
  DB_NAME: 'c2c',
  DB_USER: 'mcp_reporting_reader',
  DB_PASSWORD: 'placeholder',
  AUDIT_HASH_SALT: '0123456789abcdef0123',
};

describe('loadConfig', () => {
  it('applies the plan defaults', () => {
    const config = loadConfig(validEnv);
    expect(config.limits).toEqual({ defaultWindowDays: 30, maxLookbackDays: 90, maxRows: 500, maxResponseBytes: 131072 });
    expect(config.rateLimit.perMinute).toBe(30);
    expect(config.database.statementTimeoutMs).toBe(5000);
    expect(config.auth).toMatchObject({ mode: 'oauth', identityClaim: 'email', allowedAlgorithms: ['RS256'] });
    expect(config.reporting.defaultTimezone).toBe('America/Chicago');
    expect(config.identity.allowSuperAdmin).toBe(false);
  });

  it('fails fast when a required secret is missing', () => {
    const { DB_PASSWORD: _omitted, ...env } = validEnv;
    expect(() => loadConfig(env)).toThrow(ConfigError);
  });

  it('rejects an invalid default timezone', () => {
    expect(() => loadConfig({ ...validEnv, DEFAULT_TIMEZONE: 'Chicago' })).toThrow(ConfigError);
  });

  it('refuses to disable database TLS in production', () => {
    expect(() => loadConfig({ ...validEnv, NODE_ENV: 'production', DB_SSL_DISABLED: 'true' })).toThrow(ConfigError);
  });

  it('requires OAuth settings in oauth mode and a credentials file in static mode', () => {
    const { OAUTH_ISSUER: _issuer, ...noIssuer } = validEnv;
    expect(() => loadConfig(noIssuer)).toThrow(/OAUTH_ISSUER/);
    expect(() => loadConfig({ ...noIssuer, AUTH_MODE: 'static' })).toThrow(/STATIC_CREDENTIALS_PATH/);
    const config = loadConfig({ ...noIssuer, AUTH_MODE: 'static', STATIC_CREDENTIALS_PATH: './config/credentials.json' });
    expect(config.auth).toEqual({
      mode: 'static',
      credentialsSource: 'file',
      credentialsPath: './config/credentials.json',
      requiredScopes: [],
    });
  });

  it('accepts static credentials from a deployment environment variable', () => {
    const { OAUTH_ISSUER: _issuer, ...noIssuer } = validEnv;
    const credentialsJson = JSON.stringify({ credentials: [{ email: 'a@example.com', token: 'a'.repeat(32) }] });
    const config = loadConfig({ ...noIssuer, AUTH_MODE: 'static', STATIC_CREDENTIALS_JSON: credentialsJson });
    expect(config.auth).toEqual({
      mode: 'static',
      credentialsSource: 'environment',
      credentialsJson,
      requiredScopes: [],
    });
    expect(() =>
      loadConfig({
        ...noIssuer,
        AUTH_MODE: 'static',
        STATIC_CREDENTIALS_PATH: './config/credentials.json',
        STATIC_CREDENTIALS_JSON: credentialsJson,
      }),
    ).toThrow(/only one/);
  });

  it('keeps procedure parallelism within the pool size', () => {
    expect(() => loadConfig({ ...validEnv, DB_CONNECTION_LIMIT: '2', MAX_PARALLEL_PROCEDURES: '3' })).toThrow(ConfigError);
  });
});

describe('isIanaTimezone', () => {
  it.each(['America/Chicago', 'UTC', 'Asia/Kolkata', 'America/Argentina/Buenos_Aires'])('accepts %s', (zone) => {
    expect(isIanaTimezone(zone)).toBe(true);
  });

  it.each(['Chicago', "UTC'); DROP", '+05:30', '', 'Mars/Olympus'])('rejects %j', (zone) => {
    expect(isIanaTimezone(zone)).toBe(false);
  });
});
