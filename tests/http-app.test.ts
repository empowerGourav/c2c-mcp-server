import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrincipalResolver } from '../src/auth/principal.js';
import { JwtTokenVerifier } from '../src/auth/token-verifier.js';
import { ReportingRepository } from '../src/data/reporting-repository.js';
import { ScopeRepository } from '../src/data/scope-repository.js';
import { createHttpApp } from '../src/http/app.js';
import { RequestGuard } from '../src/security/request-guard.js';
import { ReportingService } from '../src/tools/reporting-service.js';
import {
  captureLogger,
  createTestIssuer,
  FakeExecutor,
  makePrincipal,
  MARKETPLACE,
  ownershipResponder,
  TEST_AUDIENCE,
  TEST_ISSUER,
  TEST_LIMITS,
} from './helpers.js';

const REQUIRED_SCOPE = 'c2c.reporting.read';
const MAPPED_EMAIL = 'pat@example.com';

let httpServer: Server;
let baseUrl: string;
let closeApp: () => Promise<void>;
let sign: Awaited<ReturnType<typeof createTestIssuer>>['sign'];

const executor = new FakeExecutor(
  ownershipResponder([['advertisers', 200, 100]], (sql) => {
    if (sql === 'CALL getCustomerDashboardTotalCallsReplica') return [{ total_calls: 42 }];
    if (sql === 'CALL getCustomerDashboardBillableCallsReplica') return [{ billable_calls: 7 }];
    return [{}];
  }),
);

const principalResolver: PrincipalResolver = {
  resolve: async (identity) => (identity === MAPPED_EMAIL ? makePrincipal([MARKETPLACE]) : null),
};

beforeAll(async () => {
  const issuer = await createTestIssuer();
  sign = issuer.sign;
  const { logger } = captureLogger();

  const { app, close } = createHttpApp({
    config: {
      http: {
        host: '127.0.0.1',
        port: 0,
        allowedHosts: ['127.0.0.1', 'localhost'],
        publicUrl: new URL('https://c2c-mcp.example.test/mcp'),
        maxRequestBody: '64kb',
      },
      oauth: {
        issuer: TEST_ISSUER,
        audience: TEST_AUDIENCE,
        requiredScopes: [REQUIRED_SCOPE],
        identityClaim: 'email',
        allowedAlgorithms: ['RS256'],
        discoveryTimeoutMs: 1000,
      },
    },
    verifier: new JwtTokenVerifier({
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
      algorithms: ['RS256'],
      identityClaim: 'email',
      getKey: issuer.getKey,
      logger,
    }),
    oauthMetadata: {
      issuer: TEST_ISSUER,
      authorization_endpoint: `${TEST_ISSUER}/authorize`,
      token_endpoint: `${TEST_ISSUER}/token`,
      response_types_supported: ['code'],
    },
    principalResolver,
    checkReadiness: async () => {},
    logger,
    serverDependencies: {
      reportingService: new ReportingService({
        reporting: new ReportingRepository(executor, 3),
        scopes: new ScopeRepository(executor),
        limits: TEST_LIMITS,
        defaultTimezone: 'America/Chicago',
        callsPerMinute: 30,
        today: () => new Date('2026-11-11T12:00:00Z'),
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

const initializeBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
});

function postMcp(headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: initializeBody,
  });
}

async function connectClient(token: string): Promise<Client> {
  const client = new Client({ name: 'c2c-test-client', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
  );
  return client;
}

const mappedToken = () => sign({ email: MAPPED_EMAIL, scp: REQUIRED_SCOPE });

describe('HTTP surface', () => {
  it('serves liveness and readiness probes without auth', async () => {
    expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/readyz`)).status).toBe(200);
  });

  it('publishes protected-resource metadata pointing at the issuer', async () => {
    const response = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ authorization_servers: [TEST_ISSUER] });
  });

  it('challenges unauthenticated MCP requests with 401 and resource metadata', async () => {
    const response = await postMcp();
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('resource_metadata=');
  });

  it('rejects a valid token that lacks the required scope', async () => {
    const token = await sign({ email: MAPPED_EMAIL, scp: 'something.else' });
    expect((await postMcp({ authorization: `Bearer ${token}` })).status).toBe(403);
  });

  it('rejects an authenticated user with no C2C account', async () => {
    const token = await sign({ email: 'stranger@example.com', scp: REQUIRED_SCOPE });
    const response = await postMcp({ authorization: `Bearer ${token}` });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
  });
});

describe('MCP tools over Streamable HTTP', () => {
  it('lists exactly the six read-only tools', async () => {
    const client = await connectClient(await mappedToken());
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'get_daily_call_trend',
      'get_dashboard_kpis',
      'get_financial_summary',
      'get_metric_definitions',
      'list_dimensions',
      'list_my_accounts',
    ]);
    expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    await client.close();
  });

  it('returns dashboard KPIs from the scoped procedures', async () => {
    const client = await connectClient(await mappedToken());
    const result = await client.callTool({ name: 'get_dashboard_kpis', arguments: { advertiserId: 200 } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ metrics: { totalCalls: 42, billableCalls: 7 } });
    await client.close();
  });

  it('refuses filters outside the caller scope', async () => {
    const client = await connectClient(await mappedToken());
    const result = await client.callTool({ name: 'get_dashboard_kpis', arguments: { advertiserId: 999 } });
    expect(result.isError).toBe(true);
    await client.close();
  });

  it('rejects unknown arguments instead of passing them through', async () => {
    const client = await connectClient(await mappedToken());
    const callsBefore = executor.calls.length;
    const rejected = await client
      .callTool({ name: 'get_dashboard_kpis', arguments: { sql: 'SELECT * FROM users' } })
      .then((result) => result.isError === true)
      .catch(() => true);
    expect(rejected).toBe(true);
    expect(executor.calls.length).toBe(callsBefore);
    await client.close();
  });
});
