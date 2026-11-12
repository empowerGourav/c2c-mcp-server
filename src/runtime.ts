import { createRemoteJWKSet } from 'jose';
import type { OAuthMetadata, OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { StaticTokenVerifier } from './auth/static-token-verifier.js';
import { DbPrincipalResolver } from './auth/db-principal-resolver.js';
import { discoverIssuer } from './auth/oidc-discovery.js';
import { JwtTokenVerifier } from './auth/token-verifier.js';
import { loadConfig, type AppConfig } from './config.js';
import { MySqlQueryExecutor } from './data/database.js';
import { ReportingRepository } from './data/reporting-repository.js';
import { ScopeRepository } from './data/scope-repository.js';
import { createHttpApp } from './http/app.js';
import { createLogger, type Logger } from './logger.js';
import { RequestGuard } from './security/request-guard.js';
import { ReportingService } from './tools/reporting-service.js';
import type { Express } from 'express';

export interface ServerRuntime {
  app: Express;
  config: AppConfig;
  logger: Logger;
  close: () => Promise<void>;
}

/** Initialize shared dependencies and compose the HTTP application. */
export async function createRuntime(): Promise<ServerRuntime> {
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

  const httpApp = createHttpApp({
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

  return {
    app: httpApp.app,
    config,
    logger,
    close: async () => {
      await Promise.allSettled([httpApp.close(), executor.close()]);
    },
  };
}

/** Build the token verifier for the configured auth mode. */
async function createVerifier(
  auth: AppConfig['auth'],
  logger: Logger,
): Promise<{ verifier: OAuthTokenVerifier; oauthMetadata?: OAuthMetadata }> {
  if (auth.mode === 'static') {
    const verifier =
      auth.credentialsSource === 'environment'
        ? StaticTokenVerifier.fromJson(auth.credentialsJson, auth.requiredScopes, logger)
        : await StaticTokenVerifier.fromFile(auth.credentialsPath, auth.requiredScopes, logger);
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
