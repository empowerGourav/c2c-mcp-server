import { randomUUID } from 'node:crypto';
import {
  createMcpExpressApp,
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthMetadataRouter,
  requireBearerAuth,
} from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, type OAuthMetadata, type OAuthTokenVerifier } from '@modelcontextprotocol/server';
import type { Express, NextFunction, Request, Response } from 'express';
import type { C2cPrincipal, PrincipalResolver } from '../auth/principal.js';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { messages } from '../messages.js';
import { createC2cMcpServer, SERVER_NAME, type ServerDependencies } from '../server.js';

export interface HttpAppDependencies {
  config: Pick<AppConfig, 'http' | 'oauth'>;
  verifier: OAuthTokenVerifier;
  oauthMetadata: OAuthMetadata;
  principalResolver: PrincipalResolver;
  serverDependencies: ServerDependencies;
  /** Readiness probe: resolves when the reporting source is reachable. */
  checkReadiness: () => Promise<void>;
  logger: Logger;
}

export interface HttpApp {
  app: Express;
  close: () => Promise<void>;
}

/** Context attached to `req.auth.extra` after authentication and principal resolution. */
interface RequestScope {
  principal: C2cPrincipal;
  requestId: string;
}

const MCP_PATH = '/mcp';

/**
 * Build the Express application.
 *
 * Request flow for `/mcp` (plan §3.1): Host validation → bearer token verification (issuer, audience,
 * signature, expiry, scopes) → C2C principal resolution (fail closed) → stateless MCP handler that
 * builds a server bound to that principal.
 */
export function createHttpApp(deps: HttpAppDependencies): HttpApp {
  const { config, logger } = deps;
  const app = createMcpExpressApp({
    host: config.http.host,
    allowedHosts: config.http.allowedHosts.length > 0 ? config.http.allowedHosts : undefined,
    jsonLimit: config.http.maxRequestBody,
  });
  app.disable('x-powered-by');
  app.use(assignRequestId);

  app.get('/healthz', (_req, res) => {
    res.status(200).json({ data: { status: 'ok' } });
  });

  app.get('/readyz', async (_req, res) => {
    try {
      await deps.checkReadiness();
      res.status(200).json({ data: { status: 'ready' } });
    } catch (error) {
      logger.warn('readiness.failed', { errorName: error instanceof Error ? error.name : typeof error });
      res.status(503).json({ error: { code: 'NOT_READY', message: messages.errors.dataUnavailable } });
    }
  });

  app.use(
    mcpAuthMetadataRouter({
      oauthMetadata: deps.oauthMetadata,
      resourceServerUrl: config.http.publicUrl,
      scopesSupported: config.oauth.requiredScopes,
      resourceName: SERVER_NAME,
    }),
  );

  const mcpHandler = createMcpHandler(
    ({ authInfo }) => {
      const scope = readRequestScope(authInfo?.extra);
      // Defence in depth: the route middleware guarantees a scope, but never build an unscoped server.
      if (!scope) throw new Error('MCP request reached the handler without a resolved principal');
      return createC2cMcpServer(scope.principal, scope.requestId, deps.serverDependencies);
    },
    { onerror: (error) => logger.error('mcp.handler_error', { errorName: error.name }) },
  );
  const nodeHandler = toNodeHandler(mcpHandler, {
    onerror: (error) => logger.error('mcp.adapter_error', { errorName: error.name }),
  });

  app.all(
    MCP_PATH,
    requireBearerAuth({
      verifier: deps.verifier,
      requiredScopes: config.oauth.requiredScopes,
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(config.http.publicUrl),
    }),
    createPrincipalMiddleware(deps.principalResolver, logger),
    (req: Request, res: Response) => nodeHandler(req, res, req.body),
  );

  return { app, close: () => mcpHandler.close() };
}

function assignRequestId(_req: Request, res: Response, next: NextFunction): void {
  const requestId = randomUUID();
  res.locals['requestId'] = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
}

function createPrincipalMiddleware(resolver: PrincipalResolver, logger: Logger) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const requestId = String(res.locals['requestId']);
    const subject = req.auth?.extra?.['subject'];
    let principal: C2cPrincipal | null = null;
    try {
      principal = typeof subject === 'string' ? await resolver.resolve(subject) : null;
    } catch (error) {
      logger.error('auth.principal_resolution_failed', { requestId, errorName: error instanceof Error ? error.name : 'unknown' });
    }

    if (!principal || !req.auth) {
      logger.warn('auth.principal_denied', { requestId, decision: 'denied' });
      res.status(403).json({ error: { code: 'FORBIDDEN', message: messages.errors.principalNotMapped, requestId } });
      return;
    }

    const scope: RequestScope = { principal, requestId };
    req.auth = { ...req.auth, extra: { ...req.auth.extra, ...scope } };
    next();
  };
}

function readRequestScope(extra: Record<string, unknown> | undefined): RequestScope | null {
  const principal = extra?.['principal'];
  const requestId = extra?.['requestId'];
  if (typeof requestId !== 'string' || typeof principal !== 'object' || principal === null) return null;
  if (!('auditId' in principal) || !('campaignRefs' in principal) || !(principal.campaignRefs instanceof Set)) return null;
  return { principal: principal as C2cPrincipal, requestId };
}
