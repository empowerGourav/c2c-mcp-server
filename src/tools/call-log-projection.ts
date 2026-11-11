import { CALL_LOG_COLUMNS, type AccountType } from '../data/allowlist.js';
import type { SqlRow } from '../data/database.js';

export type CallLogValue = string | number | null;
export type CallLogRow = Record<string, CallLogValue>;

const MAX_TEXT = 200;

/**
 * Reduce one raw call-log row to the columns the account type may see.
 *
 * Allowlist, not denylist: only columns named in `CALL_LOG_COLUMNS` survive, so a column added to the procedure
 * later is dropped by default. The caller number is reduced to its last four digits.
 */
export function projectCallLogRow(type: AccountType, row: SqlRow): CallLogRow {
  const audience = type === 'superadmin' ? 'marketplace' : type;
  const mapping: Record<string, string> = { ...CALL_LOG_COLUMNS.common, ...CALL_LOG_COLUMNS[audience] };

  const projected: CallLogRow = {};
  for (const [source, target] of Object.entries(mapping)) {
    projected[target] = toSafeValue(row[source]);
  }
  projected['callerLast4'] = maskCaller(row['Caller']);
  return projected;
}

/** `+1 (312) 555-0199` → `***-***-0199`; anything with fewer than 4 digits → null. */
export function maskCaller(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const digits = String(value).replace(/\D/g, '');
  return digits.length >= 4 ? `***-***-${digits.slice(-4)}` : null;
}

function toSafeValue(value: unknown): CallLogValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) : value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return null; // objects, buffers, JSON blobs are never passed through
}
