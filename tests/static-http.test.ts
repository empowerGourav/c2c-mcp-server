import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StaticTokenVerifier } from '../src/auth/static-token-verifier.js';
import { ReportingRepository } from '../src/data/reporting-repository.js';
import { ScopeRepository } from '../src/data/scope-repository.js';
import { createHttpApp } from '../src/http/app.js';
import { RequestGuard } from '../src/security/request-guard.js';
import { ReportingService } from '../src/tools/reporting-service.js';
import { captureLogger, FakeExecutor, makePrincipal, MARKETPLACE, TEST_LIMITS } from './helpers.js';

const TOKEN = 'c2c_' + 'z'.repeat(40);
let httpServer: Server;
let baseUrl: string;
let closeApp: () => Promise<void>;

beforeAll(async () => {
  const { logger } = captureLogger();
  const executor = new FakeExecutor();
  const { app, close } = createHttpApp({
    config: {
      http: {
        host: '127.0.0.1',
        port: 0,
        allowedHosts: ['127.0.0.1', 'localhost'],
        publicUrl: new URL('http://localhost:8080/mcp'),
        maxRequestBody: '64kb',
      },
    },
    verifier: new StaticTokenVerifier({ credentials: [{ email: 'pat@example.com', token: TOKEN }] }, [], logger),
    requiredScopes: [],
    principalResolver: { resolve: async (identity) => (identity === 'pat@example.com' ? makePrincipal([MARKETPLACE]) : null) },
    checkReadiness: async () => {},
    logger,
    serverDependencies: {
      reportingService: new ReportingService({
        reporting: new ReportingRepository(executor, 1),
        scopes: new ScopeRepository(executor),
        limits: TEST_LIMITS,
        defaultTimezone: 'America/Chicago',
        callsPerMinute: 30,
      }),
      guard: new RequestGuard({ perMinute: 100, maxConcurrent: 10, maxConcurrentPerUser: 10 }),
      logger,
      maxResponseBytes: TEST_LIMITS.maxResponseBytes,
    },
  });
  closeApp = close;
  httpServer = await new Promise<Server>((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await closeApp();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

const initialize = (headers: Record<string, string>) =>
  fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
    }),
  });

describe('static-credential mode over HTTP', () => {
  it.each(['/register', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server'])(
    'explains that OAuth is not supported at %s',
    async (path) => {
      const response = await fetch(`${baseUrl}${path}`, { method: path === '/register' ? 'POST' : 'GET' });
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: 'oauth_not_supported' });
    },
  );

  it('rejects a misspelled Authorization header with 401', async () => {
    expect((await initialize({ authoriztion: `Bearer ${TOKEN}` })).status).toBe(401);
  });

  it('accepts the correct header', async () => {
    const response = await initialize({ authorization: `Bearer ${TOKEN}` });
    expect(response.status).toBe(200);
  });
});
