/** Operator-only Pi COW initializer. No server, worker, RPC client, fallback path or automatic initialization. */
import { execFileSync } from 'node:child_process';
import { statfsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readConfig } from '../config.js';
import { RocksRepository } from '../repository/rocksdb.js';
import { loadStatsRecoveryAdmission, requireStatsRecoveryState, statsEvidenceDigest } from '../stats-recovery.js';
import { PI_STATS_DATABASE, PI_STATS_SOURCE_DATABASE, preparePiStatsRecoverySeed, validatePiStatsQualification,
  type PiStatsQualificationBytes } from '../pi-stats-recovery-admission.js';
import { readStatsQualificationFile, verifyStatsCandidateFiles } from './initialize-stats-recovery.js';
import { parsePiParentIdentity, piParentGuard } from './pi-stats-parent.js';

const EVIDENCE = '/Users/administrator/apps/pi-indexer-recovery-20261009/pi-stats-initialization-20261101/evidence';
const PROOF_NAMES = { databaseFiles: 'database-files.json', nativeAudit: 'source-native.json', executorReceipt: 'pi-qualification.json',
  piCow: 'pi-cow.json', piNativeExecutor: 'pi-source-native-executor.json', piReady: 'pi-source-ready.json',
  mofNormalizedExecutor: 'mof-normalized-executor.json', normalizedBefore: 'mof-normalized-before.json' } as const;
function need(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Pi stats initializer: ${message}`);
}
/** Read only the fixed qualified proof set; raw MOF2 proofs retain their original provenance. */
export async function readPiStatsQualificationBytes(directory: string): Promise<PiStatsQualificationBytes> {
  need(directory === `${EVIDENCE}/qualification` && await realpath(directory) === directory, 'unreviewed proof directory');
  const result = {} as PiStatsQualificationBytes;
  for (const key of Object.keys(PROOF_NAMES) as (keyof PiStatsQualificationBytes)[]) {
    result[key] = await readStatsQualificationFile(`${directory}/${PROOF_NAMES[key]}`);
  }
  return result;
}
/** Only this explicit Pi entrypoint can initialize the exact independently qualified COW target. */
export async function initializePiStatsRecovery(argv: string[]): Promise<void> {
  need(argv.length === 6 && argv[5] === '--apply-private-pi-stats-copy', 'explicit six-argument Pi invocation required');
  need(process.platform === 'darwin' && process.getuid?.() === 501 && process.getgid?.() === 20,
    'exact Pi service UID/platform required');
  need(argv[0] === `${EVIDENCE}/stats-admission.json` && argv[2] === `${EVIDENCE}/qualification` &&
    argv[3] === `${EVIDENCE}/initializer-parent.json`, 'unreviewed Pi input paths');
  need(await realpath(argv[0]!) === argv[0] && await realpath(argv[3]!) === argv[3], 'symlinked Pi inputs');
  const admission = loadStatsRecoveryAdmission(argv[0], argv[1]);
  need(admission && admission.databasePath === PI_STATS_DATABASE && admission.sourceDatabasePath === PI_STATS_SOURCE_DATABASE,
    'unreviewed Pi initializer target');
  const parentCheck = piParentGuard(await readStatsQualificationFile(argv[3]!), argv[4]!, {
    parentPid: () => process.ppid,
    identity: pid => parsePiParentIdentity(execFileSync('/bin/ps', ['-ww', '-p', String(pid), '-o',
      'pid=,uid=,ruid=,pgid=,lstart=,command='], { encoding: 'utf8', timeout: 5000,
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] })),
    availableBytes: () => { const v = statfsSync(PI_STATS_DATABASE, { bigint: true }); return v.bavail * v.bsize; }, now: Date.now,
  });
  parentCheck();
  const config = readConfig();
  need(config.storageEngine === 'rocksdb' && config.rocksdbPath === PI_STATS_DATABASE &&
    config.rocksdbDocumentCompression === 'none', 'exact Pi format-2 configuration required');
  let interrupted = false;
  let repository: RocksRepository | undefined;
  const onStop = () => { interrupted = true; void repository?.close().catch(() => undefined); };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, onStop);
  const deadline = Date.now() + 30 * 60 * 1000;
  const checkRunning = () => { need(!interrupted && Date.now() < deadline, 'interrupted or deadline reached'); parentCheck(); };
  const watchdog = setInterval(() => { try { checkRunning(); } catch { onStop(); } }, 1000);
  watchdog.unref();
  try {
    const bytes = await readPiStatsQualificationBytes(argv[2]!);
    const proof = validatePiStatsQualification(admission, bytes);
    await verifyStatsCandidateFiles(PI_STATS_DATABASE, PI_STATS_SOURCE_DATABASE, proof.files, checkRunning);
    checkRunning();
    repository = new RocksRepository(config);
    await repository.prepare();
    checkRunning();
    const seed = await preparePiStatsRecoverySeed(repository, admission, bytes);
    checkRunning();
    await repository.upsertMany(seed);
    await requireStatsRecoveryState(repository, admission);
    checkRunning();
    console.info(JSON.stringify({ schemaVersion: 1, mode: 'canonical-stats-history', database: PI_STATS_DATABASE,
      initializedRows: seed.map(row => ({ id: row.id, sha256: statsEvidenceDigest(row) })),
      admissionDigest: statsEvidenceDigest(admission), entitlementsReady: false, workerStarted: false }));
  } finally {
    clearInterval(watchdog);
    try { await repository?.close(); }
    finally { for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.off(signal, onStop); }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await initializePiStatsRecovery(process.argv.slice(2));
}
