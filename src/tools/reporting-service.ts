import type { C2cPrincipal } from '../auth/principal.js';
import type { AppConfig, QueryLimits } from '../config.js';
import { ALLOWLIST_VERSION, VIEW_CONTRACTS } from '../data/allowlist.js';
import type { ReportingRepository } from '../data/reporting-repository.js';
import { ToolError } from '../errors.js';
import { messages } from '../messages.js';
import { resolveDateRange } from './date-range.js';
import type {
  CallOutcomeInput,
  CallOutcomeOutput,
  CampaignDailyInput,
  CampaignDailyOutput,
  MetricDefinitionsOutput,
} from './schemas.js';

export interface ReportingServiceOptions {
  repository: ReportingRepository;
  limits: QueryLimits;
  reporting: AppConfig['reporting'];
  callsPerMinute: number;
  /** Injected for tests. */
  today?: () => Date;
}

/**
 * Business rules for each tool: view approval, row-scope authorization, date bounds,
 * minimum-group suppression, and truncation notes. Independent of MCP transport concerns.
 */
export class ReportingService {
  private readonly today: () => Date;

  constructor(private readonly options: ReportingServiceOptions) {
    this.today = options.today ?? (() => new Date());
  }

  /** @throws {ToolError} On unapproved view, unauthorized campaign, or invalid dates. */
  async campaignDailySummary(principal: C2cPrincipal, input: CampaignDailyInput): Promise<CampaignDailyOutput> {
    this.ensureApproved(VIEW_CONTRACTS.campaignDaily.view);
    const dateRange = resolveDateRange(input, this.options.limits, this.today());
    const campaignRefs = authorizeCampaigns(principal, input.campaignRef);

    const result = await this.options.repository.campaignDailySummary({
      ...dateRange,
      campaignRefs,
      maxRows: this.options.limits.maxRows,
    });
    const minGroup = this.options.limits.minAggregateGroupSize;
    const rows = result.rows.filter((row) => row.callCount >= minGroup);
    const suppressedGroups = result.rows.length - rows.length;

    return {
      dateRange,
      rows,
      totals: {
        callCount: sum(rows.map((row) => row.callCount)),
        conversionCount: sum(rows.map((row) => row.conversionCount)),
      },
      truncated: result.truncated,
      suppressedGroups,
      notes: this.buildNotes(result.truncated, suppressedGroups),
    };
  }

  /** @throws {ToolError} On unapproved view/outcome codes, unauthorized campaign, or invalid dates. */
  async callOutcomeSummary(principal: C2cPrincipal, input: CallOutcomeInput): Promise<CallOutcomeOutput> {
    this.ensureApproved(VIEW_CONTRACTS.callOutcomeDaily.view);
    const approvedCodes = this.options.reporting.outcomeCodes;
    if (approvedCodes.length === 0) throw new ToolError('VIEW_NOT_APPROVED', messages.errors.viewNotApproved);

    const requestedCodes = input.outcomeCodes ?? approvedCodes;
    if (requestedCodes.some((code) => !approvedCodes.includes(code))) {
      throw new ToolError('INVALID_INPUT', messages.errors.invalidInput(messages.validation.unknownOutcomeCode));
    }
    const dateRange = resolveDateRange(input, this.options.limits, this.today());
    const campaignRefs = authorizeCampaigns(principal, input.campaignRef);

    const result = await this.options.repository.callOutcomeSummary({
      ...dateRange,
      campaignRefs,
      outcomeCodes: [...new Set(requestedCodes)],
      maxRows: this.options.limits.maxRows,
    });
    const minGroup = this.options.limits.minAggregateGroupSize;
    const rows = result.rows.filter((row) => row.callCount >= minGroup);
    const suppressedGroups = result.rows.length - rows.length;

    return {
      dateRange,
      rows,
      totals: { callCount: sum(rows.map((row) => row.callCount)) },
      truncated: result.truncated,
      suppressedGroups,
      notes: this.buildNotes(result.truncated, suppressedGroups),
    };
  }

  /** Describe capabilities without revealing schema or database metadata. */
  metricDefinitions(): MetricDefinitionsOutput {
    const { limits, reporting } = this.options;
    const approved = reporting.approvedViews;
    return {
      allowlistVersion: ALLOWLIST_VERSION,
      freshness: reporting.freshnessNote,
      reports: [
        {
          tool: 'get_campaign_daily_summary',
          enabled: approved.has(VIEW_CONTRACTS.campaignDaily.view),
          metrics: ['callCount: calls recorded for the campaign on the day', 'conversionCount: calls that converted'],
          filters: ['startDate', 'endDate', 'campaignRef'],
        },
        {
          tool: 'get_call_outcome_summary',
          enabled: approved.has(VIEW_CONTRACTS.callOutcomeDaily.view) && reporting.outcomeCodes.length > 0,
          metrics: ['callCount: calls with the given outcome over the date range'],
          filters: ['startDate', 'endDate', 'campaignRef', 'outcomeCodes'],
        },
      ],
      limits: {
        defaultWindowDays: limits.defaultWindowDays,
        maxLookbackDays: limits.maxLookbackDays,
        maxRows: limits.maxRows,
        minAggregateGroupSize: limits.minAggregateGroupSize,
        callsPerMinute: this.options.callsPerMinute,
      },
      approvedOutcomeCodes: [...reporting.outcomeCodes],
      limitations: [
        'Aggregates only: no call-level records, contact details, recordings, or free text.',
        'Only campaigns you are authorized for are included.',
        `Groups with fewer than ${limits.minAggregateGroupSize} calls are withheld.`,
        messages.notes.untrustedData,
      ],
    };
  }

  private ensureApproved(view: string): void {
    if (!this.options.reporting.approvedViews.has(view)) {
      throw new ToolError('VIEW_NOT_APPROVED', messages.errors.viewNotApproved);
    }
  }

  private buildNotes(truncated: boolean, suppressedGroups: number): string[] {
    const notes: string[] = [messages.notes.untrustedData];
    if (truncated) notes.push(messages.notes.truncated(this.options.limits.maxRows));
    if (suppressedGroups > 0) {
      notes.push(messages.notes.suppressed(suppressedGroups, this.options.limits.minAggregateGroupSize));
    }
    return notes;
  }
}

/**
 * Narrow the query scope to what the principal may see. A requested campaign outside the
 * principal's scope is refused with the same message whether or not it exists.
 */
function authorizeCampaigns(principal: C2cPrincipal, requested: string | undefined): string[] {
  if (requested === undefined) return [...principal.campaignRefs];
  if (!principal.campaignRefs.has(requested)) throw new ToolError('NOT_AUTHORIZED', messages.errors.notAuthorized);
  return [requested];
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
