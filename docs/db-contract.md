# Reporting database contract (proposed, not yet approved)

Status: **awaiting C2C data-owner and security sign-off** (project-plan.md §4, §11 decision 2).
Until then `C2C_APPROVED_VIEWS` stays empty and every data tool answers "not yet enabled".

The view names and columns below match `src/data/allowlist.ts`. The view *bodies* must be written by
the C2C data owner against the confirmed production schema. This service never sees base tables.

## Views

| View | Column | Type | Meaning |
|---|---|---|---|
| `mcp_v_campaign_daily` | `report_date` | `DATE` | Reporting day (UTC — confirm) |
| | `campaign_ref` | `VARCHAR(64)` | Opaque, approved campaign identifier — not a name |
| | `call_count` | `INT UNSIGNED` | Calls on that day |
| | `conversion_count` | `INT UNSIGNED` | Converted calls on that day |
| `mcp_v_call_outcome_daily` | `report_date` | `DATE` | Reporting day |
| | `campaign_ref` | `VARCHAR(64)` | Opaque campaign identifier |
| | `outcome_code` | `VARCHAR(64)` | Value from the approved enumeration (`C2C_OUTCOME_CODES`) |
| | `call_count` | `INT UNSIGNED` | Calls with that outcome on that day |

Each view must already be aggregated to at most one row per (`report_date`, `campaign_ref`[, `outcome_code`])
and must never expose names, phone numbers, emails, addresses, recordings, transcripts, free text,
revenue/spend, or caller/device identifiers.

## Least-privilege principal (MySQL template)

```sql
CREATE USER 'mcp_reporting_reader'@'<container-app-subnet>' IDENTIFIED BY '<from Key Vault>' REQUIRE SSL;
GRANT SELECT ON c2c_reporting.mcp_v_campaign_daily     TO 'mcp_reporting_reader'@'<container-app-subnet>';
GRANT SELECT ON c2c_reporting.mcp_v_call_outcome_daily TO 'mcp_reporting_reader'@'<container-app-subnet>';
-- No other grants: no table access, no EXECUTE, no SHOW VIEW, no global privileges.
```

Views should be defined with `SQL SECURITY DEFINER` by an owner account so the reader needs no
base-table grants. The integration test suite (plan §9) must prove writes, DDL, `information_schema`
enumeration beyond granted objects, and unapproved objects are all refused for this principal.

## Change control

1. Propose the view/column change in a PR touching `src/data/allowlist.ts` (bump `ALLOWLIST_VERSION`) and this file.
2. Obtain data-owner + security approval on the PR.
3. DBA deploys the view and grant; operations adds the view to `C2C_APPROVED_VIEWS`.
