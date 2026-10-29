import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateBurnRecoveryPolicy } from '../burn-recovery.js';
import { exportPointsRecovery, pointsDigest, pointsQueryIdentity } from '../points-recovery.js';
import type { AppConfig } from '../config.js';
import type { IndexerRepository } from '../repository/types.js';

const MAX_FILES = 100_000;
const MAX_BYTES = 4 * 1024 ** 4;
const need = (ok: unknown, message: string): void => { if (!ok) throw new Error(`Point export: ${message}`); };
const sha = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

/** Stream-hash regular unaliased files; no whole-database allocation. */
export async function hashFile(path: string): Promise<{ sha256: string; bytes: number }> {
  const stat = await lstat(path);
  need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, 'source must be an independent regular file');
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(path)) { bytes += chunk.length; hash.update(chunk); }
  need(bytes === stat.size, 'source size changed during read');
  return { sha256: hash.digest('hex'), bytes };
}

/** Full closure detects an active writer or accidental read-only-engine side effect. */
export async function inventory(path: string): Promise<Record<string, { sha256: string; bytes: number }>> {
  need(isAbsolute(path) && resolve(path) === path && await realpath(path) === path, 'database-copy path must be canonical and unaliased');
  const result: Record<string, { sha256: string; bytes: number }> = {}; let total = 0; let count = 0;
  const visit = async (directory: string) => {
    const stat = await lstat(directory); need(stat.isDirectory() && !stat.isSymbolicLink(), 'aliased/special database directory');
    for (const name of (await readdir(directory)).sort()) {
      const file = join(directory, name); const info = await lstat(file);
      need(!info.isSymbolicLink(), 'database aliases are forbidden');
      if (info.isDirectory()) await visit(file);
      else {
        need(count < MAX_FILES && info.isFile() && info.nlink === 1 && total + info.size <= MAX_BYTES,
          'database file/type/size bound');
        const pin = await hashFile(file); total += pin.bytes; count++; result[relative(path, file)] = pin;
      }
    }
  };
  await visit(path);
  need(Object.keys(result).length > 0 && 'CURRENT' in result, 'not an existing stopped RocksDB copy');
  return result;
}

/** Fixed offline read-only repository; no environment, database URL, RPC, or service configuration. */
export async function openReadOnly(databaseCopy: string): Promise<IndexerRepository> {
  const { RocksRepository } = await import('../repository/rocksdb.js');
  return RocksRepository.openReadOnly({ storageEngine: 'rocksdb', rocksdbPath: databaseCopy,
    rocksdbWatchQueueMax: 1, rocksdbQueryMaxScannedRows: 100_000, rocksdbDocumentCacheMax: 0,
    rocksdbDocumentCacheMaxBytes: 0, rocksdbBlockCacheMb: 64, rocksdbWriteBufferManagerMb: 0,
    rocksdbEnableStats: false, rocksdbParallelism: 1 } as AppConfig);
}

export async function writeNew(path: string, value: unknown): Promise<{ sha256: string; bytes: number }> {
  const data = json(value); const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
  return { sha256: sha(data), bytes: Buffer.byteLength(data) };
}

export type PointExportOptions = { databaseCopy: string; policy: string; policySha256: string; output: string };
/**
 * Export a stopped OWNED COPY of an isolated recovery indexer. This verifies
 * internal projection integrity and unchanged files, not historical finality.
 * The allocation ledger is acyclic; live/future admission stays in EXPORT.json.
 */
export async function exportPointRecoveryFile(options: PointExportOptions,
  dependencies: { openRepository?: typeof openReadOnly } = {}) {
  need(/^[0-9a-f]{64}$/.test(options.policySha256), 'invalid explicit policy SHA-256');
  need(await realpath(options.policy) === resolve(options.policy), 'policy path must not contain aliases');
  const policyPin = await hashFile(options.policy);
  need(policyPin.sha256 === options.policySha256 && policyPin.bytes <= 16 * 1024 * 1024, 'policy pin/size mismatch');
  const policyBytes = await readFile(options.policy); need(sha(policyBytes) === policyPin.sha256, 'policy changed during read');
  const policy = validateBurnRecoveryPolicy(JSON.parse(policyBytes.toString('utf8')));
  const output = resolve(options.output);
  need(await realpath(dirname(output)) === dirname(output), 'output parent must be existing and unaliased');
  const relativeOutput = relative(options.databaseCopy, output);
  need(relativeOutput.startsWith('..' + '/') || isAbsolute(relativeOutput), 'output must be outside the database copy');
  const before = await inventory(options.databaseCopy);
  const guard = async () => {
    need(pointsDigest(await inventory(options.databaseCopy)) === pointsDigest(before), 'database copy changed');
    need(pointsDigest(await hashFile(options.policy)) === pointsDigest(policyPin), 'policy changed');
  };
  await mkdir(output); // exclusive; never replace prior evidence
  const startedPin = await writeNew(join(output, 'STARTED.json'), { schema: 'sora-nexus-soratopia-live-export-start-v1',
    databaseCopy: options.databaseCopy, databaseFiles: before, policy: policyPin, nodeVersion: process.version,
    readOnlyRequested: true, externalReplayVerified: false, productionReady: false });
  const repository = await (dependencies.openRepository ?? openReadOnly)(options.databaseCopy);
  let ledger;
  try {
    await repository.prepare?.();
    const storedPolicy = await pointsQueryIdentity(repository);
    need(pointsDigest(storedPolicy) === pointsDigest(policy), 'configured/live repository policy mismatch');
    ledger = await exportPointsRecovery(repository, policy);
  } finally { await repository.close(); }
  await guard();
  const ledgerPin = await writeNew(join(output, 'soratopia-entitlements.json'), ledger);
  const receipt = { schema: 'sora-nexus-soratopia-live-export-v1', databaseCopy: options.databaseCopy,
    databaseInventorySha256: pointsDigest(before), databaseUnchanged: true, readOnlyRequested: true,
    policy: policyPin, started: { file: 'STARTED.json', ...startedPin }, ledger: { file: 'soratopia-entitlements.json', ...ledgerPin },
    liveAdmission: { releaseManifestHash: policy.releaseManifestHash, postForkAnchor: policy.postForkAnchor },
    checkpoint: policy.checkpoint, policyHash: policy.policyHash, checkpointReceiptRoot: ledger.checkpointReceiptRoot,
    projectionLedgerRoot: ledger.projectionLedgerRoot, externalReplayVerified: false, preReleaseGenerationVerified: false, productionReady: false };
  await guard();
  const receiptPin = await writeNew(join(output, 'EXPORT.json'), receipt);
  const directory = await open(output, 'r'); try { await directory.sync(); } finally { await directory.close(); }
  await guard();
  need((await readdir(output)).sort().join(',') === 'EXPORT.json,STARTED.json,soratopia-entitlements.json' &&
    pointsDigest(await hashFile(join(output, 'STARTED.json'))) === pointsDigest(startedPin) &&
    pointsDigest(await hashFile(join(output, 'soratopia-entitlements.json'))) === pointsDigest(ledgerPin) &&
    pointsDigest(await hashFile(join(output, 'EXPORT.json'))) === pointsDigest(receiptPin), 'export bytes changed');
  return { receipt: join(output, 'EXPORT.json'), ...receiptPin, externalReplayVerified: false, productionReady: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const flags = new Map<string, string>(); const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    need(['--database-copy', '--policy', '--policy-sha256', '--output'].includes(args[i]) && args[i + 1] && !flags.has(args[i]),
      'Use --database-copy OWNED_STOPPED_COPY --policy PUBLIC_JSON --policy-sha256 SHA256 --output NEW_DIRECTORY');
    flags.set(args[i], args[i + 1]);
  }
  need(flags.size === 4, 'all four explicit arguments required');
  const result = await exportPointRecoveryFile({ databaseCopy: flags.get('--database-copy')!, policy: flags.get('--policy')!,
    policySha256: flags.get('--policy-sha256')!, output: flags.get('--output')! });
  process.stdout.write(json(result));
}
