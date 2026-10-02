import { describe, expect, it, vi } from 'vitest';
import { atomicDecimal, GENESIS, IndexerReader, unavailable, validateIndexerUrl } from '../src/indexer.js';
import { ADDRESS_SCHEMA, canonicalAddress, HASH_SCHEMA } from '../src/app.js';
import { RateLimiter, ConcurrencyLimit } from '../src/limits.js';

const health = { ok: true, repositoryReady: true, readOnly: true, network: 'mainnet', chainId: 'sora:mainnet', genesisHash: GENESIS, workerReady: true, workerLag: 4, latestIndexedBlock: 27852801 };
const hash = `0x${'1'.repeat(64)}`;
function reader(data: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const fetcher = vi.fn(async (_url: string | URL | Request, _options?: RequestInit) => new Response(JSON.stringify({ data: { _health: { ...health, ...extra }, ...data } }), { status: 200 }));
  return { client: new IndexerReader('https://pi.soramitsu.io/graphql', fetcher as typeof fetch), fetcher };
}
describe('read-only indexed evidence', () => {
  it('preserves signed fee atoms at fixed precision18 and never scales by current denomination38', async () => {
    const { client } = reader({ historyElements: { nodes: [{ id: hash, blockHeight: 27800809, module: 'assets', method: 'transfer', networkFee: '100018412589707326', execution: { success: true }, data: { amount: '5.343596' } }] } });
    const result = await client.transaction(hash);
    expect(result.data.fee).toMatchObject({ atomic: '100018412589707326', decimal: '0.100018412589707326', precision: 18 });
    expect(result.data.outerExtrinsicOutcome).toBe('succeeded');
    expect(result.warnings.join(' ')).toContain('Historical');
    expect(result.warnings.join(' ')).toContain('outer extrinsic');
  });
  it('does not decode placeholder failure codes', async () => {
    const { client } = reader({ historyElements: { nodes: [{ id: hash, execution: { success: false, error: { moduleErrorId: 0, moduleErrorIndex: 0 } }, networkFee: '1' }] } });
    const result = await client.transaction(hash);
    expect(result.data.failureCause).toBe(null);
    expect(result.data.execution).toEqual({ success: false });
    expect(result.warnings.join(' ')).toContain('placeholder');
  });
  it('distinguishes missing indexed records from failed transactions', async () => {
    const { client } = reader({ historyElements: { nodes: [] } });
    const result = await client.transaction(hash);
    expect(result.status).toBe('not_found');
    expect(result.data).toEqual({ hash });
    expect(result.summary).toContain('does not establish');
  });
  it('keeps history bounded with exact address filter and scoped cursor', async () => {
    const { client, fetcher } = reader({ historyElements: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'opaque-next' }, totalCount: 12 } });
    const result = await client.history('public-address', 25, 'opaque-after');
    const request = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
    expect(request.variables).toEqual({ address: 'public-address', first: 25, after: 'opaque-after' });
    expect(request.query).toContain('filter:{address:{equalTo:$address}}');
    expect(result.data.pagination).toEqual({ hasNextPage: true, nextCursor: 'opaque-next' });
    expect(result.warnings.join(' ')).toContain('Incoming');
  });
  it('rejects unverified chain identity and GraphQL partial errors', async () => {
    await expect(reader({ historyElements: { nodes: [] } }, { genesisHash: hash }).client.transaction(hash)).rejects.toThrow('identity');
    const fetcher = vi.fn(async (_url: string | URL | Request, _options?: RequestInit) => new Response(JSON.stringify({ data: { _health: health }, errors: [{ message: 'unsupported' }] })));
    await expect(new IndexerReader(undefined, fetcher as typeof fetch).transaction(hash)).rejects.toThrow('unsupported');
  });
  it('returns no invented balances on upstream failure', () => {
    expect(unavailable('portfolio')).toMatchObject({ status: 'unavailable', data: {} });
  });
});
describe('exact values and public-only boundaries', () => {
  it('retains tiny/huge exact integer amounts and rejects malformed input', () => {
    expect(atomicDecimal('1')).toBe('0.000000000000000001');
    expect(atomicDecimal('123456789012345678901234567890123456789')).toBe('123456789012345678901.234567890123456789');
    expect(() => atomicDecimal('1.5')).toThrow();
    expect(() => validateIndexerUrl('http://example.com/graphql')).toThrow();
    expect(() => validateIndexerUrl('https://user:secret@example.com/graphql')).toThrow();
  });
  it('validates a public SS58 address checksum and hash format', () => {
    const address = 'cnWUWKLZmNjQXGzYAF7YuRSiW1pKTRTzu4fmcYmWQX6UMGQUZ';
    expect(ADDRESS_SCHEMA.parse(address)).toBe(address);
    expect(canonicalAddress(address)).toBe(address);
    expect(ADDRESS_SCHEMA.safeParse('wallet seed phrase')).toHaveProperty('success', false);
    expect(HASH_SCHEMA.safeParse('send money')).toHaveProperty('success', false);
  });
  it('rate-limits by ephemeral bucket and expires without persistence', () => {
    const limiter = new RateLimiter(2, 1000, 2);
    expect(limiter.allow('a', 0)).toBe(true); expect(limiter.allow('a', 1)).toBe(true); expect(limiter.allow('a', 2)).toBe(false);
    expect(limiter.allow('b', 3)).toBe(true); expect(limiter.allow('c', 4)).toBe(false);
    expect(limiter.allow('a', 1001)).toBe(true);
  });
  it('releases concurrency capacity after errors', async () => {
    const limit = new ConcurrencyLimit(1);
    await expect(limit.run(async () => { throw new Error('failure'); })).rejects.toThrow();
    expect(await limit.run(async () => 1)).toBe(1);
  });
});
