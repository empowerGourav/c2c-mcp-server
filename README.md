# c2c-mcp-server

Read-only [Model Context Protocol](https://modelcontextprotocol.io) server that lets authenticated Claude
clients ask questions about a narrowly approved set of **aggregate** Calls-to-Convert (C2C) reporting data.

It is built to the design in `D:\Visiqua\calls-to-convert\.azure\project-plan.md`. It offers fixed, typed tools only:
no SQL, schema discovery, raw records, or writes.

## Status

| Area | State |
|---|---|
| MCP service, auth, limits, audit logging | Implemented and tested (phase 3 of the plan) |
| Data allowlist | **Empty by default.** Every data tool reports "not yet enabled" until approved (see `docs/db-contract.md`) |
| DB engine | MySQL assumed provisionally (plan §11). Not yet confirmed |
| Identity → C2C permissions | Interim reviewed JSON mapping (`PRINCIPAL_MAP_PATH`). The authoritative source is still to be confirmed |
| Azure deployment (Container Apps, VNet, Key Vault) | Not started (phase 4) |

## Tools

| Tool | Purpose |
|---|---|
| `get_metric_definitions` | Lists the enabled reports, their metrics, filters, limits and freshness. Never reveals schema |
| `get_campaign_daily_summary` | Daily calls and conversions per authorized campaign over a bounded date range |
| `get_call_outcome_summary` | Call counts per approved outcome code over a bounded date range |

All three tools are annotated `readOnlyHint: true`. Inputs are strict: unknown fields are rejected.

## Request flow and controls

```
Claude ──HTTPS──▶ /mcp
  ├─ Host-header validation (ALLOWED_HOSTS)
  ├─ Bearer JWT: signature (issuer JWKS), iss, aud, exp, alg, required scopes  → 401 / 403
  ├─ Subject → C2C principal (fail closed: unknown/disabled/ambiguous/empty scope) → 403
  └─ Stateless MCP server bound to that principal (fresh per request)
       └─ per tool call: rate limit (30/min/user) · concurrency caps · view approval ·
          campaign-scope authorization · date bounds (30d default, 90d max) ·
          fixed parameterized SELECT on a READ ONLY session with a 5s timeout ·
          500-row cap with truncation note · min group size 10 · 128 KiB cap ·
          metadata-only audit log (hashed principal, tool, decision, rows, duration)
```

## Develop

```bash
npm ci
cp .env.example .env                      # fill in values; never commit .env
cp config/principals.example.json config/principals.json
npm test                                  # unit + end-to-end MCP client tests (no DB/IdP needed)
npm run typecheck
npm run dev                               # needs a reachable OIDC issuer and DB
```

Node.js 24 LTS or newer is required.

## Configuration

Every setting is an environment variable. See `.env.example` for the full annotated list. The defaults are
the plan's conservative limits. Startup fails fast in these cases:

- a required value is missing;
- `C2C_APPROVED_VIEWS` names a view that has no reviewed contract in `src/data/allowlist.ts`;
- DB TLS is disabled in production;
- the issuer's OIDC discovery document is unreachable, or names a different issuer.

## Container

```bash
docker build -t c2c-mcp-server .
```

The image runs as a non-root user and listens on `0.0.0.0:8080`, so set `ALLOWED_HOSTS` to the public hostname.
Supply secrets (`DB_PASSWORD`, `AUDIT_HASH_SALT`) from Key Vault references and mount the principal map as a secret volume.
Probes are `GET /healthz` (liveness) and `GET /readyz` (DB reachability).

## Open decisions (from plan §11)

1. Production DB engine, region, replica endpoint, and freshness. If the engine is MariaDB, swap `MAX_EXECUTION_TIME` in `src/data/database.ts`.
2. The approved metrics and view definitions, and their owner (see `docs/db-contract.md`).
3. The OAuth issuer, the client registration and scopes, and the authoritative identity→C2C permission source (replaces `StaticPrincipalResolver`).
4. Whether API Management is needed. Rate limits are per replica today.
5. Privacy thresholds and audit retention.
