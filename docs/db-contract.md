# Database contract — C2C Aurora MySQL

The service reads the **existing** C2C schema on the Aurora MySQL **reader endpoint**, the same one the Laravel `replicaDB`
connection uses (`REPLICATE_DB_HOST`). There is no new schema, no views, no copying, and no migration.

`src/data/allowlist.ts` is the source of truth for every object the service touches. The schema was inferred from
`api-callstoconvert` and `ui-callstoconvert` (models, raw SQL, procedure calls). The procedures are not defined in either
repository, so the signatures below come from the Laravel callers.

## Least-privilege user

Generate the GRANTs from the allowlist so they cannot drift:

```bash
npm run grants -- <database> mcp_reporting_reader '<app-subnet-pattern>'
```

```sql
CREATE USER 'mcp_reporting_reader'@'<app-subnet-pattern>' IDENTIFIED BY '<from secret store>' REQUIRE SSL;
-- then apply the generated statements: column-level SELECT on 9 tables + EXECUTE on 25 procedures.
-- Nothing else: no table-wide SELECT, no SHOW VIEW, no PROCESS, no global privileges.
```

MySQL procedures default to `SQL SECURITY DEFINER`, so EXECUTE is enough. For any procedure created as
`SQL SECURITY INVOKER`, the user also needs SELECT on the tables that procedure reads. Check with:

```sql
SELECT ROUTINE_NAME, SECURITY_TYPE
FROM information_schema.ROUTINES
WHERE ROUTINE_SCHEMA = '<database>' AND ROUTINE_NAME LIKE 'get%Replica';
```

**Runtime guards.** These apply on top of the GRANTs, in `src/data/database.ts`:

- Every session is `SET SESSION TRANSACTION READ ONLY`. A procedure that tries to write fails, even under DEFINER rights.
- `MAX_EXECUTION_TIME` (5 s) applies to top-level SELECTs.
- Every statement also has a client timeout. When it fires, the service runs `KILL QUERY` on that thread and discards the connection. This covers statements inside procedures.
- Prepared statements only. Values are always bound and never concatenated, unlike the Laravel callers.
- `multipleStatements` is disabled, and TLS is verified against the AWS RDS CA bundle.

## Stored procedures (all read-only `*Replica` dashboard procedures)

| Account type | Procedures | Arguments (in order) |
|---|---|---|
| Marketplace (customer) | `getCustomerDashboard{TotalCalls,BillableCalls,ShortCalls,LongCalls,CallRevenue,CallCost,BadConnection,NoOffersFound}Replica` | `start, end, customer, vertical, advertiser, offer, publisher, campaign, tz` |
| Marketplace | `getCustomerDashboardFinancialsReplica` | `customer, 'MTD'\|'LM'\|'YTD'\|'LY', tz` |
| Advertiser | `getAdvertiserDashboard{TotalCalls,PaidCalls,Spend,AvgDuration,ShortCalls,LongCalls,BadConnections}Replica` | `start, end, advertiser, vertical, offer, customer, tz` |
| Advertiser | `getAdvertiserDashboardNoOfferFoundReplica` | same, **without** `tz` |
| Publisher | `getPublisherDashboard{TotalCalls,PaidCalls,Revenue,AvgDuration,ShortCalls,LongCalls,NoOffersFound,BadConnection}Replica` | `start, end, publisher, vertical, campaign, customer, tz` |

- Dates are passed as `'YYYY-MM-DD 00:00:00'` and `'YYYY-MM-DD 23:59:59'`, and `tz` as an IANA name, both exactly as Laravel passes them.
- In the C2C app, passing `NULL` for customer, advertiser or publisher widens a procedure to all rows. **This service never passes NULL for the caller's own scope key.** Those IDs come from `user_role_association`, never from tool arguments.

**Deliberately excluded:**

- Procedures that write or have side effects: `adjustReturnScrubCalls`, `insertSuppressionlist`, `insertBlacklist`, and `getAIScheduledAgentsNextHour`/`getRedialAi…`, which place outbound calls.
- Call-routing hot-path procedures such as `getCampaignDetails` and `checkDuplicateCaller`.
- Call-level reports such as `getCallLogReportReplica`, which return caller numbers, recordings and agent details.

## Tables (column-level)

| Table | Columns read | Purpose |
|---|---|---|
| `users` | id, email, status, role_id | Map the token e-mail to a C2C user (status 8 = active, role 1 = super admin) |
| `user_role_association` | id, user_id, customer_id, advertiser_id, publisher_id, role_id, user_type_id, status | The user's accounts and row scope (type 1 customer, 2 advertiser, 3 publisher) |
| `customers`, `advertisers`, `publishers` | id, customer_id, company_name, status | Account names, ownership checks, filter lists |
| `offers` | id, customer_id, advertiser_id, offer_name, status, is_deleted | Ownership checks, filter lists |
| `campaigns` | id, customer_id, publisher_id, vertical_id, campaign_name, status, is_deleted | Ownership checks, filter lists, trend scope |
| `verticals` | id, name, status | Filter list |
| `calls` | id, campaign_id, offer_id, created_at, is_billable, is_payable, call_duration, customer_revenue, publisher_payout | Daily trend aggregates only |

**Never read:**

- Phone numbers (`caller_number`, `to_number`, `tracking_did`, …), agent names and addresses, and geography.
- `recording_url`, transcripts and AI summaries.
- Raw JSON payloads (`publisher_ping_data`, `campaign_data`, …).
- Tokens and API keys, and anything else not listed above.

## Change control

1. Change `src/data/allowlist.ts`, bump `ALLOWLIST_VERSION`, and update this file in the same PR.
2. Get data-owner and security review on the PR.
3. The DBA re-runs `npm run grants` and applies the difference.
