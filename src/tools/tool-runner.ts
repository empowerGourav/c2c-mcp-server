import type { CallToolResult } from '@modelcontextprotocol/server';
import type { C2cPrincipal } from '../auth/principal.js';
import { ToolError } from '../errors.js';
import type { Logger } from '../logger.js';
import { messages } from '../messages.js';
import type { RequestGuard } from '../security/request-guard.js';

export interface ToolRunContext {
  toolName: string;
  principal: C2cPrincipal;
  requestId: string;
  guard: RequestGuard;
  logger: Logger;
  maxResponseBytes: number;
}

interface CountableOutput {
  rows?: unknown[];
  truncated?: boolean;
}

/**
 * Execute one tool call with the cross-cutting controls every tool shares:
 * rate/concurrency limits, response-size cap, safe error mapping, and a metadata-only audit event.
 *
 * Errors are returned as `isError` tool results (not protocol errors) so the model can explain them.
 * Internal error details are logged by name/code only and never returned.
 */
export async function runTool<Output extends Record<string, unknown> & CountableOutput>(
  context: ToolRunContext,
  work: () => Promise<Output> | Output,
): Promise<CallToolResult> {
  const startedAt = performance.now();
  const audit = {
    requestId: context.requestId,
    principal: context.principal.auditId,
    tool: context.toolName,
  };

  try {
    const output = await context.guard.run(context.principal.auditId, async () => work());
    const text = JSON.stringify(output);
    if (Buffer.byteLength(text, 'utf8') > context.maxResponseBytes) {
      throw new ToolError('RESPONSE_TOO_LARGE', messages.errors.responseTooLarge);
    }
    context.logger.info('tool.call', {
      ...audit,
      decision: 'allowed',
      outcome: 'ok',
      rowCount: output.rows?.length ?? 0,
      truncated: output.truncated ?? false,
      durationMs: elapsed(startedAt),
    });
    return { content: [{ type: 'text', text }], structuredContent: output };
  } catch (error) {
    const { code, safeMessage } = classify(error);
    const level = code === 'INTERNAL' || code === 'DATA_UNAVAILABLE' ? 'error' : 'warn';
    context.logger[level]('tool.call', {
      ...audit,
      decision: code === 'NOT_AUTHORIZED' || code === 'VIEW_NOT_APPROVED' ? 'denied' : 'allowed',
      outcome: code,
      errorName: error instanceof Error ? error.name : typeof error,
      errorCode: readDriverCode(error),
      durationMs: elapsed(startedAt),
    });
    return { isError: true, content: [{ type: 'text', text: safeMessage }] };
  }
}

function classify(error: unknown): { code: string; safeMessage: string } {
  if (error instanceof ToolError) return { code: error.code, safeMessage: error.safeMessage };
  if (readDriverCode(error) !== undefined || (error instanceof Error && error.name === 'RowShapeError')) {
    return { code: 'DATA_UNAVAILABLE', safeMessage: messages.errors.dataUnavailable };
  }
  return { code: 'INTERNAL', safeMessage: messages.errors.internal };
}

/** mysql2 errors carry a symbolic `code` (e.g. ER_QUERY_TIMEOUT, ECONNREFUSED); safe to log. */
function readDriverCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error instanceof ToolError ? undefined : error.code;
  }
  return undefined;
}

function elapsed(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}
