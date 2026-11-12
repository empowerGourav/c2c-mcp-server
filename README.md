# c2c-mcp-server

A read-only [Model Context Protocol](https://modelcontextprotocol.io) server. It lets authenticated Claude clients ask about
their own Calls-to-Convert (C2C) reporting data, read straight from the **existing C2C Aurora MySQL** database: the same
tables and `*Replica` stored procedures that the C2C dashboards use, on the reader endpoint.

The tools are fixed and typed. There is no SQL from callers, no schema discovery, and no writes. Call-level data is
limited to a masked call log.
Background: `D:\Visiqua\calls-to-convert\.azure\project-plan.md`. Database details: `docs/db-contract.md`.

## Status

| Area | State |
|---|---|
| MCP service, OAuth, rate limits, audit logging | Implemented and tested |
| Data source | Live C2C schema on the Aurora MySQL reader: 9 tables (column-level) and 26 read-only procedures (dashboards and call log) |
| Identity → C2C scope | Token e-mail → `users` → `user_role_association`, the same model as the Laravel login |
| Authentication | `AUTH_MODE=static`: fixed bearer tokens mapped to C2C e-mails (interim). `AUTH_MODE=oauth`: any OIDC issuer |
| Hosting | AWS (deployment plan next); local testing: `docs/local-testing.md` |

## Tools

| Tool | Account types | What it returns |
|---|---|---|
| `list_my_accounts` | all | The C2C accounts the user holds (marketplace / advertiser / publisher) |
| `list_dimensions` | all | IDs and names of verticals, advertisers, publishers, offers or campaigns visible to the account |
| `get_dashboard_kpis` | all | The dashboard KPIs from the account type's `*Replica` procedures: total, billable/paid, short and long calls, bad connections, no-offer-found, and revenue/cost/spend |
| `get_financial_summary` | marketplace | Revenue, cost, profit and margin for MTD, LM, YTD and LY |
| `get_daily_call_trend` | all | Daily calls, billable and payable calls, average duration, and the money columns that role sees in the app |
| `get_call_log` | all | Paged individual calls: time, vertical, status, duration, billable/payable, returned/scrubbed, error tag, caller state, masked caller (`***-***-1234`), and role-appropriate names and money |
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

See `docs/local-testing.md` for the full walkthrough (DB tunnel, credentials, Claude Code / MCP Inspector).

```bash
npm ci
cp .env.example .env            # fill in values; never commit .env
npm test                        # unit + end-to-end MCP client tests (no DB/IdP needed)
npm run typecheck
npm run grants -- c2c mcp_reporting_reader '10.%'   # GRANTs for the DB user
npm run credential -- someone@yourcompany.com        # new static credential entry
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

## Vercel

`src/index.ts` exports an Express app for Vercel and retains the local listener for `npm start` and `npm run dev`.
The Vercel build downloads and packages the public AWS RDS CA bundle at `certs/rds-global-bundle.pem`; set
`DB_SSL_CA_PATH=certs/rds-global-bundle.pem`. Deploy the `/mcp` endpoint with Node.js 24 and provide the required
environment variables. The Vercel runtime must also be able to reach the Aurora reader over a secure network path.
Vercel's per-instance execution means the in-memory rate limits are not shared across instances.

## Open decisions

1. **AWS deployment.** Run in the Aurora VPC (same region) behind HTTPS. The plan is to be written after local testing.
2. **Long-term authentication.** Static tokens are interim: they cannot expire, and revoking one needs a restart. Move to an OIDC issuer
   (for example Cognito or Entra ID) whose e-mail claim matches `users.email`, using `AUTH_MODE=oauth`.
3. **Rate limits** are per instance. With more than one task, add a shared limit (for example an API Gateway or WAF rate rule).
