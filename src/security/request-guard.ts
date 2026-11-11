import { ToolError } from '../errors.js';
import { messages } from '../messages.js';

export interface RequestGuardOptions {
  perMinute: number;
  maxConcurrent: number;
  maxConcurrentPerUser: number;
  /** Injected clock for tests. */
  now?: () => number;
}

const WINDOW_MS = 60_000;

/**
 * In-process rate limiting and concurrency bounding (plan §5.2): N calls per user per minute,
 * a per-user concurrency cap, and a global cap that protects the C2C source.
 *
 * State is per replica. With more than one replica, put a shared limit in front (e.g. API Management).
 * Requests over a limit are rejected immediately rather than queued.
 */
export class RequestGuard {
  private readonly callTimes = new Map<string, number[]>();
  private readonly activePerUser = new Map<string, number>();
  private activeTotal = 0;
  private readonly now: () => number;

  constructor(private readonly options: RequestGuardOptions) {
    this.now = options.now ?? Date.now;
  }

  /**
   * Run `work` if the caller is within limits.
   *
   * @param principalKey - Stable per-user key (the audit ID).
   * @throws {ToolError} `RATE_LIMITED` or `BUSY` when a limit is exceeded.
   */
  async run<T>(principalKey: string, work: () => Promise<T>): Promise<T> {
    this.consumeRateToken(principalKey);

    const userActive = this.activePerUser.get(principalKey) ?? 0;
    if (userActive >= this.options.maxConcurrentPerUser || this.activeTotal >= this.options.maxConcurrent) {
      throw new ToolError('BUSY', messages.errors.busy);
    }

    this.activePerUser.set(principalKey, userActive + 1);
    this.activeTotal += 1;
    try {
      return await work();
    } finally {
      this.activeTotal -= 1;
      const remaining = (this.activePerUser.get(principalKey) ?? 1) - 1;
      if (remaining <= 0) this.activePerUser.delete(principalKey);
      else this.activePerUser.set(principalKey, remaining);
    }
  }

  private consumeRateToken(principalKey: string): void {
    const now = this.now();
    const recent = (this.callTimes.get(principalKey) ?? []).filter((time) => now - time < WINDOW_MS);
    if (recent.length >= this.options.perMinute) {
      this.callTimes.set(principalKey, recent);
      throw new ToolError('RATE_LIMITED', messages.errors.rateLimited);
    }
    recent.push(now);
    this.callTimes.set(principalKey, recent);
    this.evictIdle(now);
  }

  /** Keep memory bounded: drop users with no calls inside the window. */
  private evictIdle(now: number): void {
    if (this.callTimes.size < 1000) return;
    for (const [key, times] of this.callTimes) {
      const last = times[times.length - 1];
      if (last === undefined || now - last >= WINDOW_MS) this.callTimes.delete(key);
    }
  }
}
