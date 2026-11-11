/**
 * Print the least-privilege GRANT statements for the reporting DB user, derived from src/data/allowlist.ts.
 * Usage: npx tsx scripts/print-grants.ts <database> <user> <host-pattern>
 */
import { ALL_PROCEDURES, TABLE_COLUMNS } from '../src/data/allowlist.js';

const [database = 'c2c', user = 'mcp_reporting_reader', host = '%'] = process.argv.slice(2);
const IDENT = /^[A-Za-z0-9_%.-]+$/;
for (const value of [database, user, host]) {
  if (!IDENT.test(value)) throw new Error(`Refusing unsafe identifier: ${value}`);
}
const account = `'${user}'@'${host}'`;
const lines: string[] = [];
for (const [table, columns] of Object.entries(TABLE_COLUMNS)) {
  lines.push(`GRANT SELECT (${columns.join(', ')}) ON \`${database}\`.\`${table}\` TO ${account};`);
}
for (const procedure of [...ALL_PROCEDURES].sort()) {
  lines.push(`GRANT EXECUTE ON PROCEDURE \`${database}\`.\`${procedure}\` TO ${account};`);
}
process.stdout.write(`${lines.join('\n')}\n`);
