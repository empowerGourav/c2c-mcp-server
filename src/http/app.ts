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
  config: Pick<AppConfig, 'http'>;
  verifier: OAuthTokenVerifier;
  /** Scopes every token must carry (empty in static-credential mode). */
  requiredScopes: string[];
  /** Authorization Server metadata to publish. Omitted in static-credential mode (no OAuth discovery). */
  oauthMetadata?: OAuthMetadata;
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

  if (deps.oauthMetadata) {
    app.use(
      mcpAuthMetadataRouter({
        oauthMetadata: deps.oauthMetadata,
        resourceServerUrl: config.http.publicUrl,
        scopesSupported: deps.requiredScopes,
        resourceName: SERVER_NAME,
      }),
    );
  } else {
    // Static-credential mode: MCP clients that get a 401 fall back to OAuth discovery and dynamic client
    // registration. Answer those probes with an explanation instead of a bare 404.
    const explainStaticAuth = (_req: Request, res: Response) => {
      res.status(404).json({ error: 'oauth_not_supported', error_description: messages.errors.staticAuthOnly });
    };
    app.all(/^\/\.well-known\/oauth-(protected-resource|authorization-server)(\/.*)?$/, explainStaticAuth);
    app.all(['/register', '/authorize', '/token'], explainStaticAuth);
  }

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
      requiredScopes: deps.requiredScopes,
      resourceMetadataUrl: deps.oauthMetadata ? getOAuthProtectedResourceMetadataUrl(config.http.publicUrl) : undefined,
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
    const identity = req.auth?.extra?.['identity'];
    let principal: C2cPrincipal | null = null;
    try {
      principal = typeof identity === 'string' ? await resolver.resolve(identity) : null;
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
  if (!('auditId' in principal) || !('accounts' in principal) || !Array.isArray(principal.accounts)) return null;
  return { principal: principal as C2cPrincipal, requestId };
}
