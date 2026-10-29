import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOURLY_GENESIS_HASH } from '../src/scripts/hourly-backfill-constants.js';
import { HOURLY_HISTORY_ASSETS } from '../src/worker/hourly-history.js';
const fixture = vi.hoisted(() => ({ create: vi.fn(), close: vi.fn() }));
vi.mock('../src/scripts/hourly-backfill-archive.js', () => ({ createArchiveHourlyBackfillSource: fixture.create }));
let directory: string, argv: string[];
const hash = (height: number) => '0x' + height.toString(16).padStart(64, '0');
const block = (height: number) => ({ height, hash: hash(height), parentHash: hash(height - 1), timestamp: 1000 + (height - 1) * 1800 });
const boot = async (...args: string[]) => {
  process.argv = [process.execPath, resolve('src/scripts/backfill-hourly-history.ts'), ...args];
  await import('../src/scripts/backfill-hourly-history.js');
};
beforeEach(async () => {
  argv = process.argv; directory = await mkdtemp(join(tmpdir(), 'hourly-cli-boundary-')); vi.resetModules(); vi.resetAllMocks();
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  fixture.close.mockResolvedValue(undefined);
  fixture.create.mockResolvedValue({ genesisHash: async () => HOURLY_GENESIS_HASH, finalized: async () => block(400), block: async (height: number) => block(height), close: fixture.close, progress: () => ({ rpcCalls: 0 }), observation: async () => ({ denominator: '1', assets: HOURLY_HISTORY_ASSETS.map(a => ({ ...a, decimals: 18 })), prices: HOURLY_HISTORY_ASSETS.map(a => ({ id: a.id, value: '1000000000000000000' })), pools: [] }) });
});
afterEach(async () => { process.argv = argv; vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });
describe('hourly artifact CLI offline lifecycle', () => {
  it.each([[], ['--wat=1'], ['--hours'], ['--output=a', '--output=b'], ['--output='], ['--hours=1']].map(value => [value]))('rejects malformed arguments %j before opening archive access', async args => {
    await expect(boot(...args)).rejects.toThrow(); expect(fixture.create).not.toHaveBeenCalled();
  });
  it.each(['0', '2161', 'no', '1.5', '-1'])('rejects out-of-range hours %s', async hours => {
    await expect(boot(`--output=${join(directory, 'out')}`, `--hours=${hours}`)).rejects.toThrow(/Invalid --hours/); expect(fixture.create).not.toHaveBeenCalled();
  });
  it.each(['invalid', '1970-01-01T01:00:01Z'])('requires an exact UTC end hour %s', async end => {
    await expect(boot(`--output=${join(directory, 'out')}`, `--end=${end}`)).rejects.toThrow(/Invalid --hours/);
  });
  it('writes all default 168 hours and closes the archive after publishing', async () => {
    const output = join(directory, 'out'); await boot(`--output=${output}`);
    const rows = (await readFile(output, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(rows).toHaveLength(169); expect(rows[0].endAt - rows[0].startAt).toBe(168 * 3600);
    expect(fixture.close).toHaveBeenCalledOnce();
    const progress = vi.mocked(console.info).mock.calls.map(([line]) => JSON.parse(String(line))).filter(value => value.preparedHours !== undefined).map(value => value.preparedHours);
    expect(progress).toEqual([1, 2, 3, ...Array.from({ length: 14 }, (_, i) => (i + 1) * 12)]);
  });
  it('honors explicit bounds and a validated target catalogue', async () => {
    const targets = join(directory, 'targets.json'); await writeFile(targets, JSON.stringify(HOURLY_HISTORY_ASSETS));
    const output = join(directory, 'out'); await boot(`--output=${output}`, '--hours=2', '--end=1970-01-01T03:00:00Z', `--targets=${targets}`);
    expect(fixture.create).toHaveBeenCalledWith({ targets: HOURLY_HISTORY_ASSETS });
    const rows = (await readFile(output, 'utf8')).trim().split('\n').map(line => JSON.parse(line)); expect(rows[0]).toMatchObject({ version: 2, startAt: 3600, endAt: 10800 }); expect(rows).toHaveLength(3);
  });
  it.each(['invalid-json', 'invalid-target', 'oversized'])('rejects %s target files before opening archive access', async mode => {
    const path = join(directory, 'targets'); await writeFile(path, mode === 'oversized' ? 'x'.repeat(2 * 1024 * 1024 + 1) : mode === 'invalid-json' ? '{' : '[]');
    await expect(boot(`--output=${join(directory, 'out')}`, `--targets=${path}`)).rejects.toThrow(); expect(fixture.create).not.toHaveBeenCalled();
  });
  it('closes the source when archive identity verification fails', async () => {
    const source = await fixture.create(); source.genesisHash = async () => hash(1);
    await expect(boot(`--output=${join(directory, 'out')}`, '--hours=1')).rejects.toThrow(/genesis/); expect(fixture.close).toHaveBeenCalledOnce();
  });
});
