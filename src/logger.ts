/**
 * Minimal structured JSON logger (one line per event on stdout, for Container Apps / Log Analytics).
 *
 * Callers must pass metadata only (plan §7.2): request IDs, hashed principal IDs, tool names,
 * decisions, durations, and counts. Never pass tokens, raw questions, SQL parameters, or result rows.
 * Keys that look sensitive are redacted defensively.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, string | number | boolean | null | undefined>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SENSITIVE_KEY_PATTERN = /token|password|secret|authorization|cookie|sql|param/i;
const REDACTED = '[redacted]';

/**
 * Create a JSON-lines logger.
 *
 * @param minLevel - Lowest level that is emitted.
 * @param write - Output sink; defaults to stdout. Injected in tests.
 */
export function createLogger(minLevel: LogLevel, write: (line: string) => void = (line) => process.stdout.write(`${line}\n`)): Logger {
  const emit = (level: LogLevel, event: string, fields: LogFields = {}): void => {
    if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) return;
    const safeFields: LogFields = {};
    for (const [key, value] of Object.entries(fields)) {
      safeFields[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : value;
    }
    write(JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...safeFields }));
  };
  return {
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
  };
}
