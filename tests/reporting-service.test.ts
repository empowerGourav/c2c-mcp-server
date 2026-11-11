import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { ReportingRepository } from '../src/data/reporting-repository.js';
import type { SqlRow } from '../src/data/database.js';
import { ToolError } from '../src/errors.js';
import { ReportingService } from '../src/tools/reporting-service.js';
import { ALL_VIEWS_APPROVED, FakeExecutor, FIXED_TODAY, makePrincipal, TEST_LIMITS } from './helpers.js';

function buildService(rows: SqlRow[] = [], reporting: AppConfig['reporting'] = ALL_VIEWS_APPROVED) {
  const executor = new FakeExecutor(() => rows);
  const service = new ReportingService({
    repository: new ReportingRepository(executor),
    limits: TEST_LIMITS,
    reporting,
    callsPerMinute: 30,
    today: () => FIXED_TODAY,
  });
  return { service, executor };
}

async function expectToolError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toSatisfy((error) => error instanceof ToolError && error.code === code);
}

describe('ReportingService.campaignDailySummary', () => {
  it('scopes the query to every campaign the principal may see when no campaign is requested', async () => {
    const { service, executor } = buildService();
    await service.campaignDailySummary(makePrincipal(['CMP-A', 'CMP-B']), {});
    expect(executor.calls[0]!.params).toEqual(expect.arrayContaining(['CMP-A', 'CMP-B']));
  });

  it('refuses a campaign outside the principal scope without querying', async () => {
    const { service, executor } = buildService();
    await expectToolError(service.campaignDailySummary(makePrincipal(['CMP-A']), { campaignRef: 'CMP-Z' }), 'NOT_AUTHORIZED');
    expect(executor.calls).toHaveLength(0);
  });

  it('suppresses groups below the minimum size and excludes them from totals', async () => {
    const { service } = buildService([
      { report_date: '2026-11-01', campaign_ref: 'CMP-A', call_count: 25, conversion_count: 5 },
      { report_date: '2026-11-02', campaign_ref: 'CMP-A', call_count: 3, conversion_count: 1 },
    ]);
    const output = await service.campaignDailySummary(makePrincipal(), { campaignRef: 'CMP-A' });

    expect(output.rows).toHaveLength(1);
    expect(output.suppressedGroups).toBe(1);
    expect(output.totals).toEqual({ callCount: 25, conversionCount: 5 });
    expect(output.notes.some((note) => note.includes('withheld'))).toBe(true);
  });

  it('is unavailable until the view is approved (allowlist empty by default)', async () => {
    const { service, executor } = buildService([], { ...ALL_VIEWS_APPROVED, approvedViews: new Set() });
    await expectToolError(service.campaignDailySummary(makePrincipal(), {}), 'VIEW_NOT_APPROVED');
    expect(executor.calls).toHaveLength(0);
  });
});

describe('ReportingService.callOutcomeSummary', () => {
  it('defaults to all approved outcome codes', async () => {
    const { service, executor } = buildService([{ outcome_code: 'ANSWERED', call_count: 50 }]);
    const output = await service.callOutcomeSummary(makePrincipal(), {});
    expect(executor.calls[0]!.params).toEqual(expect.arrayContaining(['ANSWERED', 'CONVERTED', 'NO_ANSWER']));
    expect(output.totals.callCount).toBe(50);
  });

  it('rejects outcome codes that are not approved', async () => {
    const { service } = buildService();
    await expectToolError(service.callOutcomeSummary(makePrincipal(), { outcomeCodes: ['SECRET_CODE'] }), 'INVALID_INPUT');
  });

  it('is unavailable when no outcome codes are approved', async () => {
    const { service } = buildService([], { ...ALL_VIEWS_APPROVED, outcomeCodes: [] });
    await expectToolError(service.callOutcomeSummary(makePrincipal(), {}), 'VIEW_NOT_APPROVED');
  });
});

describe('ReportingService.metricDefinitions', () => {
  it('reports enabled state and limits without naming database objects', () => {
    const { service } = buildService([], { ...ALL_VIEWS_APPROVED, approvedViews: new Set() });
    const definitions = service.metricDefinitions();
    expect(definitions.reports.every((report) => !report.enabled)).toBe(true);
    expect(JSON.stringify(definitions)).not.toMatch(/mcp_v_|SELECT|campaign_ref/);
    expect(definitions.limits.maxLookbackDays).toBe(90);
  });
});
