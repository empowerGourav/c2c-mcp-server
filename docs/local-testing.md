# Testing locally against C2C Aurora

This runs the server on your machine with **static credentials** (`AUTH_MODE=static`) against the Aurora **reader** endpoint.
Data scoping is the same as in production: each token maps to a C2C user e-mail, which resolves through `users` →
`user_role_association`.

## 1. Database access

1. **Grants.** `getCallLogReportReplica` was added after you first ran `npm run grants`, so apply the one new statement:

   ```sql
   GRANT EXECUTE ON PROCEDURE `<database>`.`getCallLogReportReplica` TO '<user>'@'<host>';
   ```

   You can also re-run `npm run grants -- <database> <user> '<host>'`; the other grants are already in place.

2. **Network path.** Aurora is normally private, so pick one:
   - **On the VPN / bastion network:** use the reader endpoint directly as `DB_HOST`.
   - **SSH tunnel through a bastion:**

     ```bash
     ssh -N -L 3307:<reader-endpoint>:3306 <user>@<bastion-host>
     ```

     Then set `DB_HOST=127.0.0.1` and `DB_PORT=3307`. With an IP address, TLS still verifies the AWS CA chain but skips the hostname check.

3. **TLS.** `certs/rds-global-bundle.pem` is already downloaded (it is gitignored). Keep `DB_SSL_CA_PATH=./certs/rds-global-bundle.pem`.

## 2. Credentials

Create one credential per C2C user you want to test as. The e-mail must be an active C2C user (status 8) with at
least one active account:

```bash
npm run credential -- someone@yourcompany.com laptop
```

Copy `config/credentials.example.json` to `config/credentials.json` (gitignored) and paste the printed entries into
its `credentials` array. To test the different scoping paths, use one marketplace user, one advertiser user and one publisher user.

## 3. Configure and run

```bash
cp .env.example .env
# Edit .env:
#   DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD
#   AUDIT_HASH_SALT  (any random string of 16+ characters)
#   Keep AUTH_MODE=static, HOST=127.0.0.1, ALLOWED_HOSTS=localhost,127.0.0.1
#   MCP_PUBLIC_URL=http://localhost:8080/mcp
npm run dev
```

Then check:

- `curl http://localhost:8080/healthz` should return 200.
- `curl http://localhost:8080/readyz` returns 200 once Aurora is reachable. A 503 means the DB host, tunnel, credentials or TLS is wrong; the server log names the error class.

## 4. Connect a client

**Claude Code:**

```bash
claude mcp add --transport http c2c http://localhost:8080/mcp --header "Authorization: Bearer <token>"
```

Then ask, for example:

- "List my C2C accounts"
- "Show dashboard KPIs for last week"
- "Show the last 25 billable calls from yesterday"

**MCP Inspector** (shows the raw tool inputs and outputs):

```bash
npx @modelcontextprotocol/inspector
```

Choose transport **Streamable HTTP**, URL `http://localhost:8080/mcp`, and add the header `Authorization: Bearer <token>`.

## 5. What to verify

| Check | Expected |
|---|---|
| `list_my_accounts` | The user's active C2C accounts only |
| `get_dashboard_kpis` | The same numbers as the C2C dashboard for that date range and timezone |
| `get_call_log` | The same calls as the C2C call log screen; caller shown as `***-***-1234`; no recording URLs |
| Advertiser user | No publisher names, campaigns or payouts |
| Publisher user | No advertiser names, offers or advertiser revenue |
| Filter with another customer's ID | "Not authorized" |
| Unknown or wrong token | HTTP 401 |
| Valid token, e-mail not in C2C | HTTP 403 |

If a KPI shows as unavailable, the server log has the procedure's error code. The usual causes are a missing EXECUTE grant
(`ER_PROCACCESS_DENIED_ERROR`), or a procedure declared `SQL SECURITY INVOKER` that needs extra SELECT grants.
