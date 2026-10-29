import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ open: vi.fn(), prepare: vi.fn(), query: vi.fn(), close: vi.fn() }));
vi.mock('../src/repository/rocksdb.js', () => ({ RocksRepository: { openReadOnly: f.open } }));
let directory: string;
beforeEach(async () => {
  vi.resetModules(); vi.resetAllMocks();
  directory = await mkdtemp(path.join(os.tmpdir(), 'sora-benchmark-test-'));
  await mkdir(path.join(directory, 'checkpoint')); await mkdir(path.join(directory, 'live'));
  vi.stubEnv('ROCKSDB_PATH', path.join(directory, 'live'));
  vi.stubEnv('ROCKSDB_BENCHMARK_PATH', path.join(directory, 'checkpoint'));
  vi.stubEnv('ROCKSDB_BENCHMARK_ITERATIONS', '2');
  f.prepare.mockResolvedValue(undefined); f.close.mockResolvedValue(undefined);
  f.query.mockResolvedValue({ items: [] }); f.open.mockReturnValue({ prepare: f.prepare, query: f.query, close: f.close });
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });
const run = () => import('../src/scripts/benchmark-rocksdb.js');
describe('offline RocksDB benchmark command', () => {
  it('requires an explicit checkpoint path before opening storage', async () => {
    vi.stubEnv('ROCKSDB_BENCHMARK_PATH', '   ');
    await expect(run()).rejects.toThrow('ROCKSDB_BENCHMARK_PATH is required'); expect(f.open).not.toHaveBeenCalled();
  });
  it.each(['live', 'live/child', '.'])('rejects overlapping live and checkpoint paths: %s', async relative => {
    vi.stubEnv('ROCKSDB_BENCHMARK_PATH', path.join(directory, relative));
    await expect(run()).rejects.toThrow(); expect(f.open).not.toHaveBeenCalled();
  });
  it.each(['0', '-1', '1.5', 'invalid'])('validates iteration count before opening a checkpoint: %s', async iterations => {
    vi.stubEnv('ROCKSDB_BENCHMARK_ITERATIONS', iterations);
    await expect(run()).rejects.toThrow(); expect(f.open).not.toHaveBeenCalled();
  });
  it('uses read-only storage and bounded queries when optional samples are absent', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(31 * 86_400 * 1000);
    await run();
    expect(f.open).toHaveBeenCalledWith(expect.objectContaining({ rocksdbPath: path.join(directory, 'checkpoint') }));
    const results = JSON.parse(vi.mocked(console.info).mock.calls[0]![0]);
    expect(results.map((row: { case: string }) => row.case)).toEqual(['history/latest-month', 'network/block-latest-month']);
    expect(results).toEqual(expect.arrayContaining([expect.objectContaining({ iterations: 2, returned: 0 })]));
    expect(f.query).toHaveBeenCalledWith('historyElements', expect.objectContaining({ first: 100, includeTotalCount: false, filter: { timestamp: { greaterThanOrEqualTo: 86_400 } } }));
    expect(f.query.mock.calls.every(call => call[1].includeTotalCount === false)).toBe(true);
    expect(f.close).toHaveBeenCalledOnce();
  });
  it('benchmarks available asset, account and market samples without materializing entire collections', async () => {
    const samples: Record<string, Record<string, unknown>> = {
      assetSnapshots: { assetId: 'asset', type: 'DAY' }, accountLiquiditySnapshots: { accountLiquidityId: 'account-pool' },
      marketSnapshots: { marketId: 42, type: 'HOUR' }, historyElements: {},
    };
    f.query.mockImplementation(async (collection, args) => ({ items: args.first === 1 ? [{ timestamp: 10, data: samples[collection] }] : [{ id: 'result' }, { id: 'second' }] }));
    await run();
    const results = JSON.parse(vi.mocked(console.info).mock.calls[0]![0]);
    expect(results.map((row: { case: string }) => row.case)).toEqual(['history/latest-month', 'network/block-latest-month', 'asset/type-latest-month', 'account-liquidity/latest', 'market/type/latest']);
    for (const row of results) { expect(row.returned).toBe(2); expect(row.p50Ms).toBeGreaterThanOrEqual(0); expect(row.p95Ms).toBeLessThanOrEqual(row.maxMs); }
    for (const collection of ['assetSnapshots', 'accountLiquiditySnapshots', 'marketSnapshots']) {
      expect(f.query).toHaveBeenCalledWith(collection, { orderBy: ['ID_ASC'], first: 1, includeTotalCount: false });
    }
    expect(f.query).toHaveBeenCalledWith('assetSnapshots', expect.objectContaining({ filter: { and: [{ assetId: { equalTo: 'asset' } }, { type: { equalTo: 'DAY' } }, { timestamp: { greaterThanOrEqualTo: 0 } }] } }));
    expect(f.query).toHaveBeenCalledWith('accountLiquiditySnapshots', expect.objectContaining({ filter: { accountLiquidityId: { equalTo: 'account-pool' } } }));
    expect(f.query).toHaveBeenCalledWith('marketSnapshots', expect.objectContaining({ filter: { and: [{ marketId: { equalTo: 42 } }, { type: { equalTo: 'HOUR' } }] } }));
    expect(f.query).toHaveBeenCalledTimes(19); expect(f.close).toHaveBeenCalledOnce();
  });
  it.each(['prepare', 'query'])('closes the checkpoint after %s fails', async step => {
    f[step as 'prepare' | 'query'].mockRejectedValue(new Error('offline read failed'));
    await expect(run()).rejects.toThrow('offline read failed'); expect(f.close).toHaveBeenCalledOnce();
  });
});
