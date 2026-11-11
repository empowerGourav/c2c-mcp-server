/**
 * Versioned reporting-view contract (project-plan.md §4).
 *
 * This file is the ONLY place that names database objects. Every entry here is a *proposed*
 * contract; a view is queryable only when it is also listed in `C2C_APPROVED_VIEWS`, which
 * defaults to empty. Changes require C2C data-owner and security approval (plan §4.2).
 *
 * Rules:
 * - Views only; never base tables.
 * - Explicit columns only; no `SELECT *`.
 * - No direct identifiers, free text, or unrestricted revenue/spend fields.
 */
export const ALLOWLIST_VERSION = '2026-11-11.1';

export const VIEW_CONTRACTS = {
  campaignDaily: {
    view: 'mcp_v_campaign_daily',
    columns: ['report_date', 'campaign_ref', 'call_count', 'conversion_count'],
  },
  callOutcomeDaily: {
    view: 'mcp_v_call_outcome_daily',
    columns: ['report_date', 'campaign_ref', 'outcome_code', 'call_count'],
  },
} as const;

export type ViewContractKey = keyof typeof VIEW_CONTRACTS;

export const KNOWN_VIEW_NAMES: ReadonlySet<string> = new Set(
  Object.values(VIEW_CONTRACTS).map((contract) => contract.view),
);
