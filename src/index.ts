import { createRemoteJWKSet } from 'jose';
import { DbPrincipalResolver } from './auth/db-principal-resolver.js';
import { discoverIssuer } from './auth/oidc-discovery.js';
import { JwtTokenVerifier } from './auth/token-verifier.js';
import { loadConfig, type AppConfig } from './config.js';
import type { OAuthMetadata, OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { StaticTokenVerifier } from './auth/static-token-verifier.js';
import { MySqlQueryExecutor } from './data/database.js';
import { ReportingRepository } from './data/reporting-repository.js';
import { ScopeRepository } from './data/scope-repository.js';
import { createHttpApp } from './http/app.js';
import { createLogger, type Logger } from './logger.js';
import { RequestGuard } from './security/request-guard.js';
import { ReportingService } from './tools/reporting-service.js';

const SHUTDOWN_GRACE_MS = 10_000;

/** Compose dependencies, start the HTTP server, and install graceful shutdown. */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  const { verifier, oauthMetadata } = await createVerifier(config.auth, logger);

  const executor = new MySqlQueryExecutor(config.database, logger);
  const principalResolver = new DbPrincipalResolver({
    executor,
    auditHashSalt: config.identity.auditHashSalt,
    allowSuperAdmin: config.identity.allowSuperAdmin,
    cacheTtlMs: config.identity.cacheTtlMs,
    logger,
  });
  const reportingService = new ReportingService({
    reporting: new ReportingRepository(executor, config.database.maxParallelProcedures),
    scopes: new ScopeRepository(executor),
    limits: config.limits,
    defaultTimezone: config.reporting.defaultTimezone,
    callsPerMinute: config.rateLimit.perMinute,
  });

  const { app, close } = createHttpApp({
    config,
    verifier,
    requiredScopes: config.auth.requiredScopes,
    oauthMetadata,
    principalResolver,
    checkReadiness: () => executor.ping(),
    logger,
    serverDependencies: {
      reportingService,
      guard: new RequestGuard(config.rateLimit),
      logger,
      maxResponseBytes: config.limits.maxResponseBytes,
    },
  });

  const httpServer = app.listen(config.http.port, config.http.host, () => {
    logger.info('server.started', {
      port: config.http.port,
      nodeEnv: config.nodeEnv,
      authMode: config.auth.mode,
      superAdminEnabled: config.identity.allowSuperAdmin,
    });
  });

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info('server.stopping', { signal });
    // Exit by draining the event loop rather than process.exit(): exiting while sockets are still closing
    // trips a libuv assertion on Windows (UV_HANDLE_CLOSING). The timer is only a backstop for a hung close.
    const forceExit = setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS);
    forceExit.unref();
    httpServer.closeAllConnections();
    httpServer.close(() => {
      Promise.allSettled([close(), executor.close()]).finally(() => {
        clearTimeout(forceExit);
        process.exitCode = 0;
      });
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

/** Build the token verifier for the configured auth mode. */
async function createVerifier(
  auth: AppConfig['auth'],
  logger: Logger,
): Promise<{ verifier: OAuthTokenVerifier; oauthMetadata?: OAuthMetadata }> {
  if (auth.mode === 'static') {
    const verifier = await StaticTokenVerifier.fromFile(auth.credentialsPath, auth.requiredScopes, logger);
    logger.warn('auth.static_mode', { credentials: verifier.credentialCount });
    return { verifier };
  }
  const issuer = await discoverIssuer(auth.issuer, auth.discoveryTimeoutMs);
  const verifier = new JwtTokenVerifier({
    issuer: auth.issuer,
    audience: auth.audience,
    algorithms: auth.allowedAlgorithms,
    identityClaim: auth.identityClaim,
    getKey: createRemoteJWKSet(issuer.jwksUri),
    logger,
  });
  return { verifier, oauthMetadata: issuer.oauthMetadata };
}

main().catch((error: unknown) => {
  // Configuration/discovery failures happen before the logger is guaranteed; print name and message only.
  const description = error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown startup error';
  process.stderr.write(`${JSON.stringify({ level: 'error', event: 'server.start_failed', description })}\n`);
  // Let pending handles (e.g. the discovery fetch socket) close; process.exit() here can crash libuv on Windows.
  process.exitCode = 1;
});
