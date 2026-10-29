import { describe, expect, it } from 'vitest';
import { readConfig } from '../src/config.js';
import { MemoryRepository } from '../src/repository/memory.js';
import { ChainIndexer } from '../src/worker/chain.js';
const indexer = (): any => new ChainIndexer(readConfig(), new MemoryRepository());
const overview = (data: Record<string, unknown> = {}, validator: unknown = 'validator'): any => [{ args: [10, validator] }, { total: '30', own: '10', pageCount: 1, ...data }];
const page = (data: Record<string, unknown> = {}, pageNumber: unknown = 0, validator: unknown = 'validator'): any => [{ args: [10, validator, pageNumber] }, { pageTotal: '20', others: [{ who: 'nominator', value: '20' }], ...data }];

describe('staking runtime evidence admission', () => {
  it('requires a usable rewarded-nominator runtime constant', () => {
    const w = indexer(); expect(w.getStakingConstNumber('missing')).toBeNull(); expect(() => w.getMaxNominatorRewardedPerValidator()).toThrow(/is required/);
    w.api = { consts: { staking: { maxNominatorRewardedPerValidator: { toNumber: () => NaN }, maxExposurePageSize: { toNumber: () => 64 } } } };
    expect(w.getMaxNominatorRewardedPerValidator()).toBe(64);
  });
  it('unwraps value-style options and selects the latest positive reward era', () => {
    const w = indexer(); expect(w.unwrapOption({ value: 7 })).toBe(7); expect(w.codecToNumber(null)).toBe(0);
    const values = [['bad', '2'], [1, '0'], [4, '9'], [3, '2'], [5, '7']].map(([era, amount]) => [{ args: [era] }, { value: amount }]);
    expect(w.latestRewardEra(values)).toEqual({ era: 5, reward: 7n }); expect(w.latestRewardEra([])).toBeNull();
  });
  it('requires a staking reward-point query before reading an era', async () => {
    await expect(indexer().getEraRewardPoints(10)).rejects.toThrow(/initialized/);
    await expect(indexer().getEraRewardPoints(10, {})).rejects.toThrow(/is required/);
  });
  it.each([
    [{ total: 'invalid', individual: new Map() }, /total points/],
    [{ total: 10 }, /individual points/],
    [{ total: 10, individual: new Map([['alice', 'invalid']]) }, /invalid points for alice/],
  ])('rejects incomplete era reward-point evidence %#', async (data, error) => {
    await expect(indexer().getEraRewardPoints(10, { staking: { erasRewardPoints: async () => data } })).rejects.toThrow(error as RegExp);
  });
  it('requires every historical storage entry point needed for validator refresh', async () => {
    const w = indexer(), validators = { entriesPaged: async () => [] };
    await expect(w.loadStakingValidatorProjectionInputs()).rejects.toThrow(/initialized/);
    await expect(w.loadStakingValidatorProjectionInputs({ staking: { validators } })).rejects.toThrow(/currentEra/);
    await expect(w.loadStakingValidatorProjectionInputs({ staking: { validators, currentEra: async () => 10 } })).rejects.toThrow(/erasValidatorReward/);
    await expect(w.getEraExposures(10)).rejects.toThrow(/initialized/);
    await expect(w.getEraExposures(10, { staking: { erasStakers: { entriesPaged: async () => [] } } })).rejects.toThrow(/no validator exposures/);
  });
  it('rejects a malformed current era before querying identities or exposures', async () => {
    const validators = { entriesPaged: async () => [[{ args: ['alice'] }, { commission: { toString: () => '0' }, blocked: { isTrue: false } }]] };
    await expect(indexer().loadStakingValidatorProjectionInputs({ staking: { validators, currentEra: async () => 'invalid', erasValidatorReward: { entriesPaged: async () => [] } } })).rejects.toThrow(/invalid era/);
  });
  it('rejects paged exposure rows when their overview is absent', async () => {
    const query = { staking: { erasStakersOverview: { entriesPaged: async () => [] }, erasStakersPaged: { entriesPaged: async () => [page()] } } };
    await expect(indexer().getEraExposures(10, query)).rejects.toThrow(/pages without/);
  });
});

describe('validator identity codec normalization', () => {
  it('requires an identity query and a returned codec', async () => {
    await expect(indexer().readValidatorIdentity('alice')).rejects.toThrow(/is required/);
    await expect(indexer().readValidatorIdentity('alice', { identity: { identityOf: async () => null } })).rejects.toThrow(/no codec/);
  });
  it.each([undefined, null, [], 'invalid'])('normalizes missing or malformed identity info %j to an empty record', async info => {
    const result = await indexer().readValidatorIdentity('alice', { identity: { identityOf: async () => ({ info, judgements: [] }) } });
    expect(result).toMatchObject({ info: {}, judgements: [] });
  });
  it('normalizes runtime Raw and None values while preserving other metadata', async () => {
    const info = { display: { Raw: 'Alice' }, legal: { Raw: null }, email: 'None', web: null, twitter: ['public'], extra: 7 };
    const result = await indexer().readValidatorIdentity('alice', { identity: { identityOf: async () => ({ info }) } });
    expect(result.info).toEqual({ display: 'Alice', legal: '', email: '', web: '', twitter: ['public'], extra: 7 });
  });
  it.each([
    [null, false], [{}, false], [{ judgements: [null, 'unknown'] }, false],
    [{ judgements: ['KnownGood'] }, true], [{ judgements: [{ registrar: 'KnownGood' }] }, true],
    [{ judgements: [[0, 'KnownGood']] }, true], [{ judgements: [{ registrar: 'Reasonable' }] }, false],
  ])('recognizes only explicit KnownGood evidence %#', (identity, expected) => { expect(indexer().isKnownGoodIdentity(identity)).toBe(expected); });
});

describe('rolling aggregate retention admission', () => {
  it('retains full-history aggregates independently of rolling cutoffs', () => {
    const w: any = new ChainIndexer({ ...readConfig(), snapshotRetentionMode: 'all' }, new MemoryRepository());
    expect(w.shouldPersistBackfillNetworkAggregate({ data: { type: 'HOUR' }, timestamp: 1 }, 1_000_000_000)).toBe(true);
  });
  it('keeps nonrolling types and requires finite coordinates for rolling types', () => {
    const w: any = new ChainIndexer({ ...readConfig(), snapshotRetentionMode: 'rolling' }, new MemoryRepository());
    expect(w.shouldPersistBackfillNetworkAggregate({ data: {} }, 1_000_000_000)).toBe(true);
    expect(w.shouldPersistBackfillNetworkAggregate({ data: { type: 'HOUR' } }, undefined)).toBe(true);
    expect(w.shouldPersistBackfillNetworkAggregate({ data: { type: 'HOUR', timestamp: 'invalid' } }, 1_000_000_000)).toBe(false);
    expect(w.shouldPersistBackfillNetworkAggregate({ data: { type: 'DEFAULT' } }, 1_000_000_000)).toBe(false);
    expect(w.shouldPersistBackfillNetworkAggregate({ data: { type: 'HOUR', timestamp: 1_000_000_000 } }, 1_000_000_000)).toBe(true);
  });
});

describe('paged staking exposure validation', () => {
  it('joins out-of-order pages in index order and preserves large stake amounts', async () => {
    const value = await indexer().getPagedEraExposures(10, [overview({ total: '9007199254740993', pageCount: 2 })], [page({ others: [{ who: 'second', value: '9007199254740993' }] }, 1), page()]);
    expect(value.get('validator')).toEqual({ total: 9007199254740993n, own: '10', others: [{ who: 'nominator', value: '20' }, { who: 'second', value: '9007199254740993' }] });
  });
  it('accepts an explicitly empty exposure with zero pages', async () => {
    expect((await indexer().getPagedEraExposures(10, [overview({ pageCount: 0 })], [])).get('validator')).toEqual({ total: 30n, own: '10', others: [] });
  });
  it.each([
    [page({}, 0, ''), 'missing a validator address'], [page({}, 'invalid'), 'invalid page'], [page({}, -1), 'invalid page'],
    [page({ pageTotal: null }), 'missing page total'], [page({ pageTotal: undefined }), 'missing page total'],
    [page({ others: null }), 'missing nominators'], [page({ others: {} }), 'missing nominators'],
    [page({ others: [{ value: '1' }] }), 'without an address'], [page({ others: [{ who: 'nominator' }] }), 'without exposure'],
    [page({ others: [{ who: 'nominator', value: null }] }), 'without exposure'],
  ])('rejects incomplete page evidence (%s)', async (entry, reason) => {
    await expect(indexer().getPagedEraExposures(10, [overview()], [entry])).rejects.toThrow(reason as string);
  });
  it.each([
    [overview({}, ''), 'missing a validator address'], [overview({ total: null }), 'missing total exposure'],
    [overview({ total: undefined }), 'missing total exposure'], [overview({ own: null }), 'missing own exposure'],
    [overview({ own: undefined }), 'missing own exposure'], [overview({ pageCount: 'invalid' }), 'invalid page count'],
    [overview({ pageCount: 2 }), 'missing pages'],
  ])('rejects incomplete overview evidence (%s)', async (entry, reason) => {
    await expect(indexer().getPagedEraExposures(10, [entry], [page()])).rejects.toThrow(reason as string);
  });
  it('rejects duplicate pages, gaps, and orphaned pages', async () => {
    await expect(indexer().getPagedEraExposures(10, [overview()], [page(), page()])).rejects.toThrow('duplicate page');
    await expect(indexer().getPagedEraExposures(10, [overview()], [page({}, 1)])).rejects.toThrow('missing page 0');
    await expect(indexer().getPagedEraExposures(10, [], [page()])).rejects.toThrow('missing overview');
  });
});

describe('legacy staking exposure codec boundaries', () => {
  const legacy = (value: unknown, validator: unknown = 'validator'): any => [{ args: [10, validator] }, value];
  it.each(['plain', 'json', 'human', 'array', 'option'])('decodes %s codec containers without changing nominator identity', kind => {
    const item = { who: 'nominator', value: '20' };
    const others = kind === 'array' ? { toArray: () => [item] } : kind === 'option' ? { unwrap: () => [item] } : [item];
    const data = { total: '30', own: '10', others };
    const value = kind === 'json' ? { toJSON: () => data } : kind === 'human' ? { toHuman: () => data } : data;
    expect(indexer().parseEraExposureEntries(10, [legacy(value)]).get('validator')).toEqual({ total: 30n, own: '10', others: [item] });
  });
  it.each([
    [{ total: '30', own: '10', others: [] }, '', 'missing a validator address'],
    [{ own: '10', others: [] }, 'validator', 'missing total exposure'],
    [{ total: '30', others: [] }, 'validator', 'missing own exposure'],
    [{ total: '30', own: '10' }, 'validator', 'missing nominators'],
    [{ total: '30', own: '10', others: [{ value: 1 }] }, 'validator', 'without an address'],
    [{ total: '30', own: '10', others: [{ who: 'nominator' }] }, 'validator', 'without exposure'],
  ])('rejects malformed legacy exposure', (data, validator, reason) => {
    expect(() => indexer().parseEraExposureEntries(10, [legacy(data, validator)])).toThrow(reason as string);
  });
  it('reads JSON and human array fallbacks and refuses an invalid toArray result', () => {
    expect(indexer().codecArray({ toArray: () => 'invalid', toJSON: () => [1] })).toEqual([1]);
    expect(indexer().codecArray({ toHuman: () => [2] })).toEqual([2]);
    expect(indexer().codecArray({ toArray: () => 'invalid' })).toBeNull();
    expect(indexer().codecArray({ isNone: true })).toBeNull();
  });
  it('reads raw codec fields when human and JSON projections omit them', () => {
    const value = { total: '30', own: '10', others: [], toJSON: () => ({}), toHuman: () => ({}) };
    expect(indexer().parseEraExposureEntries(10, [legacy(value)]).get('validator')).toEqual({ total: 30n, own: '10', others: [] });
  });
});
