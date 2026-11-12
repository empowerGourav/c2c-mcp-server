import { z } from 'zod';
import { FINANCIAL_PERIODS } from '../data/allowlist.js';
import { DIMENSION_KINDS } from '../data/scope-repository.js';
import { messages } from '../messages.js';

const id = z.number().int().positive().max(2_147_483_647);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timezone = z.string().min(1).max(64).regex(/^[A-Za-z0-9_+/-]+$/);

const accountField = { accountId: id.optional().describe(messages.fields.accountId) };

// Inputs are strict objects: unknown fields/operators are rejected (plan §5.2).
const reportFilters = {
  customerId: id.optional().describe(messages.fields.customerId),
  verticalId: id.optional().describe(messages.fields.verticalId),
  advertiserId: id.optional().describe(messages.fields.advertiserId),
  offerId: id.optional().describe(messages.fields.offerId),
  publisherId: id.optional().describe(messages.fields.publisherId),
  campaignId: id.optional().describe(messages.fields.campaignId),
};

export const listAccountsInput = z.strictObject({});

export const listDimensionsInput = z.strictObject({
  ...accountField,
  kind: z.enum(DIMENSION_KINDS).describe(messages.fields.dimensionKind),
  nameContains: z.string().trim().min(1).max(100).optional().describe(messages.fields.nameContains),
  customerId: reportFilters.customerId,
});

export const reportRangeInput = z.strictObject({
  ...accountField,
  startDate: isoDate.optional().describe(messages.fields.startDate),
  endDate: isoDate.optional().describe(messages.fields.endDate),
  timezone: timezone.optional().describe(messages.fields.timezone),
  ...reportFilters,
});

export const financialSummaryInput = z.strictObject({
  ...accountField,
  customerId: reportFilters.customerId,
  timezone: timezone.optional().describe(messages.fields.timezone),
  periods: z.array(z.enum(FINANCIAL_PERIODS)).min(1).max(4).optional().describe(messages.fields.periods),
});

export const metricDefinitionsInput = z.strictObject({});

export type ListDimensionsInput = z.infer<typeof listDimensionsInput>;
export type ReportRangeInput = z.infer<typeof reportRangeInput>;
export type FinancialSummaryInput = z.infer<typeof financialSummaryInput>;

const accountSummary = z.object({
  accountId: z.number(),
  type: z.string(),
  accountName: z.string().nullable(),
  customerName: z.string().nullable(),
});

export const listAccountsOutput = z.object({ accounts: z.array(accountSummary) });

export const listDimensionsOutput = z.object({
  account: accountSummary,
  kind: z.string(),
  rows: z.array(z.object({ id: z.number(), name: z.string() })),
  truncated: z.boolean(),
  notes: z.array(z.string()),
});

const appliedRange = z.object({ startDate: z.string(), endDate: z.string(), timezone: z.string() });

export const dashboardKpisOutput = z.object({
  account: accountSummary,
  dateRange: appliedRange,
  metrics: z.record(z.string(), z.number().nullable()),
  notes: z.array(z.string()),
});

export const financialSummaryOutput = z.object({
  account: accountSummary,
  timezone: z.string(),
  rows: z.array(
    z.object({
      period: z.string(),
      revenue: z.number(),
      cost: z.number(),
      profit: z.number(),
      marginPercent: z.number().nullable(),
    }),
  ),
  notes: z.array(z.string()),
});

export const dailyTrendOutput = z.object({
  account: accountSummary,
  dateRange: appliedRange,
  rows: z.array(z.record(z.string(), z.union([z.string(), z.number()]))),
  truncated: z.boolean(),
  notes: z.array(z.string()),
});

export const metricDefinitionsOutput = z.object({
  allowlistVersion: z.string(),
  reports: z.array(z.object({ tool: z.string(), accountTypes: z.array(z.string()), metrics: z.array(z.string()) })),
  filters: z.array(z.string()),
  limits: z.object({
    defaultWindowDays: z.number(),
    maxLookbackDays: z.number(),
    maxRows: z.number(),
    callsPerMinute: z.number(),
  }),
  defaultTimezone: z.string(),
  limitations: z.array(z.string()),
});

export type AccountSummary = z.infer<typeof accountSummary>;
export type ListAccountsOutput = z.infer<typeof listAccountsOutput>;
export type ListDimensionsOutput = z.infer<typeof listDimensionsOutput>;
export type DashboardKpisOutput = z.infer<typeof dashboardKpisOutput>;
export type FinancialSummaryOutput = z.infer<typeof financialSummaryOutput>;
export type DailyTrendOutput = z.infer<typeof dailyTrendOutput>;
export type MetricDefinitionsOutput = z.infer<typeof metricDefinitionsOutput>;

export const callLogInput = reportRangeInput.extend({
  billable: z.boolean().optional().describe(messages.fields.billable),
  scrubbed: z.boolean().optional().describe(messages.fields.scrubbed),
  callTagIds: z.array(id).min(1).max(50).optional().describe(messages.fields.callTagIds),
  page: z.number().int().min(1).max(10_000).optional().describe(messages.fields.page),
  pageSize: z.number().int().min(1).max(100).optional().describe(messages.fields.pageSize),
});

export type CallLogInput = z.infer<typeof callLogInput>;

export const callLogOutput = z.object({
  account: accountSummary,
  dateRange: appliedRange,
  page: z.number(),
  pageSize: z.number(),
  totalCount: z.number(),
  rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()]))),
  notes: z.array(z.string()),
});

export type CallLogOutput = z.infer<typeof callLogOutput>;
