/**
 * Compare call-log counts for one marketplace and day, to check the server against the C2C call log screen.
 * Prints only customer IDs/names and counts — never call-level data.
 *
 * Usage (with the DB tunnel/VPN up):  npm run diagnose:call-log -- "IBM" 2026-11-11 [EST|CST|MST|PST]
 */
import { loadConfig } from '../src/config.js';
import { callLogArgs, CALL_LOG_PROCEDURE, USER_TIMEZONES } from '../src/data/allowlist.js';
import { MySqlQueryExecutor } from '../src/data/database.js';
import { ScopeRepository } from '../src/data/scope-repository.js';

const [namePart, day, zone = 'EST'] = process.argv.slice(2);
if (!namePart || !day || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !USER_TIMEZONES[zone.toUpperCase()]) {
  process.stderr.write('Usage: npm run diagnose:call-log -- "<marketplace name part>" <YYYY-MM-DD> [EST|CST|MST|PST]\n');
  process.exit(1);
}
const timezone = USER_TIMEZONES[zone.toUpperCase()]!;
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const db = new MySqlQueryExecutor(loadConfig().database, quiet);

try {
  const { rows: customers } = await new ScopeRepository(db).listDimension('customers', { by: 'none' }, 10, namePart);
  if (customers.length === 0) console.log(`No active customer matches "${namePart}".`);
  for (const customer of customers) {
    const base = {
      startDateTime: `${day} 00:00:00`,
      endDateTime: `${day} 23:59:59`,
      timezone,
      customerId: customer.id,
      publisherId: null,
      advertiserId: null,
      campaignId: null,
      verticalId: null,
      offerId: null,
      billable: null,
      scrubbed: null,
      callTagIds: '',
      offset: 0,
      limit: 100,
    } as const;
    const count = async (intelligence: string) => {
      const args = callLogArgs(base);
      args[12] = intelligence; // position of the `intelligence` parameter
      const rows = await db.callProcedure(CALL_LOG_PROCEDURE, args);
      return `${rows.length} row(s), totalCount=${rows[0]?.['totalCount'] ?? 0}`;
    };
    console.log(`customer ${customer.id} "${customer.name}" on ${day} (${timezone}):`);
    console.log(`  intelligence='Any'  (current server): ${await count('Any')}`);
    console.log(`  intelligence='null' (previous server): ${await count('null')}`);
  }
} catch (error) {
  const failure = error as { name?: string; code?: string };
  console.log(`Failed: ${failure.name ?? 'Error'} ${failure.code ?? ''} — check the tunnel/VPN, .env DB settings, and grants.`);
  process.exitCode = 1;
} finally {
  await db.close();
}
