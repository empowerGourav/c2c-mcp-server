import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

const validEnv: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  MCP_PUBLIC_URL: 'https://c2c-mcp.example.test/mcp',
  OAUTH_ISSUER: 'https://login.example.test/tenant/v2.0',
  OAUTH_AUDIENCE: 'api://c2c-mcp',
  OAUTH_REQUIRED_SCOPES: 'c2c.reporting.read',
  DB_HOST: 'db.internal',
  DB_NAME: 'c2c_reporting',
  DB_USER: 'mcp_reader',
  DB_PASSWORD: 'placeholder',
  PRINCIPAL_MAP_PATH: './config/principals.json',
  AUDIT_HASH_SALT: '0123456789abcdef0123',
};

describe('loadConfig', () => {
  it('applies the plan defaults and an empty view allowlist', () => {
    const config = loadConfig(validEnv);
    expect(config.limits).toMatchObject({
      defaultWindowDays: 30,
      maxLookbackDays: 90,
      maxRows: 500,
      maxResponseBytes: 131072,
      minAggregateGroupSize: 10,
    });
    expect(config.rateLimit.perMinute).toBe(30);
    expect(config.database.statementTimeoutMs).toBe(5000);
    expect(config.reporting.approvedViews.size).toBe(0);
    expect(config.oauth.allowedAlgorithms).toEqual(['RS256']);
  });

  it('fails fast when a required secret is missing', () => {
    const { DB_PASSWORD: _omitted, ...env } = validEnv;
    expect(() => loadConfig(env)).toThrow(ConfigError);
  });

  it('rejects approving a view that has no reviewed contract', () => {
    expect(() => loadConfig({ ...validEnv, C2C_APPROVED_VIEWS: 'users' })).toThrow(/without a reviewed contract/);
  });

  it('accepts approving a known view', () => {
    const config = loadConfig({ ...validEnv, C2C_APPROVED_VIEWS: 'mcp_v_campaign_daily' });
    expect(config.reporting.approvedViews.has('mcp_v_campaign_daily')).toBe(true);
  });

  it('refuses to disable database TLS in production', () => {
    expect(() => loadConfig({ ...validEnv, NODE_ENV: 'production', DB_SSL_DISABLED: 'true' })).toThrow(ConfigError);
  });
});
