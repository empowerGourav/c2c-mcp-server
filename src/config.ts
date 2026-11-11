import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { KNOWN_VIEW_NAMES } from './data/allowlist.js';

const commaList = z
  .string()
  .optional()
  .transform((value) =>
    (value ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );

const positiveInt = (defaultValue: number) => z.coerce.number().int().positive().default(defaultValue);

const booleanFlag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

/**
 * Environment contract. Every tunable from project-plan.md §5.2 is configurable here, with
 * the plan's conservative values as defaults. Secrets are never defaulted.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  HOST: z.string().default('0.0.0.0'),
  PORT: positiveInt(8080),
  ALLOWED_HOSTS: commaList,
  MCP_PUBLIC_URL: z.url(),
  MCP_MAX_REQUEST_BODY: z.string().default('64kb'),

  OAUTH_ISSUER: z.url(),
  OAUTH_AUDIENCE: z.string().min(1),
  OAUTH_REQUIRED_SCOPES: commaList,
  OAUTH_SUBJECT_CLAIM: z.string().min(1).default('sub'),
  OAUTH_ALLOWED_ALGORITHMS: commaList,
  OAUTH_DISCOVERY_TIMEOUT_MS: positiveInt(5000),

  DB_HOST: z.string().min(1),
  DB_PORT: positiveInt(3306),
  DB_NAME: z.string().min(1),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().min(1),
  DB_SSL_CA_PATH: z.string().optional(),
  DB_SSL_DISABLED: booleanFlag,
  DB_CONNECTION_LIMIT: positiveInt(5),
  DB_STATEMENT_TIMEOUT_MS: positiveInt(5000),

  C2C_APPROVED_VIEWS: commaList,
  C2C_OUTCOME_CODES: commaList,
  C2C_DATA_FRESHNESS_NOTE: z.string().default('Freshness has not been confirmed by the C2C data owner.'),
  PRINCIPAL_MAP_PATH: z.string().min(1),
  AUDIT_HASH_SALT: z.string().min(16),

  QUERY_DEFAULT_WINDOW_DAYS: positiveInt(30),
  QUERY_MAX_LOOKBACK_DAYS: positiveInt(90),
  RESPONSE_MAX_ROWS: positiveInt(500),
  RESPONSE_MAX_BYTES: positiveInt(131072),
  MIN_AGGREGATE_GROUP_SIZE: positiveInt(10),
  MAX_CAMPAIGN_REFS_PER_PRINCIPAL: positiveInt(1000),
  RATE_LIMIT_PER_MINUTE: positiveInt(30),
  MAX_CONCURRENT_QUERIES: positiveInt(10),
  MAX_CONCURRENT_QUERIES_PER_USER: positiveInt(2),
});

export interface QueryLimits {
  defaultWindowDays: number;
  maxLookbackDays: number;
  maxRows: number;
  maxResponseBytes: number;
  minAggregateGroupSize: number;
  maxCampaignRefsPerPrincipal: number;
}

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  http: { host: string; port: number; allowedHosts: string[]; publicUrl: URL; maxRequestBody: string };
  oauth: {
    issuer: string;
    audience: string;
    requiredScopes: string[];
    subjectClaim: string;
    allowedAlgorithms: string[];
    discoveryTimeoutMs: number;
  };
  database: {
    host: string;
    port: number;
    name: string;
    user: string;
    password: string;
    sslCa: string | undefined;
    sslDisabled: boolean;
    connectionLimit: number;
    statementTimeoutMs: number;
  };
  reporting: {
    approvedViews: ReadonlySet<string>;
    outcomeCodes: readonly string[];
    freshnessNote: string;
  };
  principalMapPath: string;
  auditHashSalt: string;
  limits: QueryLimits;
  rateLimit: { perMinute: number; maxConcurrent: number; maxConcurrentPerUser: number };
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/**
 * Parse and validate configuration from environment variables.
 *
 * @param env - Source environment (defaults to `process.env`).
 * @returns A fully validated, immutable configuration object.
 * @throws {ConfigError} When a variable is missing or invalid, or the view allowlist names an unknown view.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new ConfigError(`Invalid configuration: ${problems.join('; ')}`);
  }
  const e = parsed.data;

  const unknownViews = e.C2C_APPROVED_VIEWS.filter((view) => !KNOWN_VIEW_NAMES.has(view));
  if (unknownViews.length > 0) {
    throw new ConfigError(`C2C_APPROVED_VIEWS contains views without a reviewed contract: ${unknownViews.join(', ')}`);
  }
  if (e.QUERY_DEFAULT_WINDOW_DAYS > e.QUERY_MAX_LOOKBACK_DAYS) {
    throw new ConfigError('QUERY_DEFAULT_WINDOW_DAYS must not exceed QUERY_MAX_LOOKBACK_DAYS');
  }
  if (e.NODE_ENV === 'production' && e.DB_SSL_DISABLED) {
    throw new ConfigError('DB_SSL_DISABLED=true is not permitted in production');
  }

  return Object.freeze({
    nodeEnv: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    http: {
      host: e.HOST,
      port: e.PORT,
      allowedHosts: e.ALLOWED_HOSTS,
      publicUrl: new URL(e.MCP_PUBLIC_URL),
      maxRequestBody: e.MCP_MAX_REQUEST_BODY,
    },
    oauth: {
      issuer: e.OAUTH_ISSUER,
      audience: e.OAUTH_AUDIENCE,
      requiredScopes: e.OAUTH_REQUIRED_SCOPES,
      subjectClaim: e.OAUTH_SUBJECT_CLAIM,
      allowedAlgorithms: e.OAUTH_ALLOWED_ALGORITHMS.length > 0 ? e.OAUTH_ALLOWED_ALGORITHMS : ['RS256'],
      discoveryTimeoutMs: e.OAUTH_DISCOVERY_TIMEOUT_MS,
    },
    database: {
      host: e.DB_HOST,
      port: e.DB_PORT,
      name: e.DB_NAME,
      user: e.DB_USER,
      password: e.DB_PASSWORD,
      sslCa: e.DB_SSL_CA_PATH ? readFileSync(e.DB_SSL_CA_PATH, 'utf8') : undefined,
      sslDisabled: e.DB_SSL_DISABLED,
      connectionLimit: e.DB_CONNECTION_LIMIT,
      statementTimeoutMs: e.DB_STATEMENT_TIMEOUT_MS,
    },
    reporting: {
      approvedViews: new Set(e.C2C_APPROVED_VIEWS),
      outcomeCodes: Object.freeze([...e.C2C_OUTCOME_CODES]),
      freshnessNote: e.C2C_DATA_FRESHNESS_NOTE,
    },
    principalMapPath: e.PRINCIPAL_MAP_PATH,
    auditHashSalt: e.AUDIT_HASH_SALT,
    limits: {
      defaultWindowDays: e.QUERY_DEFAULT_WINDOW_DAYS,
      maxLookbackDays: e.QUERY_MAX_LOOKBACK_DAYS,
      maxRows: e.RESPONSE_MAX_ROWS,
      maxResponseBytes: e.RESPONSE_MAX_BYTES,
      minAggregateGroupSize: e.MIN_AGGREGATE_GROUP_SIZE,
      maxCampaignRefsPerPrincipal: e.MAX_CAMPAIGN_REFS_PER_PRINCIPAL,
    },
    rateLimit: {
      perMinute: e.RATE_LIMIT_PER_MINUTE,
      maxConcurrent: e.MAX_CONCURRENT_QUERIES,
      maxConcurrentPerUser: e.MAX_CONCURRENT_QUERIES_PER_USER,
    },
  });
}
