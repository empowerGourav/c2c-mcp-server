import { describe, expect, it } from 'vitest';
import { ToolError } from '../src/errors.js';
import { RequestGuard } from '../src/security/request-guard.js';

const ok = async () => 'done';

function codeOf(error: unknown): string | undefined {
  return error instanceof ToolError ? error.code : undefined;
}

describe('RequestGuard', () => {
  it('allows calls up to the per-minute limit, then rejects, then recovers after the window', async () => {
    let now = 0;
    const guard = new RequestGuard({ perMinute: 2, maxConcurrent: 10, maxConcurrentPerUser: 10, now: () => now });

    await guard.run('user-1', ok);
    await guard.run('user-1', ok);
    await expect(guard.run('user-1', ok)).rejects.toSatisfy((error) => codeOf(error) === 'RATE_LIMITED');
    await expect(guard.run('user-2', ok)).resolves.toBe('done');

    now = 60_001;
    await expect(guard.run('user-1', ok)).resolves.toBe('done');
  });

  it('enforces the per-user concurrency cap and releases slots on failure', async () => {
    const guard = new RequestGuard({ perMinute: 100, maxConcurrent: 10, maxConcurrentPerUser: 1 });
    let release!: () => void;
    const blocked = guard.run('user-1', () => new Promise<void>((resolve) => (release = resolve)));

    await expect(guard.run('user-1', ok)).rejects.toSatisfy((error) => codeOf(error) === 'BUSY');
    release();
    await blocked;

    await expect(guard.run('user-1', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(guard.run('user-1', ok)).resolves.toBe('done');
  });

  it('enforces the global concurrency cap across users', async () => {
    const guard = new RequestGuard({ perMinute: 100, maxConcurrent: 1, maxConcurrentPerUser: 5 });
    let release!: () => void;
    const blocked = guard.run('user-1', () => new Promise<void>((resolve) => (release = resolve)));

    await expect(guard.run('user-2', ok)).rejects.toSatisfy((error) => codeOf(error) === 'BUSY');
    release();
    await blocked;
  });
});
