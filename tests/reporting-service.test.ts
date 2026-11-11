import { describe, expect, it } from 'vitest';
import type { C2cAccount } from '../src/auth/principal.js';
import { ReportingRepository } from '../src/data/reporting-repository.js';
import { ScopeRepository } from '../src/data/scope-repository.js';
import { ToolError } from '../src/errors.js';
import { ReportingService } from '../src/tools/reporting-service.js';
import {
  ADVERTISER,
  FakeExecutor,
  FIXED_TODAY,
  makePrincipal,
  MARKETPLACE,
  ownershipResponder,
  type Responder,
  PUBLISHER,
  SUPER_ADMIN,
  TEST_LIMITS,
} from './helpers.js';

const TREND_ROW = {
  report_date: '2026-11-01',
  total_calls: 10,
  billable_calls: 4,
  payable_calls: 5,
  avg_duration: 90,
  advertiser_revenue: 100,
  publisher_payout: 60,
};

function build(respond: Responder = () => []) {
  const executor = new FakeExecutor(respond);
  const service = new ReportingService({
    reporting: new ReportingRepository(executor, 3),
    scopes: new ScopeRepository(executor),
    limits: TEST_LIMITS,
    defaultTimezone: 'America/Chicago',
    callsPerMinute: 30,
    today: () => FIXED_TODAY,
  });
  return { service, executor };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toSatisfy((error) => error instanceof ToolError && error.code === code);
}

describe('account selection', () => {
  it('uses the only account implicitly and requires accountId when there are several', async () => {
    const { service } = build();
    await expect(service.dashboardKpis(makePrincipal([MARKETPLACE]), {})).resolves.toBeDefined();
    await expectCode(service.dashboardKpis(makePrincipal([MARKETPLACE, ADVERTISER]), {}), 'INVALID_INPUT');
    await expect(service.dashboardKpis(makePrincipal([MARKETPLACE, ADVERTISER]), { accountId: 12 })).resolves.toMatchObject({
      account: { type: 'advertiser' },
    });
  });

  it('refuses an accountId the user does not hold', async () => {
    const { service } = build();
    await expectCode(service.dashboardKpis(makePrincipal([MARKETPLACE]), { accountId: 99 }), 'NOT_AUTHORIZED');
  });

  it('lists accounts without exposing internal IDs beyond the accountId', () => {
    const { service } = build();
    const output = service.listAccounts(makePrincipal([MARKETPLACE, PUBLISHER]));
    expect(output.accounts).toEqual([
      { accountId: 11, type: 'marketplace', accountName: 'Acme Marketplace', customerName: 'Acme Marketplace' },
      { accountId: 13, type: 'publisher', accountName: 'Source Co', customerName: 'Acme Marketplace' },
    ]);
  });
});

describe('dashboardKpis', () => {
  it('passes the default window, timezone and account scope to the procedures', async () => {
    const { service, executor } = build(() => [{ total_calls: 3 }]);
    const output = await service.dashboardKpis(makePrincipal(), {});
    expect(output.dateRange).toEqual({ startDate: '2026-10-13', endDate: '2026-11-11', timezone: 'America/Chicago' });
    expect(executor.calls[0]!.params.slice(0, 3)).toEqual(['2026-10-13 00:00:00', '2026-11-11 23:59:59', 100]);
  });

  it('rejects unknown timezones before touching the database', async () => {
    const { service, executor } = build();
    await expectCode(service.dashboardKpis(makePrincipal(), { timezone: 'Mars/Olympus' }), 'INVALID_INPUT');
    expect(executor.calls).toHaveLength(0);
  });

  it('does not run procedures when a filter is out of scope', async () => {
    const { service, executor } = build(ownershipResponder([]));
    await expectCode(service.dashboardKpis(makePrincipal(), { advertiserId: 999 }), 'NOT_AUTHORIZED');
    expect(executor.procedureCalls()).toHaveLength(0);
  });
});

describe('financialSummary', () => {
  it('is available to marketplace accounts for all periods by default', async () => {
    const { service, executor } = build(() => [{ call_revenue: 200, call_cost: 150 }]);
    const output = await service.financialSummary(makePrincipal(), {});
    expect(output.rows.map((row) => row.period)).toEqual(['MTD', 'LM', 'YTD', 'LY']);
    expect(executor.calls.every((call) => call.params[0] === 100)).toBe(true);
  });

  it.each([ADVERTISER, PUBLISHER])('is refused for %s accounts', async (account: C2cAccount) => {
    const { service } = build();
    await expectCode(service.financialSummary(makePrincipal([account]), {}), 'INVALID_INPUT');
  });

  it('requires a customer for super admin', async () => {
    const { service } = build();
    await expectCode(service.financialSummary(makePrincipal([SUPER_ADMIN]), {}), 'INVALID_INPUT');
  });
});

describe('dailyTrend money projection', () => {
  it('shows marketplace revenue, cost and profit', async () => {
    const { service } = build(() => [TREND_ROW]);
    const output = await service.dailyTrend(makePrincipal([MARKETPLACE]), {});
    expect(output.rows[0]).toMatchObject({ revenue: 100, cost: 60, profit: 40 });
  });

  it('shows advertisers only their spend', async () => {
    const { service } = build(() => [TREND_ROW]);
    const row = (await service.dailyTrend(makePrincipal([ADVERTISER]), {})).rows[0]!;
    expect(row).toMatchObject({ spend: 100 });
    expect(row).not.toHaveProperty('cost');
    expect(row).not.toHaveProperty('revenue');
  });

  it('shows publishers only their payout as revenue', async () => {
    const { service } = build(() => [TREND_ROW]);
    const row = (await service.dailyTrend(makePrincipal([PUBLISHER]), {})).rows[0]!;
    expect(row).toMatchObject({ revenue: 60 });
    expect(row).not.toHaveProperty('spend');
    expect(row).not.toHaveProperty('profit');
  });

  it('requires super admin to pick a customer', async () => {
    const { service } = build();
    await expectCode(service.dailyTrend(makePrincipal([SUPER_ADMIN]), {}), 'INVALID_INPUT');
  });
});

describe('listDimensions', () => {
  it('scopes marketplace lists to the customer', async () => {
    const { service, executor } = build(() => [{ id: 5, name: 'Auto Insurance Buyer' }]);
    const output = await service.listDimensions(makePrincipal(), { kind: 'advertisers' });
    expect(executor.calls[0]!.sql).toContain('WHERE customer_id = ?');
    expect(executor.calls[0]!.params[0]).toBe(100);
    expect(output.rows).toEqual([{ id: 5, name: 'Auto Insurance Buyer' }]);
  });

  it('does not let advertisers list publishers or campaigns', async () => {
    const { service } = build();
    await expectCode(service.listDimensions(makePrincipal([ADVERTISER]), { kind: 'publishers' }), 'INVALID_INPUT');
    await expectCode(service.listDimensions(makePrincipal([ADVERTISER]), { kind: 'campaigns' }), 'INVALID_INPUT');
  });

  it('refuses another customer for non-admin accounts', async () => {
    const { service } = build();
    await expectCode(service.listDimensions(makePrincipal(), { kind: 'offers', customerId: 555 }), 'NOT_AUTHORIZED');
  });
});

describe('metricDefinitions', () => {
  it('describes reports without naming procedures or tables', () => {
    const { service } = build();
    expect(JSON.stringify(service.metricDefinitions())).not.toMatch(/Replica|user_role_association|SELECT|calls c/);
  });
});
