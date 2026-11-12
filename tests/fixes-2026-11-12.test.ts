import { describe, expect, it } from 'vitest';
import { DbPrincipalResolver } from '../src/auth/db-principal-resolver.js';
import { ScopeRepository } from '../src/data/scope-repository.js';
import { ReportingRepository } from '../src/data/reporting-repository.js';
import { ToolError } from '../src/errors.js';
import { resolveDateRange } from '../src/tools/date-range.js';
import { ReportingService } from '../src/tools/reporting-service.js';
import { captureLogger, FakeExecutor, makePrincipal, MARKETPLACE, SUPER_ADMIN, TEST_LIMITS, type Responder } from './helpers.js';

describe('user timezone (users.time_zone, as the Laravel login maps it)', () => {
  const resolverWith = (timeZone: unknown) =>
    new DbPrincipalResolver({
      executor: new FakeExecutor((sql) =>
        / FROM users /.test(sql)
          ? [{ id: 7, time_zone: timeZone }]
          : sql.startsWith('SELECT id FROM user_role_association')
            ? []
            : [{ id: 11, role_id: 2, user_type_id: 1, customer_id: 100, customer_name: 'IBM ltd' }],
      ),
      auditHashSalt: 'test-salt-0123456789',
      allowSuperAdmin: false,
      cacheTtlMs: 1,
      logger: captureLogger().logger,
    });

  it.each([
    ['EST', 'America/New_York'],
    ['CST', 'America/Chicago'],
    ['mst', 'America/Denver'],
    ['PST', 'America/Los_Angeles'],
    ['', 'America/New_York'],
    [null, 'America/New_York'],
    ['XYZ', 'America/New_York'],
  ])('maps %j to %s', async (abbreviation, expected) => {
    expect((await resolverWith(abbreviation).resolve('pat@example.com'))?.timezone).toBe(expected);
  });
});

describe('resolveDateRange in the user timezone', () => {
  // 2026-11-12 03:00 UTC is still 2026-11-11 in New York.
  const now = new Date('2026-11-12T03:00:00Z');
  const limits = { defaultWindowDays: 1, maxLookbackDays: 90 };

  it('uses the local calendar day for "today"', () => {
    expect(resolveDateRange({}, limits, now, 'America/New_York')).toEqual({ startDate: '2026-11-11', endDate: '2026-11-11' });
    expect(resolveDateRange({}, limits, now, 'UTC')).toEqual({ startDate: '2026-11-12', endDate: '2026-11-12' });
  });

  it('treats a local "tomorrow" as the future', () => {
    expect(() => resolveDateRange({ endDate: '2026-11-12' }, limits, now, 'America/New_York')).toThrow(ToolError);
  });
});

function service(respond: Responder) {
  const executor = new FakeExecutor(respond);
  return {
    executor,
    service: new ReportingService({
      reporting: new ReportingRepository(executor, 1),
      scopes: new ScopeRepository(executor),
      limits: TEST_LIMITS,
      defaultTimezone: 'America/Chicago',
      callsPerMinute: 30,
      today: () => new Date('2026-11-12T15:00:00Z'),
    }),
  };
}

describe('finding a marketplace by name', () => {
  it('lets super admins search customers with a bound, escaped LIKE pattern', async () => {
    const { service: svc, executor } = service(() => [{ id: 42, name: 'IBM ltd' }]);
    const output = await svc.listDimensions(makePrincipal([SUPER_ADMIN]), { kind: 'customers', nameContains: 'IBM_1%' });
    const call = executor.calls[0]!;
    expect(call.sql).toBe(
      'SELECT id, company_name AS name FROM customers WHERE status <> ? AND (? IS NULL OR company_name LIKE ?) ORDER BY company_name LIMIT ?',
    );
    // LIKE wildcards in the search text are escaped, so 'IBM_1%' matches literally.
    expect(call.params).toEqual([5, '%IBM\\_1\\%%', '%IBM\\_1\\%%', '501']);
    expect(output.rows).toEqual([{ id: 42, name: 'IBM ltd' }]);
  });

  it('shows marketplace users only their own customer', async () => {
    const { service: svc, executor } = service(() => []);
    await svc.listDimensions(makePrincipal([MARKETPLACE]), { kind: 'customers' });
    expect(executor.calls[0]!.sql).toContain('WHERE id = ? AND status <> ?');
    expect(executor.calls[0]!.params[0]).toBe(100);
  });

  it('passes a null name filter when none is given', async () => {
    const { service: svc, executor } = service(() => []);
    await svc.listDimensions(makePrincipal([MARKETPLACE]), { kind: 'advertisers' });
    expect(executor.calls[0]!.params).toEqual([100, 5, null, null, '501']);
  });
});

describe('call log defaults', () => {
  it("sends intelligence 'Any' and is_voiceaiq 2 like the C2C screens, in the user's timezone", async () => {
    const { service: svc, executor } = service(() => []);
    await svc.callLog(makePrincipal([MARKETPLACE], 'America/New_York'), { startDate: '2026-11-11', endDate: '2026-11-11' });
    const params = executor.calls[0]!.params;
    expect(params[11]).toBe('America/New_York');
    expect(params[12]).toBe('Any');
    expect(params[22]).toBe(2);
  });
});
