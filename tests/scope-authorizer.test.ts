import { describe, expect, it } from 'vitest';
import { ScopeRepository } from '../src/data/scope-repository.js';
import { ToolError } from '../src/errors.js';
import { resolveScope } from '../src/tools/scope-authorizer.js';
import { ADVERTISER, FakeExecutor, MARKETPLACE, ownershipResponder, PUBLISHER, SUPER_ADMIN } from './helpers.js';

function scopesWith(owned: [string, number, number][]) {
  const executor = new FakeExecutor(ownershipResponder(owned));
  return { scopes: new ScopeRepository(executor), executor };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toSatisfy((error) => error instanceof ToolError && error.code === code);
}

describe('resolveScope — marketplace', () => {
  it('always injects the account customer and never widens to null', async () => {
    const { scopes } = scopesWith([]);
    expect(await resolveScope(MARKETPLACE, {}, scopes)).toEqual({
      customerId: 100,
      advertiserId: null,
      publisherId: null,
      verticalId: null,
      offerId: null,
      campaignId: null,
    });
  });

  it('accepts filters proven to belong to the customer', async () => {
    const { scopes } = scopesWith([
      ['advertisers', 200, 100],
      ['campaigns', 400, 100],
    ]);
    const scope = await resolveScope(MARKETPLACE, { advertiserId: 200, campaignId: 400, verticalId: 7 }, scopes);
    expect(scope).toMatchObject({ customerId: 100, advertiserId: 200, campaignId: 400, verticalId: 7 });
  });

  it('refuses another customer and IDs owned by another customer', async () => {
    const { scopes } = scopesWith([['advertisers', 999, 555]]);
    await expectCode(resolveScope(MARKETPLACE, { customerId: 555 }, scopes), 'NOT_AUTHORIZED');
    await expectCode(resolveScope(MARKETPLACE, { advertiserId: 999 }, scopes), 'NOT_AUTHORIZED');
  });
});

describe('resolveScope — advertiser', () => {
  it('pins advertiser and customer, verifies offers against the advertiser', async () => {
    const { scopes, executor } = scopesWith([['offers', 50, 200]]);
    const scope = await resolveScope(ADVERTISER, { offerId: 50 }, scopes);
    expect(scope).toMatchObject({ customerId: 100, advertiserId: 200, offerId: 50 });
    expect(executor.calls[0]!.sql).toContain('FROM offers WHERE id = ? AND advertiser_id = ?');
  });

  it('refuses a different advertiser and publisher-side filters', async () => {
    const { scopes } = scopesWith([]);
    await expectCode(resolveScope(ADVERTISER, { advertiserId: 201 }, scopes), 'NOT_AUTHORIZED');
    await expectCode(resolveScope(ADVERTISER, { publisherId: 300 }, scopes), 'INVALID_INPUT');
    await expectCode(resolveScope(ADVERTISER, { offerId: 51 }, scopes), 'NOT_AUTHORIZED');
  });
});

describe('resolveScope — publisher', () => {
  it('pins publisher, verifies campaigns against the publisher', async () => {
    const { scopes } = scopesWith([['campaigns', 400, 300]]);
    expect(await resolveScope(PUBLISHER, { campaignId: 400 }, scopes)).toMatchObject({ publisherId: 300, campaignId: 400 });
    await expectCode(resolveScope(PUBLISHER, { campaignId: 401 }, scopes), 'NOT_AUTHORIZED');
    await expectCode(resolveScope(PUBLISHER, { offerId: 50 }, scopes), 'INVALID_INPUT');
  });
});

describe('resolveScope — super admin', () => {
  it('spans all customers unless narrowed, and checks sub-filters against a chosen customer', async () => {
    const { scopes } = scopesWith([['offers', 50, 100]]);
    expect((await resolveScope(SUPER_ADMIN, {}, scopes)).customerId).toBeNull();
    expect(await resolveScope(SUPER_ADMIN, { customerId: 100, offerId: 50 }, scopes)).toMatchObject({ customerId: 100, offerId: 50 });
    await expectCode(resolveScope(SUPER_ADMIN, { customerId: 101, offerId: 50 }, scopes), 'NOT_AUTHORIZED');
  });
});
