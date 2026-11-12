/**
 * Reviewed database contract: the ONLY database objects this service may touch.
 *
 * Source of truth is the live C2C Aurora MySQL schema as used by api-callstoconvert / ui-callstoconvert
 * (the Laravel apps). All procedures listed here are the read-only `*Replica` reporting procedures the
 * Laravel dashboards already call against the reader endpoint. Procedures that write or have side effects
 * (e.g. adjustReturnScrubCalls, insertSuppressionlist, getAIScheduledAgentsNextHour) are deliberately absent.
 *
 * Any change here needs data-owner + security review (bump ALLOWLIST_VERSION and docs/db-contract.md).
 */
export const ALLOWLIST_VERSION = '2026-11-12.1';

export type AccountType = 'marketplace' | 'advertiser' | 'publisher' | 'superadmin';

/** Scope + filter values handed to a KPI procedure builder. `null` is only ever used for unset optional filters. */
export interface KpiArgs {
  startDateTime: string;
  endDateTime: string;
  timezone: string;
  customerId: number | null;
  advertiserId: number | null;
  publisherId: number | null;
  verticalId: number | null;
  offerId: number | null;
  campaignId: number | null;
}

export interface KpiProcedure {
  metric: string;
  procedure: string;
  /** Result column holding the value, when known from the Laravel callers. */
  column?: string;
  args: (a: KpiArgs) => (string | number | null)[];
}

// Parameter orders copied from the Laravel controllers (API Customer/Advertiser/Publisher DashboardController).
const marketplaceArgs = (a: KpiArgs) => [
  a.startDateTime, a.endDateTime, a.customerId, a.verticalId, a.advertiserId, a.offerId, a.publisherId, a.campaignId, a.timezone,
];
const advertiserArgs = (a: KpiArgs) => [a.startDateTime, a.endDateTime, a.advertiserId, a.verticalId, a.offerId, a.customerId, a.timezone];
const advertiserArgsNoTz = (a: KpiArgs) => [a.startDateTime, a.endDateTime, a.advertiserId, a.verticalId, a.offerId, a.customerId];
const publisherArgs = (a: KpiArgs) => [a.startDateTime, a.endDateTime, a.publisherId, a.verticalId, a.campaignId, a.customerId, a.timezone];

const MARKETPLACE_KPIS: KpiProcedure[] = [
  { metric: 'totalCalls', procedure: 'getCustomerDashboardTotalCallsReplica', column: 'total_calls', args: marketplaceArgs },
  { metric: 'billableCalls', procedure: 'getCustomerDashboardBillableCallsReplica', column: 'billable_calls', args: marketplaceArgs },
  { metric: 'shortCalls', procedure: 'getCustomerDashboardShortCallsReplica', column: 'short_calls', args: marketplaceArgs },
  { metric: 'longCalls', procedure: 'getCustomerDashboardLongCallsReplica', column: 'long_calls', args: marketplaceArgs },
  { metric: 'revenue', procedure: 'getCustomerDashboardCallRevenueReplica', column: 'call_revenue', args: marketplaceArgs },
  { metric: 'cost', procedure: 'getCustomerDashboardCallCostReplica', column: 'call_cost', args: marketplaceArgs },
  {
    metric: 'badConnections',
    procedure: 'getCustomerDashboardBadConnectionReplica',
    column: 'total_bad_connection_call',
    args: marketplaceArgs,
  },
  { metric: 'noOfferFound', procedure: 'getCustomerDashboardNoOffersFoundReplica', column: 'no_offer_found', args: marketplaceArgs },
];

const ADVERTISER_KPIS: KpiProcedure[] = [
  { metric: 'totalCalls', procedure: 'getAdvertiserDashboardTotalCallsReplica', args: advertiserArgs },
  { metric: 'paidCalls', procedure: 'getAdvertiserDashboardPaidCallsReplica', args: advertiserArgs },
  { metric: 'spend', procedure: 'getAdvertiserDashboardSpendReplica', args: advertiserArgs },
  { metric: 'avgDurationSeconds', procedure: 'getAdvertiserDashboardAvgDurationReplica', args: advertiserArgs },
  { metric: 'shortCalls', procedure: 'getAdvertiserDashboardShortCallsReplica', args: advertiserArgs },
  { metric: 'longCalls', procedure: 'getAdvertiserDashboardLongCallsReplica', args: advertiserArgs },
  { metric: 'badConnections', procedure: 'getAdvertiserDashboardBadConnectionsReplica', args: advertiserArgs },
  { metric: 'noOfferFound', procedure: 'getAdvertiserDashboardNoOfferFoundReplica', args: advertiserArgsNoTz },
];

const PUBLISHER_KPIS: KpiProcedure[] = [
  { metric: 'totalCalls', procedure: 'getPublisherDashboardTotalCallsReplica', args: publisherArgs },
  { metric: 'paidCalls', procedure: 'getPublisherDashboardPaidCallsReplica', args: publisherArgs },
  { metric: 'revenue', procedure: 'getPublisherDashboardRevenueReplica', args: publisherArgs },
  { metric: 'avgDurationSeconds', procedure: 'getPublisherDashboardAvgDurationReplica', args: publisherArgs },
  { metric: 'shortCalls', procedure: 'getPublisherDashboardShortCallsReplica', args: publisherArgs },
  { metric: 'longCalls', procedure: 'getPublisherDashboardLongCallsReplica', args: publisherArgs },
  { metric: 'noOfferFound', procedure: 'getPublisherDashboardNoOffersFoundReplica', args: publisherArgs },
  { metric: 'badConnections', procedure: 'getPublisherDashboardBadConnectionReplica', args: publisherArgs },
];

export const KPI_PROCEDURES: Record<AccountType, KpiProcedure[]> = {
  marketplace: MARKETPLACE_KPIS,
  superadmin: MARKETPLACE_KPIS,
  advertiser: ADVERTISER_KPIS,
  publisher: PUBLISHER_KPIS,
};

/** `getCustomerDashboardFinancialsReplica(customerId, period, tz)` → `call_revenue`, `call_cost`. */
export const FINANCIALS_PROCEDURE = 'getCustomerDashboardFinancialsReplica';
export const FINANCIAL_PERIODS = ['MTD', 'LM', 'YTD', 'LY'] as const;
export type FinancialPeriod = (typeof FINANCIAL_PERIODS)[number];

/**
 * Call log: `getCallLogReportReplica` (23 positional params, Laravel API Customer/ReportController::index).
 * This procedure likely builds dynamic SQL from its string params, so binding alone is not enough: every
 * free-text param (search, errorType, sales_rep, intelligence) is passed as a fixed constant, never caller input.
 */
export const CALL_LOG_PROCEDURE = 'getCallLogReportReplica';

export interface CallLogArgs {
  startDateTime: string;
  endDateTime: string;
  timezone: string;
  customerId: number | null;
  publisherId: number | null;
  advertiserId: number | null;
  campaignId: number | null;
  verticalId: number | null;
  offerId: number | null;
  /** 1 = advertiser-billable only, 0 = non-billable only, null = all (the UI "billable" filter). */
  billable: 0 | 1 | null;
  /** 1 = scrubbed only, 0 = not scrubbed, null = all. */
  scrubbed: 0 | 1 | null;
  /** Validated comma-separated integers or ''. */
  callTagIds: string;
  offset: number;
  limit: number;
}

export function callLogArgs(a: CallLogArgs): (string | number | null)[] {
  return [
    a.startDateTime,
    a.endDateTime,
    '', // search: never caller-supplied
    a.customerId,
    a.publisherId,
    a.advertiserId,
    a.campaignId,
    a.verticalId,
    a.billable,
    null, // is_returned: returned calls use a different procedure (not exposed)
    a.scrubbed,
    a.timezone,
    'Any', // intelligence: the UI always sends 'Any' when no moment filter is chosen ('null' matches nothing)
    a.offset,
    a.limit,
    '', // errorType
    a.callTagIds,
    a.offerId,
    '', // is_agent
    null, // agent_tier
    '', // sales_rep
    null, // ivr_id
    2, // is_voiceaiq: 2 = both Observe and VoiceAIQ (no filter), as the admin call log passes
  ];
}

/**
 * Result columns of the call log that may be returned, by audience. Everything else the procedure returns —
 * Recording_URL, Called_DID, Transferred_To, Single_Caller_Phone_Number, zip codes, call_summary,
 * Reason_to_Return, ping IDs, rates — is dropped. `Caller` is only ever returned masked to its last 4 digits.
 */
export const CALL_LOG_COLUMNS = {
  common: {
    Id: 'callId',
    Timestamp: 'timestamp',
    Vertical: 'vertical',
    Call_Status: 'callStatus',
    Total_Call_Duration: 'durationSeconds',
    Returned: 'returned',
    Scrubbed: 'scrubbed',
    Error: 'error',
    Ping_State: 'callerState',
    DUP: 'duplicate',
  },
  marketplace: {
    Marketplace_Name: 'marketplace',
    Advertiser_Name: 'advertiser',
    Offer_Name: 'offer',
    Publisher_Name: 'publisher',
    Campaign_Name: 'campaign',
    Marketplace_Billable: 'billable',
    Publisher_Billable: 'payable',
    Revenue: 'revenue',
    Publisher_Payout: 'publisherPayout',
  },
  advertiser: {
    Advertiser_Name: 'advertiser',
    Offer_Name: 'offer',
    Marketplace_Billable: 'billable',
    Revenue: 'cost',
  },
  publisher: {
    Publisher_Name: 'publisher',
    Campaign_Name: 'campaign',
    Publisher_Billable: 'payable',
    Publisher_Payout: 'revenue',
  },
} as const;

export const ALL_PROCEDURES: ReadonlySet<string> = new Set([
  FINANCIALS_PROCEDURE,
  CALL_LOG_PROCEDURE,
  ...Object.values(KPI_PROCEDURES).flatMap((list) => list.map((entry) => entry.procedure)),
]);

/**
 * Tables and the only columns read from them (for the DB GRANT and review). Deliberately excludes every
 * phone, name, email, address, recording, transcript, free-text, token, and raw JSON payload column.
 */
export const TABLE_COLUMNS = {
  users: ['id', 'email', 'status', 'time_zone'],
  user_role_association: ['id', 'user_id', 'customer_id', 'advertiser_id', 'publisher_id', 'role_id', 'user_type_id', 'status'],
  customers: ['id', 'company_name', 'status'],
  advertisers: ['id', 'customer_id', 'company_name', 'status'],
  publishers: ['id', 'customer_id', 'company_name', 'status'],
  offers: ['id', 'customer_id', 'advertiser_id', 'offer_name', 'status', 'is_deleted'],
  campaigns: ['id', 'customer_id', 'publisher_id', 'vertical_id', 'campaign_name', 'status', 'is_deleted'],
  verticals: ['id', 'name', 'status'],
  calls: ['id', 'campaign_id', 'offer_id', 'created_at', 'is_billable', 'is_payable', 'call_duration', 'customer_revenue', 'publisher_payout'],
} as const;

/** Numeric status codes from the shared `status` lookup (see Laravel CommonController). */
export const STATUS_ACTIVE = 8;
export const STATUS_DELETED = 5;
export const USER_TYPE = { customer: 1, advertiser: 2, publisher: 3 } as const;
export const SUPER_ADMIN_ROLE_ID = 1;

/**
 * `users.time_zone` holds an abbreviation chosen in C2C preferences (EST/MST/CST/PST). Laravel converts it with
 * PHP's timezone_name_from_abbr and defaults an empty value to EST; these are the same mappings.
 */
export const USER_TIMEZONES: Readonly<Record<string, string>> = {
  EST: 'America/New_York',
  CST: 'America/Chicago',
  MST: 'America/Denver',
  PST: 'America/Los_Angeles',
};
export const DEFAULT_USER_TIMEZONE = 'America/New_York';
