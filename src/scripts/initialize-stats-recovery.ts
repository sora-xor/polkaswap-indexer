/**
 * Inactive operator-only initializer for the one reviewed private MOF2 candidate.
 * Usage: node initialize-stats-recovery.js ADMISSION SHA FILES NATIVE EXECUTOR --apply-private-stats-copy
 * The external executor owns source locking/copy/native qualification. This command
 * has no worker, listener, RPC or production path. It never initializes in-place.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readConfig } from '../config.js';
import { RocksRepository } from '../repository/rocksdb.js';
import { loadStatsRecoveryAdmission, requireStatsRecoveryState, statsEvidenceDigest } from '../stats-recovery.js';
import { prepareStatsRecoverySeed, validateStatsCloneQualification, type StatsQualificationBytes } from '../stats-recovery-admission.js';

function need(value: unknown, message: string): asserts value { if (!value) throw new Error(`Stats initializer: ${message}`); }

/** Read a bounded nonsymlink regular evidence file without reopening the pinned buffer. */
export async function readStatsQualificationFile(path: string): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    need(before.isFile() && before.size <= 16 * 1024 * 1024, 'evidence file bound/type');
    const raw = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < raw.length) {
      const { bytesRead } = await file.read(raw, offset, raw.length - offset, offset);
      need(bytesRead > 0, 'evidence truncated'); offset += bytesRead;
    }
    const after = await file.stat();
    need(before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs, 'evidence changed');
    return raw;
  } finally { await file.close(); }
}

/** Verify every copied file and independent inode before allowing the new candidate writer to open. */
export async function verifyStatsCandidateFiles(database: string, source: string,
  files: Record<string, unknown>, checkRunning: () => void): Promise<void> {
  need(resolve(database) === database && resolve(source) === source && database !== source &&
    await realpath(database) === database && await realpath(source) === source, 'unsafe candidate/source path');
  const names = Object.keys(files).sort();
  need(JSON.stringify((await readdir(database)).sort()) === JSON.stringify(names), 'candidate file set differs');
  for (const name of names) {
    checkRunning();
    need(/^[A-Za-z0-9_.-]+$/.test(name) && name !== '.' && name !== '..', 'unsafe manifest filename');
    const expected = files[name] as { size: number; sha256: string };
    const path = join(database, name), sourcePath = join(source, name);
    const [before, original] = await Promise.all([lstat(path), lstat(sourcePath)]);
    need(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && original.isFile() &&
      !original.isSymbolicLink() && (before.dev !== original.dev || before.ino !== original.ino) &&
      before.size === expected.size, 'candidate file type/size/independence differs');
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const held = await file.stat();
      need(held.dev === before.dev && held.ino === before.ino, 'candidate file replaced before hashing');
      const hash = createHash('sha256'), buffer = Buffer.alloc(4 * 1024 * 1024);
      let offset = 0;
      while (offset < before.size) {
        checkRunning();
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
        need(bytesRead > 0, 'candidate file truncated'); offset += bytesRead; hash.update(buffer.subarray(0, bytesRead));
      }
      const [after, current] = await Promise.all([file.stat(), lstat(path)]);
      const same = (value: typeof before) => value.dev === before.dev && value.ino === before.ino &&
        value.size === before.size && value.mtimeMs === before.mtimeMs && value.ctimeMs === before.ctimeMs && value.nlink === 1;
      need(same(after) && same(current) && hash.digest('hex') === expected.sha256, 'candidate file bytes changed');
    } finally { await file.close(); }
  }
  checkRunning();
  need(JSON.stringify((await readdir(database)).sort()) === JSON.stringify(names), 'candidate file set changed');
}

/** The explicit apply entrypoint is never called from worker startup. */
export async function initializeStatsRecovery(argv: string[]): Promise<void> {
  need(argv.length === 6 && argv[5] === '--apply-private-stats-copy', 'explicit six-argument private-copy invocation required');
  const admission = loadStatsRecoveryAdmission(argv[0], argv[1]);
  need(admission && admission.databasePath === '/data/pi-indexer-stats-history-trial-20261101/candidate.rocksdb' &&
    admission.sourceDatabasePath === '/data/polkaswap-indexer-recovery-20261101/legacy-db', 'unreviewed initializer target');
  const config = readConfig();
  need(config.storageEngine === 'rocksdb' && config.rocksdbPath === admission.databasePath &&
    config.rocksdbDocumentCompression === 'none', 'exact format-2 candidate configuration required');
  let interrupted = false;
  let repository: RocksRepository | undefined;
  const onStop = () => {
    interrupted = true;
    // close() sets the repository's closing flag synchronously. Its bounded
    // prepare transactions then abort/drain before the final awaited close.
    // Observe rejection here; the finally block retains the actual close error.
    void repository?.close().catch(() => undefined);
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, onStop);
  const deadline = Date.now() + 30 * 60 * 1000;
  const timeout = setTimeout(onStop, 30 * 60 * 1000);
  timeout.unref();
  const checkRunning = () => need(!interrupted && Date.now() < deadline, 'initializer interrupted or deadline reached');
  try {
    const bytes: StatsQualificationBytes = { databaseFiles: await readStatsQualificationFile(argv[2]!),
      nativeAudit: await readStatsQualificationFile(argv[3]!), executorReceipt: await readStatsQualificationFile(argv[4]!) };
    const proof = validateStatsCloneQualification(admission, bytes);
    await verifyStatsCandidateFiles(admission.databasePath, admission.sourceDatabasePath, proof.files, checkRunning);
    checkRunning();
    repository = new RocksRepository(config);
    await repository.prepare();
    checkRunning();
    const seed = await prepareStatsRecoverySeed(repository, admission, bytes);
    checkRunning();
    await repository.upsertMany(seed);
    await requireStatsRecoveryState(repository, admission);
    console.info(JSON.stringify({ schemaVersion: 1, mode: 'canonical-stats-history', database: admission.databasePath,
      initializedRows: seed.map((row) => ({ id: row.id, sha256: statsEvidenceDigest(row) })),
      admissionDigest: statsEvidenceDigest(admission), entitlementsReady: false, workerStarted: false }));
  } finally {
    clearTimeout(timeout);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.off(signal, onStop);
    await repository?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await initializeStatsRecovery(process.argv.slice(2));
}
