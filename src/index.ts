import { createRemoteJWKSet } from 'jose';
import { discoverIssuer } from './auth/oidc-discovery.js';
import { StaticPrincipalResolver } from './auth/principal.js';
import { JwtTokenVerifier } from './auth/token-verifier.js';
import { loadConfig } from './config.js';
import { MySqlQueryExecutor } from './data/database.js';
import { ReportingRepository } from './data/reporting-repository.js';
import { createHttpApp } from './http/app.js';
import { createLogger } from './logger.js';
import { RequestGuard } from './security/request-guard.js';
import { ReportingService } from './tools/reporting-service.js';

const SHUTDOWN_GRACE_MS = 10_000;

/** Compose dependencies, start the HTTP server, and install graceful shutdown. */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  const issuer = await discoverIssuer(config.oauth.issuer, config.oauth.discoveryTimeoutMs);
  const verifier = new JwtTokenVerifier({
    issuer: config.oauth.issuer,
    audience: config.oauth.audience,
    algorithms: config.oauth.allowedAlgorithms,
    subjectClaim: config.oauth.subjectClaim,
    getKey: createRemoteJWKSet(issuer.jwksUri),
    logger,
  });
  const principalResolver = await StaticPrincipalResolver.fromFile(
    config.principalMapPath,
    config.auditHashSalt,
    config.limits.maxCampaignRefsPerPrincipal,
  );

  const executor = new MySqlQueryExecutor(config.database, logger);
  const reportingService = new ReportingService({
    repository: new ReportingRepository(executor),
    limits: config.limits,
    reporting: config.reporting,
    callsPerMinute: config.rateLimit.perMinute,
  });

  const { app, close } = createHttpApp({
    config,
    verifier,
    oauthMetadata: issuer.oauthMetadata,
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
      approvedViews: config.reporting.approvedViews.size,
      nodeEnv: config.nodeEnv,
    });
  });

  const shutdown = (signal: string): void => {
    logger.info('server.stopping', { signal });
    const forceExit = setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS);
    forceExit.unref();
    httpServer.close(() => {
      Promise.allSettled([close(), executor.close()]).finally(() => process.exit(0));
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  // Configuration/discovery failures happen before the logger is guaranteed; print name and message only.
  const description = error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown startup error';
  process.stderr.write(`${JSON.stringify({ level: 'error', event: 'server.start_failed', description })}\n`);
  process.exit(1);
});
