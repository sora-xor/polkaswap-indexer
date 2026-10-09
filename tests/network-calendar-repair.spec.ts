import { describe, expect, it } from 'vitest';

import { buildNetworkCalendarRepairMetadata, type CalendarRepairBlock } from '../src/scripts/network-calendar-repair.js';
import type { IndexerDocument } from '../src/repository/types.js';

/** Compact fixture mirrors the inventory after history/BLOCK reconciliation. */
const block = (height: number, timestamp: number, amount = 1n): CalendarRepairBlock => ({
  id: `block-${height}`, timestamp, accounts: 1, transactions: 2, swaps: 3,
  bridgeIncomingTransactions: 4, bridgeOutgoingTransactions: 5,
  fees: amount, volumeUSD: amount * 10n ** 18n,
});
const input = (...rows: [number, number, bigint?][]): Map<number, CalendarRepairBlock> =>
  new Map(rows.map(([height, timestamp, amount]) => [height, block(height, timestamp, amount)]));
const snapshot = (type: string, timestamp: number, height = 2): IndexerDocument => ({
  collection: 'networkSnapshots', id: `network-all-${type}-${timestamp}`, timestamp, blockHeight: height,
  data: { type, timestamp, swaps: 99999, volumeUSD: '999999', liquidityUSD: '123.45' },
});

describe('calendar metadata from repaired canonical BLOCK flows', () => {
  it('rebuilds all seven flow fields across adjacent buckets and preserves stock documents', () => {
    const blocks = input([1, 3599, 100n], [2, 3600, 5n], [3, 7199, 7n], [4, 7200, 9n]);
    const prior = snapshot('HOUR', 7100);
    const current = snapshot('HOUR', 7200, 4);
    const before = structuredClone([prior, current]);
    const result = buildNetworkCalendarRepairMetadata(blocks, [prior, current], 4);
    expect(result.get(prior.id)).toEqual({ version: 1, bucketStart: 3600, bucketEnd: 7200,
      throughBlock: 3, throughTimestamp: 7199, complete: true, fees: '12', volumeUSD: '12',
      accounts: 2, transactions: 4, swaps: 6, bridgeIncomingTransactions: 8, bridgeOutgoingTransactions: 10 });
    expect(result.get(current.id)).toMatchObject({ throughBlock: 4, throughTimestamp: 7200,
      complete: false, fees: '9', volumeUSD: '9', swaps: 3 });
    expect([prior, current]).toEqual(before);
    expect(prior.data).not.toHaveProperty('calendarFlows');
  });

  it('sums codec fees exactly and matches per-BLOCK USD truncation at eight decimal places', () => {
    const blocks = input([1, 3599], [2, 3600], [3, 7199], [4, 7200]);
    blocks.set(2, { ...blocks.get(2)!, fees: 123456789012345678901234567890n, volumeUSD: 19999999999n });
    blocks.set(3, { ...blocks.get(3)!, fees: 987654321098765432109876543210n, volumeUSD: 19999999999n });
    const row = snapshot('HOUR', 7100);
    expect(buildNetworkCalendarRepairMetadata(blocks, [row], 4).get(row.id)).toMatchObject({
      fees: '1111111110111111111011111111100', volumeUSD: '0.00000002',
    });
  });

  it('uses height ownership when several canonical blocks have the same timestamp', () => {
    const blocks = input([1, 3599], [2, 3600, 5n], [3, 3600, 7n], [4, 3600, 11n], [5, 7200]);
    const row = snapshot('HOUR', 3600);
    expect(buildNetworkCalendarRepairMetadata(blocks, [row], 3).get(row.id)).toMatchObject({
      throughBlock: 3, throughTimestamp: 3600, volumeUSD: '12', complete: false,
    });
    expect(buildNetworkCalendarRepairMetadata(blocks, [row], 5).get(row.id)).toMatchObject({
      throughBlock: 4, volumeUSD: '23', complete: true,
    });
  });

  it.each([
    ['missing predecessor', [[2, 3600], [3, 7199], [4, 7200]], /predecessor/],
    ['missing interior block', [[1, 3599], [2, 3600], [4, 7199], [5, 7200]], /noncontiguous/],
    ['missing successor', [[1, 3599], [2, 3600], [3, 7199], [5, 7200]], /successor/],
  ] as const)('withholds metadata for %s and reports the reason', (_label, rows, reason) => {
    const blocks = input(...rows.map(([height, timestamp]) => [height, timestamp] as [number, number]));
    const row = snapshot('HOUR', 7100);
    const unprovable: { id: string; reason: string }[] = [];
    expect(buildNetworkCalendarRepairMetadata(blocks, [row], rows.at(-1)![0], (entry) => unprovable.push(entry)).size).toBe(0);
    expect(unprovable).toEqual([{ id: row.id, reason: expect.stringMatching(reason) }]);
  });

  it('proves an empty calendar bucket only with adjacent canonical boundary blocks', () => {
    const row = snapshot('HOUR', 7100);
    expect(buildNetworkCalendarRepairMetadata(input([1, 3599], [2, 7200]), [row], 2).get(row.id)).toMatchObject({
      throughBlock: 1, throughTimestamp: 3599, complete: true, fees: '0', volumeUSD: '0', swaps: 0,
    });
    expect(buildNetworkCalendarRepairMetadata(input([1, 3599], [3, 7200]), [row], 3).size).toBe(0);
  });

  it('withholds future buckets and requires a canonical fixed repair head', () => {
    const blocks = input([1, 3599], [2, 3600]);
    const row = snapshot('HOUR', 7200);
    const unprovable: { id: string; reason: string }[] = [];
    expect(buildNetworkCalendarRepairMetadata(blocks, [row], 2, (entry) => unprovable.push(entry)).size).toBe(0);
    expect(unprovable[0]?.reason).toMatch(/beyond the fixed repair head/);
    expect(() => buildNetworkCalendarRepairMetadata(blocks, [row], 3)).toThrow(/repair-head BLOCK/);
  });

  it('rejects malformed canonical IDs, negative flows, and regressing timestamps', () => {
    const row = snapshot('HOUR', 3600);
    for (const replacement of [
      { ...block(2, 3600), id: 'other-id' },
      { ...block(2, 3600), fees: -1n },
      { ...block(2, 3600), accounts: -1 },
      { ...block(2, 3600), timestamp: 3598 },
    ]) {
      const blocks = input([1, 3599], [2, 3600]);
      blocks.set(2, replacement);
      expect(() => buildNetworkCalendarRepairMetadata(blocks, [row], 2)).toThrow(/Invalid|Regressing/);
    }
  });

  it('covers DEFAULT, HOUR, DAY, and MONTH independently with the same canonical proof', () => {
    const boundary = 2_592_000;
    const blocks = input([1, boundary - 1], [2, boundary, 5n], [3, boundary + 100, 7n], [4, boundary + 2_592_000]);
    const rows = ['DEFAULT', 'HOUR', 'DAY', 'MONTH'].map((type) => snapshot(type, boundary + 100));
    const result = buildNetworkCalendarRepairMetadata(blocks, rows, 4);
    for (const row of rows) expect(result.get(row.id)).toMatchObject({ complete: true, volumeUSD: '12', throughBlock: 3 });
  });
});
