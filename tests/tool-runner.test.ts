import { describe, expect, it } from 'vitest';
import { ToolError } from '../src/errors.js';
import { messages } from '../src/messages.js';
import { RequestGuard } from '../src/security/request-guard.js';
import { runTool, type ToolRunContext } from '../src/tools/tool-runner.js';
import { captureLogger, makePrincipal } from './helpers.js';

function buildContext(overrides: Partial<ToolRunContext> = {}) {
  const { logger, entries } = captureLogger();
  const context: ToolRunContext = {
    toolName: 'test_tool',
    principal: makePrincipal(),
    requestId: 'req-1',
    guard: new RequestGuard({ perMinute: 100, maxConcurrent: 10, maxConcurrentPerUser: 10 }),
    logger,
    maxResponseBytes: 1024,
    ...overrides,
  };
  return { context, entries };
}

function textOf(result: { content: unknown[] }): string {
  const first = result.content[0] as { type: string; text: string };
  return first.text;
}

describe('runTool', () => {
  it('returns structured content and logs metadata only', async () => {
    const { context, entries } = buildContext();
    const result = await runTool(context, async () => ({ rows: [{ campaignRef: 'CMP-SECRET', callCount: 99 }], truncated: false }));

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ rows: [{ campaignRef: 'CMP-SECRET', callCount: 99 }], truncated: false });
    expect(entries[0]).toMatchObject({ event: 'tool.call', fields: { outcome: 'ok', rowCount: 1, principal: 'audit-1234' } });
    expect(JSON.stringify(entries)).not.toContain('CMP-SECRET');
  });

  it('refuses responses over the byte limit', async () => {
    const { context } = buildContext({ maxResponseBytes: 50 });
    const result = await runTool(context, async () => ({ rows: Array.from({ length: 20 }, (_, index) => ({ index })) }));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(messages.errors.responseTooLarge);
  });

  it('maps database driver errors to a generic message without leaking details', async () => {
    const { context, entries } = buildContext();
    const driverError = Object.assign(new Error("Table 'c2c.secret_table' doesn't exist"), { code: 'ER_NO_SUCH_TABLE' });
    const result = await runTool(context, async () => {
      throw driverError;
    });

    expect(textOf(result)).toBe(messages.errors.dataUnavailable);
    expect(JSON.stringify(result)).not.toContain('secret_table');
    expect(entries[0]).toMatchObject({ level: 'error', fields: { outcome: 'DATA_UNAVAILABLE', errorCode: 'ER_NO_SUCH_TABLE' } });
    expect(JSON.stringify(entries)).not.toContain('secret_table');
  });

  it('records authorization denials as denied', async () => {
    const { context, entries } = buildContext();
    const result = await runTool(context, async () => {
      throw new ToolError('NOT_AUTHORIZED', messages.errors.notAuthorized);
    });
    expect(textOf(result)).toBe(messages.errors.notAuthorized);
    expect(entries[0]).toMatchObject({ level: 'warn', fields: { decision: 'denied', outcome: 'NOT_AUTHORIZED' } });
  });

  it('hides unexpected errors behind a generic message', async () => {
    const { context } = buildContext();
    const result = await runTool(context, async () => {
      throw new TypeError('internal stack detail');
    });
    expect(textOf(result)).toBe(messages.errors.internal);
  });
});
