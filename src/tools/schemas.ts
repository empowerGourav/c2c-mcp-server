import { z } from 'zod';
import { messages } from '../messages.js';

/** Opaque identifiers only: no spaces, quotes, or SQL metacharacters. Bounded length. */
const OPAQUE_REF = /^[A-Za-z0-9_-]{1,64}$/;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// Inputs are strict objects: unknown fields/operators are rejected (plan §5.2).
export const campaignDailyInput = z.strictObject({
  startDate: isoDate.optional().describe(messages.fields.startDate),
  endDate: isoDate.optional().describe(messages.fields.endDate),
  campaignRef: z.string().regex(OPAQUE_REF).optional().describe(messages.fields.campaignRef),
});

export const callOutcomeInput = campaignDailyInput.extend({
  outcomeCodes: z.array(z.string().regex(OPAQUE_REF)).min(1).max(50).optional().describe(messages.fields.outcomeCodes),
});

export const metricDefinitionsInput = z.strictObject({});

export type CampaignDailyInput = z.infer<typeof campaignDailyInput>;
export type CallOutcomeInput = z.infer<typeof callOutcomeInput>;

const resultMeta = {
  dateRange: z.object({ startDate: z.string(), endDate: z.string() }),
  truncated: z.boolean(),
  suppressedGroups: z.number().int().nonnegative(),
  notes: z.array(z.string()),
};

export const campaignDailyOutput = z.object({
  ...resultMeta,
  rows: z.array(
    z.object({
      reportDate: z.string(),
      campaignRef: z.string(),
      callCount: z.number().int(),
      conversionCount: z.number().int(),
    }),
  ),
  totals: z.object({ callCount: z.number().int(), conversionCount: z.number().int() }),
});

export const callOutcomeOutput = z.object({
  ...resultMeta,
  rows: z.array(z.object({ outcomeCode: z.string(), callCount: z.number().int() })),
  totals: z.object({ callCount: z.number().int() }),
});

export const metricDefinitionsOutput = z.object({
  allowlistVersion: z.string(),
  freshness: z.string(),
  reports: z.array(
    z.object({ tool: z.string(), enabled: z.boolean(), metrics: z.array(z.string()), filters: z.array(z.string()) }),
  ),
  limits: z.object({
    defaultWindowDays: z.number(),
    maxLookbackDays: z.number(),
    maxRows: z.number(),
    minAggregateGroupSize: z.number(),
    callsPerMinute: z.number(),
  }),
  approvedOutcomeCodes: z.array(z.string()),
  limitations: z.array(z.string()),
});

export type CampaignDailyOutput = z.infer<typeof campaignDailyOutput>;
export type CallOutcomeOutput = z.infer<typeof callOutcomeOutput>;
export type MetricDefinitionsOutput = z.infer<typeof metricDefinitionsOutput>;
