import type { C2cAccount } from '../auth/principal.js';
import type { OwnershipCheck, ScopeRepository } from '../data/scope-repository.js';
import { ToolError } from '../errors.js';
import { messages } from '../messages.js';

export interface RequestedFilters {
  customerId?: number | undefined;
  verticalId?: number | undefined;
  advertiserId?: number | undefined;
  offerId?: number | undefined;
  publisherId?: number | undefined;
  campaignId?: number | undefined;
}

/** Verified scope. Owner keys come from the account; filters are proven to sit inside it. */
export interface ResolvedScope {
  customerId: number | null;
  advertiserId: number | null;
  publisherId: number | null;
  verticalId: number | null;
  offerId: number | null;
  campaignId: number | null;
}

type FilterName = keyof RequestedFilters;

/**
 * Turn an account plus caller-supplied filters into a scope that is safe to pass to procedures/queries.
 *
 * The Laravel API trusts customer/advertiser/publisher IDs from the request and widens to "everything" on null.
 * Here, owner IDs always come from the user's `user_role_association` row, and every optional filter ID is checked
 * against the database to belong to that owner before use.
 *
 * @throws {ToolError} `NOT_AUTHORIZED` for out-of-scope IDs; `INVALID_INPUT` for filters the account type cannot use.
 */
export async function resolveScope(account: C2cAccount, filters: RequestedFilters, scopes: ScopeRepository): Promise<ResolvedScope> {
  const scope: ResolvedScope = {
    customerId: account.customerId,
    advertiserId: account.advertiserId,
    publisherId: account.publisherId,
    verticalId: filters.verticalId ?? null,
    offerId: null,
    campaignId: null,
  };

  const verify = async (check: OwnershipCheck, id: number, ownerId: number) => {
    if (!(await scopes.owns(check, id, ownerId))) throw new ToolError('NOT_AUTHORIZED', messages.errors.notAuthorized);
    return id;
  };

  switch (account.type) {
    case 'marketplace': {
      const customerId = account.customerId!;
      rejectForeignOwner(filters.customerId, customerId);
      if (filters.advertiserId !== undefined) scope.advertiserId = await verify('advertiserOfCustomer', filters.advertiserId, customerId);
      if (filters.publisherId !== undefined) scope.publisherId = await verify('publisherOfCustomer', filters.publisherId, customerId);
      if (filters.offerId !== undefined) scope.offerId = await verify('offerOfCustomer', filters.offerId, customerId);
      if (filters.campaignId !== undefined) scope.campaignId = await verify('campaignOfCustomer', filters.campaignId, customerId);
      break;
    }
    case 'advertiser': {
      disallow(filters, ['publisherId', 'campaignId']);
      rejectForeignOwner(filters.customerId, account.customerId!);
      rejectForeignOwner(filters.advertiserId, account.advertiserId!);
      if (filters.offerId !== undefined) scope.offerId = await verify('offerOfAdvertiser', filters.offerId, account.advertiserId!);
      break;
    }
    case 'publisher': {
      disallow(filters, ['advertiserId', 'offerId']);
      rejectForeignOwner(filters.customerId, account.customerId!);
      rejectForeignOwner(filters.publisherId, account.publisherId!);
      if (filters.campaignId !== undefined) scope.campaignId = await verify('campaignOfPublisher', filters.campaignId, account.publisherId!);
      break;
    }
    case 'superadmin': {
      // Matches the Laravel admin view: all customers unless narrowed. Sub-filters are still checked
      // against the chosen customer so a mismatched combination cannot silently return nothing or mislead.
      const customerId = filters.customerId ?? null;
      scope.customerId = customerId;
      scope.advertiserId = filters.advertiserId ?? null;
      scope.publisherId = filters.publisherId ?? null;
      scope.offerId = filters.offerId ?? null;
      scope.campaignId = filters.campaignId ?? null;
      if (customerId !== null) {
        if (scope.advertiserId !== null) await verify('advertiserOfCustomer', scope.advertiserId, customerId);
        if (scope.publisherId !== null) await verify('publisherOfCustomer', scope.publisherId, customerId);
        if (scope.offerId !== null) await verify('offerOfCustomer', scope.offerId, customerId);
        if (scope.campaignId !== null) await verify('campaignOfCustomer', scope.campaignId, customerId);
      }
      break;
    }
  }
  return scope;
}

/** An owner filter equal to the account's own ID is harmless; any other value is out of scope. */
function rejectForeignOwner(requested: number | undefined, own: number): void {
  if (requested !== undefined && requested !== own) throw new ToolError('NOT_AUTHORIZED', messages.errors.notAuthorized);
}

function disallow(filters: RequestedFilters, names: FilterName[]): void {
  for (const name of names) {
    if (filters[name] !== undefined) {
      throw new ToolError('INVALID_INPUT', messages.errors.invalidInput(messages.validation.filterNotAllowed(name)));
    }
  }
}
