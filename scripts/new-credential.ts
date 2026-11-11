/**
 * Print a new static credential entry for config/credentials.json.
 * Usage: npm run credential -- <c2c-user-email> [label]
 *
 * The e-mail must belong to an active C2C user (users.status = 8) with at least one active account.
 */
import { randomBytes } from 'node:crypto';

const [email, label = 'local'] = process.argv.slice(2);
if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  process.stderr.write('Usage: npm run credential -- <c2c-user-email> [label]\n');
  process.exit(1);
}
const token = `c2c_${randomBytes(32).toString('base64url')}`;
process.stdout.write(`${JSON.stringify({ email, token, label }, null, 2)}\n`);
