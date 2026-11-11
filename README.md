# c2c-mcp-server

A read-only [Model Context Protocol](https://modelcontextprotocol.io) server. It lets authenticated Claude clients ask about
their own Calls-to-Convert (C2C) reporting data, read straight from the **existing C2C Aurora MySQL** database: the same
tables and `*Replica` stored procedures that the C2C dashboards use, on the reader endpoint.

The tools are fixed and typed. There is no SQL from callers, no schema discovery, no call-level records, and no writes.
Background: `D:\Visiqua\calls-to-convert\.azure\project-plan.md`. Database details: `docs/db-contract.md`.

## Status

| Area | State |
|---|---|
| MCP service, OAuth, rate limits, audit logging | Implemented and tested |
| Data source | Live C2C schema on the Aurora MySQL reader: 9 tables (column-level) and 25 read-only dashboard procedures |
| Identity → C2C scope | Token e-mail → `users` → `user_role_association`, the same model as the Laravel login |
| OAuth issuer | **To be confirmed** (any OIDC issuer with JWKS; must emit an e-mail claim) |
| Hosting | **To be decided.** The plan assumed Azure, but the DB is on AWS (see below) |

## Tools

| Tool | Account types | What it returns |
|---|---|---|
| `list_my_accounts` | all | The C2C accounts the user holds (marketplace / advertiser / publisher) |
| `list_dimensions` | all | IDs and names of verticals, advertisers, publishers, offers or campaigns visible to the account |
| `get_dashboard_kpis` | all | The dashboard KPIs from the account type's `*Replica` procedures: total, billable/paid, short and long calls, bad connections, no-offer-found, and revenue/cost/spend |
| `get_financial_summary` | marketplace | Revenue, cost, profit and margin for MTD, LM, YTD and LY |
| `get_daily_call_trend` | all | Daily calls, billable and payable calls, average duration, and the money columns that role sees in the app |
| `get_metric_definitions` | all | The available reports, filters and limits |

All tools are annotated `readOnlyHint: true`, and their inputs are strict.

## How scoping works

The C2C API trusts customer, advertiser and publisher IDs from the request, and its procedures widen to all rows on `NULL`.
This server does not:

```
Claude ──HTTPS──▶ /mcp
  ├─ Bearer JWT: signature (issuer JWKS), iss, aud, exp, alg, scopes        → 401 / 403
  ├─ email claim → users (status 8) → user_role_association (status 8)      → 403 if none / ambiguous
  └─ per tool call
       ├─ account = one of the user's associations (accountId), never a free ID
       ├─ owner key (customer / advertiser / publisher) injected from that row, never NULL
       ├─ every filter ID checked in the DB to belong to that owner         → refused otherwise
       ├─ procedure / fixed SELECT with bound params on a READ ONLY session, 5 s limit + KILL QUERY
       └─ role-appropriate money only: advertisers see spend, publishers see their payout
```

Super admins (`users.role_id = 1`) are refused unless `ALLOW_SUPER_ADMIN=true`.

Other limits:

- Dates: a 30-day default window and 90-day maximum lookback.
- Responses: at most 500 rows and 128 KiB.
- Rate: 30 calls per minute per user, with per-user and global concurrency caps.
- Audit log: metadata only, with hashed identities.

## Develop

```bash
npm ci
cp .env.example .env            # fill in values; never commit .env
npm test                        # unit + end-to-end MCP client tests (no DB/IdP needed)
npm run typecheck
npm run grants -- c2c mcp_reporting_reader '10.%'   # GRANTs for the DB user
npm run dev                     # needs a reachable OIDC issuer and the Aurora reader
```

Node.js 24 LTS or newer is required.

## Container

```bash
docker build -t c2c-mcp-server .
```

- The image runs as a non-root user on `0.0.0.0:8080`, so set `ALLOWED_HOSTS` to the public hostname.
- It ships the AWS RDS CA bundle and sets `DB_SSL_CA_PATH` to it.
- Supply `DB_PASSWORD` and `AUDIT_HASH_SALT` from a secret store.
- Probes: `GET /healthz` (liveness) and `GET /readyz` (DB reachability).

## Open decisions

1. **Hosting.** Aurora runs on AWS, but the plan assumed Azure Container Apps with private DB networking. Running in the
   Aurora VPC (ECS Fargate or App Runner, same region) keeps the DB private. Azure would need a site-to-site VPN or a public DB endpoint.
2. **OAuth issuer.** Laravel Passport has no OIDC discovery, so another OIDC issuer is needed (for example Entra ID or Cognito). Its
   e-mail claim must match `users.email`.
3. **Call-level reports.** The call log (`getCallLogReportReplica`) is not exposed because it returns caller numbers, recordings
   and agent details. Adding it would need an explicit column projection and sign-off.
4. **API Management.** Rate limits are per replica today, so a shared gateway is needed when running more than one instance.
