import { isIanaTimezone, type QueryLimits } from '../config.js';
import { selectAccount, type C2cAccount, type C2cPrincipal } from '../auth/principal.js';
import { ALLOWLIST_VERSION, FINANCIAL_PERIODS, type AccountType } from '../data/allowlist.js';
import type { ReportingRepository, TrendRow } from '../data/reporting-repository.js';
import type { DimensionKind, DimensionScope, ScopeRepository } from '../data/scope-repository.js';
import { ToolError } from '../errors.js';
import { messages } from '../messages.js';
import { resolveDateRange } from './date-range.js';
import { resolveScope } from './scope-authorizer.js';
import type {
  AccountSummary,
  DailyTrendOutput,
  DashboardKpisOutput,
  FinancialSummaryInput,
  FinancialSummaryOutput,
  ListAccountsOutput,
  ListDimensionsInput,
  ListDimensionsOutput,
  MetricDefinitionsOutput,
  ReportRangeInput,
} from './schemas.js';

export interface ReportingServiceOptions {
  reporting: ReportingRepository;
  scopes: ScopeRepository;
  limits: QueryLimits;
  defaultTimezone: string;
  callsPerMinute: number;
  /** Injected for tests. */
  today?: () => Date;
}

/** Which dimension lists each account type may see, and how they are restricted. */
const DIMENSION_RULES: Record<AccountType, Partial<Record<DimensionKind, (account: C2cAccount) => DimensionScope>>> = {
  marketplace: {
    verticals: () => ({ by: 'none' }),
    advertisers: (a) => ({ by: 'customer', customerId: a.customerId! }),
    publishers: (a) => ({ by: 'customer', customerId: a.customerId! }),
    offers: (a) => ({ by: 'customer', customerId: a.customerId! }),
    campaigns: (a) => ({ by: 'customer', customerId: a.customerId! }),
  },
  advertiser: {
    verticals: () => ({ by: 'none' }),
    advertisers: (a) => ({ by: 'self', id: a.advertiserId! }),
    offers: (a) => ({ by: 'advertiser', advertiserId: a.advertiserId! }),
  },
  publisher: {
    verticals: () => ({ by: 'none' }),
    publishers: (a) => ({ by: 'self', id: a.publisherId! }),
    campaigns: (a) => ({ by: 'publisher', publisherId: a.publisherId! }),
  },
  superadmin: {
    verticals: () => ({ by: 'none' }),
    advertisers: () => ({ by: 'none' }),
    publishers: () => ({ by: 'none' }),
    offers: () => ({ by: 'none' }),
    campaigns: () => ({ by: 'none' }),
  },
};

/**
 * Business rules for each tool: account selection, scope authorization, date bounds, role-appropriate
 * metric projection, and notes. Independent of MCP transport concerns.
 */
export class ReportingService {
  private readonly today: () => Date;

  constructor(private readonly options: ReportingServiceOptions) {
    this.today = options.today ?? (() => new Date());
  }

  listAccounts(principal: C2cPrincipal): ListAccountsOutput {
    return { accounts: principal.accounts.map(summarize) };
  }

  /** @throws {ToolError} When the account cannot see that kind of entity. */
  async listDimensions(principal: C2cPrincipal, input: ListDimensionsInput): Promise<ListDimensionsOutput> {
    const account = selectAccount(principal, input.accountId);
    let scope = DIMENSION_RULES[account.type][input.kind]?.(account);
    if (!scope) {
      throw new ToolError('INVALID_INPUT', messages.errors.invalidInput(messages.validation.filterNotAllowed(input.kind)));
    }
    if (account.type === 'superadmin' && input.customerId !== undefined && input.kind !== 'verticals') {
      scope = { by: 'customer', customerId: input.customerId };
    } else if (input.customerId !== undefined && input.customerId !== account.customerId) {
      throw new ToolError('NOT_AUTHORIZED', messages.errors.notAuthorized);
    }

    const result = await this.options.scopes.listDimension(input.kind, scope, this.options.limits.maxRows);
    return {
      account: summarize(account),
      kind: input.kind,
      rows: result.rows,
      truncated: result.truncated,
      notes: this.notes(result.truncated),
    };
  }

  async dashboardKpis(principal: C2cPrincipal, input: ReportRangeInput): Promise<DashboardKpisOutput> {
    const account = selectAccount(principal, input.accountId);
    const { dateRange, timezone } = this.resolveRange(input);
    const scope = await resolveScope(account, input, this.options.scopes);

    const result = await this.options.reporting.dashboardKpis(account.type, {
      ...scope,
      startDateTime: `${dateRange.startDate} 00:00:00`,
      endDateTime: `${dateRange.endDate} 23:59:59`,
      timezone,
    });
    const notes = [messages.notes.timezone(timezone)];
    if (result.unavailable.length > 0) notes.push(messages.notes.unavailableMetrics(result.unavailable));
    return { account: summarize(account), dateRange: { ...dateRange, timezone }, metrics: result.metrics, notes };
  }

  /** Marketplace (or super admin + customer) only. */
  async financialSummary(principal: C2cPrincipal, input: FinancialSummaryInput): Promise<FinancialSummaryOutput> {
    const account = selectAccount(principal, input.accountId);
    const timezone = this.resolveTimezone(input.timezone);
    let customerId: number;
    if (account.type === 'marketplace') {
      if (input.customerId !== undefined && input.customerId !== account.customerId) {
        throw new ToolError('NOT_AUTHORIZED', messages.errors.notAuthorized);
      }
      customerId = account.customerId!;
    } else if (account.type === 'superadmin') {
      if (input.customerId === undefined) throw invalid(messages.validation.customerRequired);
      customerId = input.customerId;
    } else {
      throw invalid(messages.validation.marketplaceOnly);
    }

    const periods = [...new Set(input.periods ?? FINANCIAL_PERIODS)];
    const rows = [];
    for (const period of periods) rows.push(await this.options.reporting.financials(customerId, period, timezone));
    return { account: summarize(account), timezone, rows, notes: [messages.notes.timezone(timezone)] };
  }

  async dailyTrend(principal: C2cPrincipal, input: ReportRangeInput): Promise<DailyTrendOutput> {
    const account = selectAccount(principal, input.accountId);
    const { dateRange, timezone } = this.resolveRange(input);
    const scope = await resolveScope(account, input, this.options.scopes);
    if (account.type === 'superadmin' && scope.customerId === null) throw invalid(messages.validation.customerRequired);

    const result = await this.options.reporting.dailyTrend({
      ...scope,
      startDateTime: `${dateRange.startDate} 00:00:00`,
      endDateTime: `${dateRange.endDate} 23:59:59`,
      timezone,
      maxRows: this.options.limits.maxRows,
    });
    return {
      account: summarize(account),
      dateRange: { ...dateRange, timezone },
      rows: result.rows.map((row) => projectTrendRow(account.type, row)),
      truncated: result.truncated,
      notes: [messages.notes.timezone(timezone), ...this.notes(result.truncated)],
    };
  }

  metricDefinitions(): MetricDefinitionsOutput {
    const { limits } = this.options;
    return {
      allowlistVersion: ALLOWLIST_VERSION,
      reports: [
        {
          tool: 'get_dashboard_kpis',
          accountTypes: ['marketplace', 'advertiser', 'publisher'],
          metrics: [
            'totalCalls',
            'billableCalls (marketplace) / paidCalls (advertiser, publisher)',
            'shortCalls, longCalls, badConnections, noOfferFound',
            'revenue and cost (marketplace), spend (advertiser), revenue (publisher payout)',
            'avgDurationSeconds (advertiser, publisher)',
          ],
        },
        { tool: 'get_financial_summary', accountTypes: ['marketplace'], metrics: ['revenue', 'cost', 'profit', 'marginPercent'] },
        {
          tool: 'get_daily_call_trend',
          accountTypes: ['marketplace', 'advertiser', 'publisher'],
          metrics: ['totalCalls', 'billableCalls', 'payableCalls', 'avgDurationSeconds', 'role-appropriate money columns'],
        },
      ],
      filters: ['accountId', 'startDate', 'endDate', 'timezone', 'verticalId', 'advertiserId', 'offerId', 'publisherId', 'campaignId'],
      limits: {
        defaultWindowDays: limits.defaultWindowDays,
        maxLookbackDays: limits.maxLookbackDays,
        maxRows: limits.maxRows,
        callsPerMinute: this.options.callsPerMinute,
      },
      defaultTimezone: this.options.defaultTimezone,
      limitations: [
        'Aggregates only: no call-level records, caller numbers, recordings, transcripts, or contact details.',
        'Only data for your own C2C accounts is returned; filters outside your accounts are refused.',
        'Billable = advertiser-billable call; payable = publisher-payable call (C2C definitions).',
        messages.notes.untrustedData,
      ],
    };
  }

  private resolveRange(input: ReportRangeInput) {
    return {
      dateRange: resolveDateRange(input, this.options.limits, this.today()),
      timezone: this.resolveTimezone(input.timezone),
    };
  }

  private resolveTimezone(requested: string | undefined): string {
    const timezone = requested ?? this.options.defaultTimezone;
    if (!isIanaTimezone(timezone)) throw invalid(messages.validation.invalidTimezone);
    return timezone;
  }

  private notes(truncated: boolean): string[] {
    const notes: string[] = [messages.notes.untrustedData];
    if (truncated) notes.push(messages.notes.truncated(this.options.limits.maxRows));
    return notes;
  }
}

/**
 * Show each account type only the money it sees in the C2C app:
 * marketplace both sides, advertisers their spend, publishers their payout (revenue).
 */
function projectTrendRow(type: AccountType, row: TrendRow): Record<string, string | number> {
  const base = {
    reportDate: row.reportDate,
    totalCalls: row.totalCalls,
    billableCalls: row.billableCalls,
    payableCalls: row.payableCalls,
    avgDurationSeconds: row.avgDurationSeconds,
  };
  switch (type) {
    case 'advertiser':
      return { ...base, spend: row.advertiserRevenue };
    case 'publisher':
      return { ...base, revenue: row.publisherPayout };
    default:
      return {
        ...base,
        revenue: row.advertiserRevenue,
        cost: row.publisherPayout,
        profit: Math.round((row.advertiserRevenue - row.publisherPayout) * 100) / 100,
      };
  }
}

function summarize(account: C2cAccount): AccountSummary {
  return { accountId: account.accountId, type: account.type, accountName: account.accountName, customerName: account.customerName };
}

function invalid(detail: string): ToolError {
  return new ToolError('INVALID_INPUT', messages.errors.invalidInput(detail));
}
