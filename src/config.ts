import { readFileSync } from 'node:fs';
import { z } from 'zod';

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

const ianaTimezone = z.string().refine(isIanaTimezone, { message: 'must be an IANA timezone, e.g. America/Chicago' });

/**
 * Environment contract. Limits default to the conservative values in project-plan.md §5.2.
 * Secrets are never defaulted.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  HOST: z.string().default('0.0.0.0'),
  PORT: positiveInt(8080),
  ALLOWED_HOSTS: commaList,
  MCP_PUBLIC_URL: z.url(),
  MCP_MAX_REQUEST_BODY: z.string().default('64kb'),

  /** `oauth` (OIDC JWTs) or `static` (fixed bearer tokens from STATIC_CREDENTIALS_PATH, interim/local use). */
  AUTH_MODE: z.enum(['oauth', 'static']).default('oauth'),
  STATIC_CREDENTIALS_PATH: z.string().min(1).optional(),
  OAUTH_ISSUER: z.url().optional(),
  OAUTH_AUDIENCE: z.string().min(1).optional(),
  OAUTH_REQUIRED_SCOPES: commaList,
  /** Token claim holding the user's e-mail, matched to `users.email` (Entra ID: `email` or `preferred_username`). */
  OAUTH_IDENTITY_CLAIM: z.string().min(1).default('email'),
  OAUTH_ALLOWED_ALGORITHMS: commaList,
  OAUTH_DISCOVERY_TIMEOUT_MS: positiveInt(5000),

  // Aurora MySQL *reader* endpoint (the Laravel `replicaDB` connection / REPLICATE_DB_HOST).
  DB_HOST: z.string().min(1),
  DB_PORT: positiveInt(3306),
  DB_NAME: z.string().min(1),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().min(1),
  DB_SSL_CA_PATH: z.string().optional(),
  DB_SSL_DISABLED: booleanFlag,
  DB_CONNECTION_LIMIT: positiveInt(5),
  DB_STATEMENT_TIMEOUT_MS: positiveInt(5000),
  MAX_PARALLEL_PROCEDURES: positiveInt(3),

  DEFAULT_TIMEZONE: ianaTimezone.default('America/Chicago'),
  ALLOW_SUPER_ADMIN: booleanFlag,
  PRINCIPAL_CACHE_TTL_MS: positiveInt(60_000),
  AUDIT_HASH_SALT: z.string().min(16),

  QUERY_DEFAULT_WINDOW_DAYS: positiveInt(30),
  QUERY_MAX_LOOKBACK_DAYS: positiveInt(90),
  RESPONSE_MAX_ROWS: positiveInt(500),
  RESPONSE_MAX_BYTES: positiveInt(131072),
  RATE_LIMIT_PER_MINUTE: positiveInt(30),
  MAX_CONCURRENT_QUERIES: positiveInt(10),
  MAX_CONCURRENT_QUERIES_PER_USER: positiveInt(2),
});

export interface QueryLimits {
  defaultWindowDays: number;
  maxLookbackDays: number;
  maxRows: number;
  maxResponseBytes: number;
}

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  http: { host: string; port: number; allowedHosts: string[]; publicUrl: URL; maxRequestBody: string };
  auth: OAuthSettings | StaticAuthSettings;
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
    maxParallelProcedures: number;
  };
  reporting: { defaultTimezone: string };
  identity: { allowSuperAdmin: boolean; cacheTtlMs: number; auditHashSalt: string };
  limits: QueryLimits;
  rateLimit: { perMinute: number; maxConcurrent: number; maxConcurrentPerUser: number };
}

export interface OAuthSettings {
  mode: 'oauth';
  issuer: string;
  audience: string;
  requiredScopes: string[];
  identityClaim: string;
  allowedAlgorithms: string[];
  discoveryTimeoutMs: number;
}

export interface StaticAuthSettings {
  mode: 'static';
  credentialsPath: string;
  requiredScopes: string[];
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/** @returns true when `value` is a timezone name the runtime (and MySQL tz tables) can use. */
export function isIanaTimezone(value: string): boolean {
  // Shape check first (it is also bound into SQL as CONVERT_TZ's argument), then let ICU confirm the zone,
  // which also accepts valid aliases such as Asia/Kolkata.
  if (!/^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse and validate configuration from environment variables.
 *
 * @param env - Source environment (defaults to `process.env`).
 * @returns A fully validated configuration object.
 * @throws {ConfigError} When a variable is missing or invalid.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new ConfigError(`Invalid configuration: ${problems.join('; ')}`);
  }
  const e = parsed.data;

  if (e.QUERY_DEFAULT_WINDOW_DAYS > e.QUERY_MAX_LOOKBACK_DAYS) {
    throw new ConfigError('QUERY_DEFAULT_WINDOW_DAYS must not exceed QUERY_MAX_LOOKBACK_DAYS');
  }
  if (e.NODE_ENV === 'production' && e.DB_SSL_DISABLED) {
    throw new ConfigError('DB_SSL_DISABLED=true is not permitted in production');
  }
  let auth: AppConfig['auth'];
  if (e.AUTH_MODE === 'static') {
    if (!e.STATIC_CREDENTIALS_PATH) throw new ConfigError('STATIC_CREDENTIALS_PATH is required when AUTH_MODE=static');
    auth = { mode: 'static', credentialsPath: e.STATIC_CREDENTIALS_PATH, requiredScopes: [] };
  } else {
    if (!e.OAUTH_ISSUER || !e.OAUTH_AUDIENCE) throw new ConfigError('OAUTH_ISSUER and OAUTH_AUDIENCE are required when AUTH_MODE=oauth');
    auth = {
      mode: 'oauth',
      issuer: e.OAUTH_ISSUER,
      audience: e.OAUTH_AUDIENCE,
      requiredScopes: e.OAUTH_REQUIRED_SCOPES,
      identityClaim: e.OAUTH_IDENTITY_CLAIM,
      allowedAlgorithms: e.OAUTH_ALLOWED_ALGORITHMS.length > 0 ? e.OAUTH_ALLOWED_ALGORITHMS : ['RS256'],
      discoveryTimeoutMs: e.OAUTH_DISCOVERY_TIMEOUT_MS,
    };
  }
  if (e.MAX_PARALLEL_PROCEDURES > e.DB_CONNECTION_LIMIT) {
    throw new ConfigError('MAX_PARALLEL_PROCEDURES must not exceed DB_CONNECTION_LIMIT');
  }

  return {
    nodeEnv: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    http: {
      host: e.HOST,
      port: e.PORT,
      allowedHosts: e.ALLOWED_HOSTS,
      publicUrl: new URL(e.MCP_PUBLIC_URL),
      maxRequestBody: e.MCP_MAX_REQUEST_BODY,
    },
    auth,
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
      maxParallelProcedures: e.MAX_PARALLEL_PROCEDURES,
    },
    reporting: { defaultTimezone: e.DEFAULT_TIMEZONE },
    identity: { allowSuperAdmin: e.ALLOW_SUPER_ADMIN, cacheTtlMs: e.PRINCIPAL_CACHE_TTL_MS, auditHashSalt: e.AUDIT_HASH_SALT },
    limits: {
      defaultWindowDays: e.QUERY_DEFAULT_WINDOW_DAYS,
      maxLookbackDays: e.QUERY_MAX_LOOKBACK_DAYS,
      maxRows: e.RESPONSE_MAX_ROWS,
      maxResponseBytes: e.RESPONSE_MAX_BYTES,
    },
    rateLimit: {
      perMinute: e.RATE_LIMIT_PER_MINUTE,
      maxConcurrent: e.MAX_CONCURRENT_QUERIES,
      maxConcurrentPerUser: e.MAX_CONCURRENT_QUERIES_PER_USER,
    },
  };
}
