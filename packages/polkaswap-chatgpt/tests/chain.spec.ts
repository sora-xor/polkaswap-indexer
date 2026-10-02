import { describe, expect, it } from 'vitest';
import { atomicInteger, balanceAmounts, decimalAmount, proportionalReserve, sharePercentage, ChainReader, SORA_GENESIS, XOR_ID } from '../src/chain.js';
import type { ApiPromise } from '@polkadot/api';

describe('exact finalized-chain amounts', () => {
  it('preserves very large decimal and hexadecimal codec integers', () => {
    const value = 2n ** 100n + 77n;
    expect(atomicInteger(`0x${value.toString(16)}`)).toBe(value);
    expect(atomicInteger(value.toString())).toBe(value);
    expect(() => atomicInteger(Number.MAX_SAFE_INTEGER + 1)).toThrow('exact chain integer');
    expect(() => atomicInteger(undefined)).toThrow('exact chain integer');
  });
  it('renders tiny and large amounts without floating point', () => {
    expect(decimalAmount(1n, 18)).toBe('0.000000000000000001');
    expect(decimalAmount(123450000000000000000000n, 18)).toBe('123450');
    expect(() => decimalAmount(1n, 39)).toThrow('precision');
  });
  it('uses the live VAL precision 18 independently of the cumulative 10^38 denomination', () => {
    expect(decimalAmount(12668921175418n, 18)).toBe('0.000012668921175418');
    expect(decimalAmount(12668921175418n, 18)).not.toBe(decimalAmount(12668921175418n, 38));
  });
  it('treats modern native freezes, reserved and bonded funds as owned only once', () => {
    const native = balanceAmounts({ free: '100', reserved: '40', frozen: '90' }, '10', true);
    expect(native).toMatchObject({ total: 150n, transferable: 50n, locked: 100n });
    const token = balanceAmounts({ free: '100', reserved: '40', frozen: '90' }, null, false);
    expect(token).toMatchObject({ total: 140n, transferable: 10n, locked: 130n });
  });
  it('bounds oversized legacy freezes without inflating owned balances', () => {
    expect(balanceAmounts({ free: '10', reserved: '2', miscFrozen: '30', feeFrozen: '20' }, null, true))
      .toMatchObject({ total: 12n, transferable: 0n, locked: 12n });
  });
  it('rounds reserve estimates down and rejects invalid supply/share relationships', () => {
    expect(proportionalReserve(11n, 2n, 3n)).toBe(7n);
    expect(() => proportionalReserve(100n, 1n, 0n)).toThrow('pool share');
    expect(() => proportionalReserve(100n, 4n, 3n)).toThrow('pool share');
  });
  it('preserves a tiny nonzero LP percentage from the live share fixture', () => {
    expect(sharePercentage(5n, 1241146974400998116726n)).not.toBe('0');
    expect(sharePercentage(1241146974400998116726n, 1241146974400998116726n)).toBe('100');
  });
});

describe('ChainReader provenance and missing-data behavior', () => {
  const codec = (data: unknown) => ({ toJSON: () => data, toHuman: () => data });
  function fakeApi(genesis = SORA_GENESIS) {
    const at = { query: {
      timestamp: { now: async () => codec('1790840610006') }, denomination: { denominator: async () => codec('100000000000000000000000000000000000000') },
      assets: { assetInfosV2: async () => codec({ precision: '18', symbol: 'XOR', name: 'SORA' }) },
      system: { account: async () => codec({ data: { free: '1000000000000000000', reserved: '0', frozen: '0' } }) },
      referrals: { referrerBalances: async () => codec(null) },
      tokens: { accounts: async () => { throw new Error('missing storage'); } },
    } };
    const hash = { toHex: () => `0x${'1'.repeat(64)}` };
    return { isConnected: true, genesisHash: { toHex: () => genesis },
      rpc: { chain: { getFinalizedHead: async () => hash, getHeader: async () => ({ number: { toNumber: () => 123 } }) } },
      at: async () => at, disconnect: async () => undefined,
    } as unknown as ApiPromise;
  }
  it('anchors holdings to finalized storage and labels unavailable assets without inventing zeros', async () => {
    const reader = new ChainReader('wss://ws.mof.sora.org', async () => fakeApi());
    const result = await reader.portfolio('public-address', [{ id: XOR_ID }, { id: `0x${'2'.repeat(64)}` }]);
    expect(result.data).toHaveLength(1);
    expect(result.data[0].amounts.total).toBe('1');
    expect(result.provenance).toMatchObject({ blockHeight: 123, blockHash: `0x${'1'.repeat(64)}`, timestamp: 1790840610 });
    expect(result.provenance.denominator).toBe('100000000000000000000000000000000000000');
    expect(result.warnings.some(value => value.includes('no zero balance was inferred'))).toBe(true);
    await reader.close();
  });
  it('refuses another network rather than mislabelling it as SORA mainnet', async () => {
    const reader = new ChainReader('wss://ws.mof.sora.org', async () => fakeApi(`0x${'2'.repeat(64)}`));
    await expect(reader.portfolio('public-address', [])).rejects.toThrow('reviewed SORA mainnet');
  });
  it('bounds registry pages before making chain requests', async () => {
    const reader = new ChainReader();
    await expect(reader.portfolio('public-address', Array.from({ length: 101 }, (_, i) => ({ id: String(i) })))).rejects.toThrow('100');
  });
});
