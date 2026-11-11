import { describe, expect, it } from 'vitest';
import { KPI_PROCEDURES, type KpiArgs } from '../src/data/allowlist.js';
import { ReportingRepository, RowShapeError } from '../src/data/reporting-repository.js';
import { FakeExecutor } from './helpers.js';

const args: KpiArgs = {
  startDateTime: '2026-11-01 00:00:00',
  endDateTime: '2026-11-10 23:59:59',
  timezone: 'America/Chicago',
  customerId: 100,
  advertiserId: 200,
  publisherId: null,
  verticalId: 7,
  offerId: null,
  campaignId: null,
};

describe('ReportingRepository.dashboardKpis', () => {
  it('calls each marketplace procedure with the Laravel parameter order', async () => {
    const executor = new FakeExecutor((sql) => (sql.endsWith('TotalCallsReplica') ? [{ total_calls: 1234 }] : [{}]));
    const result = await new ReportingRepository(executor, 3).dashboardKpis('marketplace', args);

    expect(executor.procedureCalls()).toEqual(KPI_PROCEDURES.marketplace.map((entry) => entry.procedure));
    expect(executor.calls[0]!.params).toEqual([
      '2026-11-01 00:00:00', '2026-11-10 23:59:59', 100, 7, 200, null, null, null, 'America/Chicago',
    ]);
    expect(result.metrics['totalCalls']).toBe(1234);
    expect(result.metrics['revenue']).toBe(0);
  });

  it('uses advertiser order and omits tz only for NoOfferFound', async () => {
    const executor = new FakeExecutor(() => [{ value: 5 }]);
    await new ReportingRepository(executor, 2).dashboardKpis('advertiser', args);
    const byName = new Map(executor.calls.map((call) => [call.sql, call.params]));
    expect(byName.get('CALL getAdvertiserDashboardSpendReplica')).toEqual([
      '2026-11-01 00:00:00', '2026-11-10 23:59:59', 200, 7, null, 100, 'America/Chicago',
    ]);
    expect(byName.get('CALL getAdvertiserDashboardNoOfferFoundReplica')).toHaveLength(6);
  });

  it('reads a single numeric column when the column name is unknown, ignoring nothing else', async () => {
    const executor = new FakeExecutor(() => [{ paid_calls: '42' }]);
    const result = await new ReportingRepository(executor, 1).dashboardKpis('publisher', { ...args, publisherId: 300 });
    expect(result.metrics['paidCalls']).toBe(42);
  });

  it('reports individual failures without failing the whole call', async () => {
    const executor = new FakeExecutor((sql) => {
      if (sql.endsWith('SpendReplica')) throw Object.assign(new Error('boom'), { code: 'ER_QUERY_TIMEOUT' });
      return [{ value: 1 }];
    });
    const result = await new ReportingRepository(executor, 3).dashboardKpis('advertiser', args);
    expect(result.unavailable).toEqual(['spend']);
    expect(result.metrics['spend']).toBeNull();
  });

  it('rethrows when every procedure fails', async () => {
    const executor = new FakeExecutor(() => {
      throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' });
    });
    await expect(new ReportingRepository(executor, 3).dashboardKpis('publisher', args)).rejects.toThrow('down');
  });

  it('refuses result rows with several numeric columns (unexpected shape)', async () => {
    const executor = new FakeExecutor(() => [{ a: 1, b: 2 }]);
    await expect(new ReportingRepository(executor, 3).dashboardKpis('publisher', args)).rejects.toBeInstanceOf(RowShapeError);
  });
});

describe('ReportingRepository.financials', () => {
  it('computes profit and margin from the financials procedure', async () => {
    const executor = new FakeExecutor(() => [{ call_revenue: 1000, call_cost: 750.5 }]);
    const summary = await new ReportingRepository(executor, 1).financials(100, 'MTD', 'America/Chicago');
    expect(executor.calls[0]).toEqual({ sql: 'CALL getCustomerDashboardFinancialsReplica', params: [100, 'MTD', 'America/Chicago'] });
    expect(summary).toEqual({ period: 'MTD', revenue: 1000, cost: 750.5, profit: 249.5, marginPercent: 24.95 });
  });

  it('returns a null margin when there is no revenue', async () => {
    const executor = new FakeExecutor(() => [{ call_revenue: null, call_cost: null }]);
    expect((await new ReportingRepository(executor, 1).financials(100, 'LY', 'UTC')).marginPercent).toBeNull();
  });
});

describe('ReportingRepository.dailyTrend', () => {
  const trend = {
    startDateTime: '2026-11-01 00:00:00',
    endDateTime: '2026-11-10 23:59:59',
    timezone: 'America/Chicago',
    customerId: 100,
    advertiserId: null,
    publisherId: null,
    verticalId: null,
    offerId: null,
    campaignId: 400,
    maxRows: 2,
  };
  const row = {
    report_date: '2026-11-01',
    total_calls: 10,
    billable_calls: '4',
    payable_calls: '5',
    avg_duration: '93',
    advertiser_revenue: '120.50',
    publisher_payout: 80,
  };

  it('binds every value and never interpolates', async () => {
    const executor = new FakeExecutor(() => [row]);
    const result = await new ReportingRepository(executor, 1).dailyTrend(trend);
    const call = executor.calls[0]!;
    expect(call.sql).toContain('FROM calls c');
    expect(call.sql).not.toMatch(/SELECT \*|America|400/);
    expect(call.params).toEqual([
      'America/Chicago', '2026-11-01 00:00:00', 'America/Chicago', '2026-11-10 23:59:59', 'America/Chicago',
      100, 100, null, null, null, null, null, null, null, null, 400, 400, '3',
    ]);
    expect(result.rows[0]).toEqual({
      reportDate: '2026-11-01', totalCalls: 10, billableCalls: 4, payableCalls: 5, avgDurationSeconds: 93,
      advertiserRevenue: 120.5, publisherPayout: 80,
    });
  });

  it('flags truncation', async () => {
    const executor = new FakeExecutor(() => [row, row, row]);
    expect((await new ReportingRepository(executor, 1).dailyTrend(trend)).truncated).toBe(true);
  });

  it('refuses an unscoped trend query', async () => {
    const executor = new FakeExecutor();
    await expect(
      new ReportingRepository(executor, 1).dailyTrend({ ...trend, customerId: null }),
    ).rejects.toThrow(RangeError);
    expect(executor.calls).toHaveLength(0);
  });

  it('rejects malformed rows', async () => {
    const executor = new FakeExecutor(() => [{ ...row, total_calls: 'lots' }]);
    await expect(new ReportingRepository(executor, 1).dailyTrend(trend)).rejects.toBeInstanceOf(RowShapeError);
  });
});
