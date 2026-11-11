import { describe, expect, it } from 'vitest';
import { ReportingRepository } from '../src/data/reporting-repository.js';
import { ScopeRepository } from '../src/data/scope-repository.js';
import { ToolError } from '../src/errors.js';
import { maskCaller, projectCallLogRow } from '../src/tools/call-log-projection.js';
import { ReportingService } from '../src/tools/reporting-service.js';
import {
  ADVERTISER,
  FakeExecutor,
  FIXED_TODAY,
  makePrincipal,
  MARKETPLACE,
  PUBLISHER,
  SUPER_ADMIN,
  TEST_LIMITS,
  type Responder,
} from './helpers.js';

/** A row shaped like getCallLogReportReplica output, including fields that must never leave the server. */
const RAW_ROW = {
  Id: 9001,
  Timestamp: '2026-11-10 14:03:22',
  Vertical: 'Auto Insurance',
  Call_Status: 'completed',
  Total_Call_Duration: 184,
  Returned: 0,
  Scrubbed: 0,
  Error: null,
  Ping_State: 'TX',
  DUP: 'No',
  Marketplace_Name: 'Acme Marketplace',
  Advertiser_Name: 'Buyer Co',
  Offer_Name: 'Auto Offer',
  Publisher_Name: 'Source Co',
  Campaign_Name: 'Auto Campaign',
  Marketplace_Billable: 1,
  Publisher_Billable: 1,
  Revenue: 45.5,
  Publisher_Payout: 30,
  Caller: '+1 (312) 555-0199',
  Recording_URL: 'https://recordings.example/abc.mp3',
  Called_DID: '8005550100',
  Transferred_To: '8005550111',
  Single_Caller_Phone_Number: '3125550199',
  Ping_Zip_Code: '75001',
  call_summary: 'Caller asked about…',
  Reason_to_Return: 'free text',
  publisher_ping_data: { first_name: 'Jane' },
  totalCount: 57,
};

const FORBIDDEN = ['Recording_URL', 'recordings.example', '8005550100', '8005550111', '3125550199', '75001', 'Caller asked', 'Jane', '555-0199'];

describe('projectCallLogRow', () => {
  it('marketplace sees names and both money sides, never sensitive fields', () => {
    const row = projectCallLogRow('marketplace', RAW_ROW);
    expect(row).toMatchObject({
      callId: 9001,
      advertiser: 'Buyer Co',
      publisher: 'Source Co',
      revenue: 45.5,
      publisherPayout: 30,
      callerLast4: '***-***-0199',
    });
    const json = JSON.stringify(row);
    for (const value of FORBIDDEN) expect(json).not.toContain(value);
  });

  it('advertiser sees its cost and offer, but not publishers or payouts', () => {
    const row = projectCallLogRow('advertiser', RAW_ROW);
    expect(row).toMatchObject({ advertiser: 'Buyer Co', offer: 'Auto Offer', cost: 45.5 });
    expect(row).not.toHaveProperty('publisher');
    expect(row).not.toHaveProperty('campaign');
    expect(row).not.toHaveProperty('publisherPayout');
    expect(row).not.toHaveProperty('revenue');
  });

  it('publisher sees its payout as revenue, but not advertisers or advertiser revenue', () => {
    const row = projectCallLogRow('publisher', RAW_ROW);
    expect(row).toMatchObject({ publisher: 'Source Co', campaign: 'Auto Campaign', revenue: 30 });
    expect(row).not.toHaveProperty('advertiser');
    expect(row).not.toHaveProperty('offer');
    expect(row).not.toHaveProperty('cost');
  });

  it('drops columns the procedure may add later (allowlist, not denylist)', () => {
    expect(projectCallLogRow('marketplace', { ...RAW_ROW, New_Secret_Column: 'x' })).not.toHaveProperty('New_Secret_Column');
  });
});

describe('maskCaller', () => {
  it.each([
    ['+1 (312) 555-0199', '***-***-0199'],
    [3125550199, '***-***-0199'],
    ['12', null],
    [null, null],
    [{}, null],
  ])('masks %j as %j', (input, expected) => {
    expect(maskCaller(input)).toBe(expected);
  });
});

function build(respond: Responder = () => [RAW_ROW]) {
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

describe('ReportingService.callLog', () => {
  it('calls the procedure with the Laravel order, fixed free-text params and the account scope', async () => {
    const { service, executor } = build();
    const output = await service.callLog(makePrincipal([MARKETPLACE]), {
      startDate: '2026-11-01',
      endDate: '2026-11-10',
      billable: true,
      callTagIds: [13, 22],
      page: 2,
      pageSize: 10,
    });

    const call = executor.calls[0]!;
    expect(call.sql).toBe('CALL getCallLogReportReplica');
    expect(call.params).toEqual([
      '2026-11-01 00:00:00', '2026-11-10 23:59:59', '', 100, null, null, null, null, 1, null, null,
      'America/Chicago', 'null', 10, 10, '', '13,22', null, '', null, '', null, 2,
    ]);
    expect(output).toMatchObject({ page: 2, pageSize: 10, totalCount: 57 });
    expect(output.notes.some((note) => note.includes('Page 2 of 6'))).toBe(true);
  });

  it('pins advertiser and publisher accounts to their own IDs', async () => {
    const advertiser = build();
    await advertiser.service.callLog(makePrincipal([ADVERTISER]), {});
    expect(advertiser.executor.calls[0]!.params.slice(3, 6)).toEqual([100, null, 200]);

    const publisher = build();
    await publisher.service.callLog(makePrincipal([PUBLISHER]), {});
    expect(publisher.executor.calls[0]!.params.slice(3, 6)).toEqual([100, 300, null]);
  });

  it('never returns sensitive fields end to end', async () => {
    const { service } = build();
    const json = JSON.stringify(await service.callLog(makePrincipal([MARKETPLACE]), {}));
    for (const value of FORBIDDEN) expect(json).not.toContain(value);
  });

  it('returns zero total for an empty page', async () => {
    const { service } = build(() => []);
    expect((await service.callLog(makePrincipal([MARKETPLACE]), {})).totalCount).toBe(0);
  });

  it('requires super admin to choose a customer', async () => {
    const { service } = build();
    await expect(service.callLog(makePrincipal([SUPER_ADMIN]), {})).rejects.toSatisfy(
      (error) => error instanceof ToolError && error.code === 'INVALID_INPUT',
    );
  });
});
