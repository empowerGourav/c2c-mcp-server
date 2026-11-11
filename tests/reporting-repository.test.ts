import { describe, expect, it } from 'vitest';
import { ReportingRepository, RowShapeError } from '../src/data/reporting-repository.js';
import { FakeExecutor } from './helpers.js';

const baseQuery = { startDate: '2026-11-01', endDate: '2026-11-10', campaignRefs: ['CMP-A', 'CMP-B'], maxRows: 2 };

describe('ReportingRepository.campaignDailySummary', () => {
  it('issues a fixed, parameterized query against the approved view with explicit columns', async () => {
    const executor = new FakeExecutor(() => [
      { report_date: '2026-11-01', campaign_ref: 'CMP-A', call_count: 12, conversion_count: 3 },
    ]);
    const result = await new ReportingRepository(executor).campaignDailySummary(baseQuery);

    const call = executor.calls[0]!;
    expect(call.sql).toContain('FROM mcp_v_campaign_daily');
    expect(call.sql).toContain('campaign_ref IN (?, ?)');
    expect(call.sql).not.toMatch(/\*/);
    expect(call.params).toEqual(['2026-11-01', '2026-11-10', 'CMP-A', 'CMP-B', '3']);
    expect(result).toEqual({
      rows: [{ reportDate: '2026-11-01', campaignRef: 'CMP-A', callCount: 12, conversionCount: 3 }],
      truncated: false,
    });
  });

  it('keeps hostile values out of the SQL text', async () => {
    const executor = new FakeExecutor();
    const hostile = "CMP'); DROP TABLE calls; --";
    await new ReportingRepository(executor).campaignDailySummary({ ...baseQuery, campaignRefs: [hostile] });
    expect(executor.calls[0]!.sql).not.toContain('DROP');
    expect(executor.calls[0]!.params).toContain(hostile);
  });

  it('flags truncation when more than maxRows rows come back', async () => {
    const row = { report_date: '2026-11-01', campaign_ref: 'CMP-A', call_count: 20, conversion_count: 1 };
    const executor = new FakeExecutor(() => [row, row, row]);
    const result = await new ReportingRepository(executor).campaignDailySummary(baseQuery);
    expect(result.truncated).toBe(true);
    expect(result.rows).toHaveLength(2);
  });

  it('accepts DECIMAL sums returned as numeric strings', async () => {
    const executor = new FakeExecutor(() => [
      { report_date: '2026-11-01', campaign_ref: 'CMP-A', call_count: '15', conversion_count: '4' },
    ]);
    const result = await new ReportingRepository(executor).campaignDailySummary(baseQuery);
    expect(result.rows[0]).toMatchObject({ callCount: 15, conversionCount: 4 });
  });

  it('rejects rows with unexpected shapes', async () => {
    const executor = new FakeExecutor(() => [{ report_date: null, campaign_ref: 'CMP-A', call_count: -1, conversion_count: 0 }]);
    await expect(new ReportingRepository(executor).campaignDailySummary(baseQuery)).rejects.toBeInstanceOf(RowShapeError);
  });

  it('refuses to run with an empty campaign scope', async () => {
    const executor = new FakeExecutor();
    await expect(new ReportingRepository(executor).campaignDailySummary({ ...baseQuery, campaignRefs: [] })).rejects.toThrow(
      RangeError,
    );
    expect(executor.calls).toHaveLength(0);
  });
});

describe('ReportingRepository.callOutcomeSummary', () => {
  it('filters by campaign scope and approved outcome codes', async () => {
    const executor = new FakeExecutor(() => [{ outcome_code: 'ANSWERED', call_count: 40 }]);
    const result = await new ReportingRepository(executor).callOutcomeSummary({
      ...baseQuery,
      outcomeCodes: ['ANSWERED', 'NO_ANSWER'],
    });

    const call = executor.calls[0]!;
    expect(call.sql).toContain('FROM mcp_v_call_outcome_daily');
    expect(call.sql).toContain('outcome_code IN (?, ?)');
    expect(call.params).toEqual(['2026-11-01', '2026-11-10', 'CMP-A', 'CMP-B', 'ANSWERED', 'NO_ANSWER', '3']);
    expect(result.rows).toEqual([{ outcomeCode: 'ANSWERED', callCount: 40 }]);
  });

  it('refuses an empty outcome filter', async () => {
    await expect(
      new ReportingRepository(new FakeExecutor()).callOutcomeSummary({ ...baseQuery, outcomeCodes: [] }),
    ).rejects.toThrow(RangeError);
  });
});
