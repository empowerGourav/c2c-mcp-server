import { describe, expect, it } from 'vitest';
import { ToolError } from '../src/errors.js';
import { resolveDateRange } from '../src/tools/date-range.js';
import { FIXED_TODAY } from './helpers.js';

const limits = { defaultWindowDays: 30, maxLookbackDays: 90 };

function expectInvalid(run: () => unknown): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).code).toBe('INVALID_INPUT');
    return;
  }
  throw new Error('expected INVALID_INPUT');
}

describe('resolveDateRange', () => {
  it('defaults to the last 30 days ending today (UTC)', () => {
    expect(resolveDateRange({}, limits, FIXED_TODAY)).toEqual({ startDate: '2026-10-13', endDate: '2026-11-11' });
  });

  it('defaults the start relative to an explicit end date', () => {
    expect(resolveDateRange({ endDate: '2026-11-01' }, limits, FIXED_TODAY)).toEqual({
      startDate: '2026-10-03',
      endDate: '2026-11-01',
    });
  });

  it('accepts a single-day range', () => {
    expect(resolveDateRange({ startDate: '2026-11-11', endDate: '2026-11-11' }, limits, FIXED_TODAY)).toEqual({
      startDate: '2026-11-11',
      endDate: '2026-11-11',
    });
  });

  it('accepts the earliest date inside the lookback window', () => {
    expect(resolveDateRange({ startDate: '2026-08-14' }, limits, FIXED_TODAY).startDate).toBe('2026-08-14');
  });

  it('rejects a start date beyond the lookback window', () => {
    expectInvalid(() => resolveDateRange({ startDate: '2026-08-13' }, limits, FIXED_TODAY));
  });

  it('rejects future dates', () => {
    expectInvalid(() => resolveDateRange({ endDate: '2026-11-12' }, limits, FIXED_TODAY));
  });

  it('rejects an end date before the start date', () => {
    expectInvalid(() => resolveDateRange({ startDate: '2026-11-05', endDate: '2026-11-01' }, limits, FIXED_TODAY));
  });

  it.each(['2026-02-30', '2026-13-01', '11/01/2026', "2026-11-01' OR 1=1", ''])('rejects malformed date %j', (value) => {
    expectInvalid(() => resolveDateRange({ startDate: value }, limits, FIXED_TODAY));
  });
});
