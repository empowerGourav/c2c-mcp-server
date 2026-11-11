import { ToolError } from '../errors.js';
import { messages } from '../messages.js';
import type { DateRange } from '../data/reporting-repository.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export interface DateRangeLimits {
  defaultWindowDays: number;
  maxLookbackDays: number;
}

/**
 * Resolve optional caller dates into a bounded, validated inclusive range (UTC).
 *
 * - Missing `endDate` defaults to today; missing `startDate` to `endDate - (defaultWindowDays - 1)`.
 * - Dates must be real calendar dates, not in the future, ordered, and no earlier than the max lookback.
 *
 * @param input - Caller-supplied dates (already shape-checked by the tool schema).
 * @param limits - Window and lookback policy.
 * @param today - Injected for tests; defaults to now.
 * @throws {ToolError} `INVALID_INPUT` with a safe explanation.
 */
export function resolveDateRange(
  input: { startDate?: string | undefined; endDate?: string | undefined },
  limits: DateRangeLimits,
  today: Date = new Date(),
): DateRange {
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const end = input.endDate === undefined ? todayUtc : parseIsoDate(input.endDate);
  const start = input.startDate === undefined ? end - (limits.defaultWindowDays - 1) * DAY_MS : parseIsoDate(input.startDate);
  const earliestAllowed = todayUtc - (limits.maxLookbackDays - 1) * DAY_MS;

  if (end > todayUtc || start > todayUtc) throw invalid(messages.validation.futureDate);
  if (end < start) throw invalid(messages.validation.endBeforeStart);
  if (start < earliestAllowed) throw invalid(messages.validation.lookbackExceeded(limits.maxLookbackDays));

  return { startDate: formatIsoDate(start), endDate: formatIsoDate(end) };
}

function parseIsoDate(value: string): number {
  if (!ISO_DATE.test(value)) throw invalid(messages.validation.invalidDate);
  const time = Date.parse(`${value}T00:00:00Z`);
  // Reject rollovers such as 2026-02-30 by round-tripping.
  if (Number.isNaN(time) || formatIsoDate(time) !== value) throw invalid(messages.validation.invalidDate);
  return time;
}

function formatIsoDate(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

function invalid(detail: string): ToolError {
  return new ToolError('INVALID_INPUT', messages.errors.invalidInput(detail));
}
