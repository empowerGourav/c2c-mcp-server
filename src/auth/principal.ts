import { createHmac } from 'node:crypto';
import type { AccountType } from '../data/allowlist.js';
import { ToolError } from '../errors.js';
import { messages } from '../messages.js';

/**
 * One C2C account the user may act as: a row of `user_role_association` (or the super-admin pseudo-account).
 * The IDs here are the authoritative row scope; they are never taken from tool arguments.
 */
export interface C2cAccount {
  /** `user_role_association.id`; 0 for the super-admin pseudo-account. */
  accountId: number;
  type: AccountType;
  roleId: number;
  /** null only for super admin (all customers). */
  customerId: number | null;
  advertiserId: number | null;
  publisherId: number | null;
  customerName: string | null;
  accountName: string | null;
}

export interface C2cPrincipal {
  /** Privacy-safe principal identifier for audit logs (HMAC of the identity claim). */
  auditId: string;
  accounts: readonly C2cAccount[];
  /** IANA timezone from the user's C2C preference (`users.time_zone`); the default for date ranges. */
  timezone: string;
}

/**
 * Resolves a verified identity claim (e-mail) to a C2C principal.
 * Implementations MUST fail closed: return `null` for unknown, inactive, duplicated, or account-less users.
 */
export interface PrincipalResolver {
  resolve(identity: string): Promise<C2cPrincipal | null>;
}

/**
 * Pick the account a tool call acts as.
 *
 * @param accountId - Optional account chosen by the caller (from `list_my_accounts`).
 * @throws {ToolError} `NOT_AUTHORIZED` for an account the user does not hold; `INVALID_INPUT` when ambiguous.
 */
export function selectAccount(principal: C2cPrincipal, accountId: number | undefined): C2cAccount {
  if (accountId !== undefined) {
    const account = principal.accounts.find((candidate) => candidate.accountId === accountId);
    if (!account) throw new ToolError('NOT_AUTHORIZED', messages.errors.notAuthorized);
    return account;
  }
  const [only, ...rest] = principal.accounts;
  if (!only || rest.length > 0) {
    throw new ToolError('INVALID_INPUT', messages.errors.invalidInput(messages.validation.accountRequired));
  }
  return only;
}

/**
 * Derive a stable, non-reversible principal identifier for logs.
 *
 * @param identity - Verified identity claim.
 * @param salt - Secret salt (`AUDIT_HASH_SALT`).
 */
export function hashIdentity(identity: string, salt: string): string {
  return createHmac('sha256', salt).update(identity.toLowerCase()).digest('hex').slice(0, 16);
}
