/** Offline internal-integrity journal transport. Never authenticates historical scoring. */
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateBurnAllocationPolicy, type BurnAllocationPolicy } from '../burn-recovery.js';
import { exportPointJournalRange, initialPointJournalCursor, pointsDigest, validatePointJournalEntry,
  POINT_JOURNAL_MAX_BLOCKS, POINT_JOURNAL_MAX_BYTES, POINT_JOURNAL_MAX_LINE_BYTES,
  type PointJournalCursor, type PointJournalEntry } from '../points-recovery.js';
import { hashFile, inventory, openReadOnly, writeNew } from './export-points-recovery.js';

function need(ok: unknown, reason: string): asserts ok { if (!ok) throw new Error(`Points journal: ${reason}`); }
const json = (value: unknown) => JSON.stringify(value) + '\n';
async function pinnedJson(path: string, digest: string, limit: number) {
  need(/^[0-9a-f]{64}$/.test(digest) && await realpath(path) === resolve(path), 'canonical pinned JSON required');
  const stat = await lstat(path);
  need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= limit, 'JSON file/type/size bound');
  const parts: Buffer[] = []; const hash = createHash('sha256'); let bytes = 0;
  for await (const raw of createReadStream(path, { highWaterMark: 64 * 1024 })) {
    const chunk = raw as Buffer; bytes += chunk.length; need(bytes <= limit, 'JSON grew beyond byte bound');
    hash.update(chunk); parts.push(chunk);
  }
  const sha256 = hash.digest('hex'); need(bytes === stat.size && sha256 === digest, 'parsed JSON pin/size mismatch');
  return { value: JSON.parse(Buffer.concat(parts, bytes).toString('utf8')), pin: { sha256, bytes } };
}
async function policyFile(path: string, digest: string): Promise<BurnAllocationPolicy> {
  const { value: policy } = await pinnedJson(path, digest, 16 * 1024 ** 2);
  need(Object.keys(policy).sort().join(',') === 'attackerAccounts,checkpoint,genesisHash,policyHash,substitutions,version', 'allocation excludes future live fields');
  return validateBurnAllocationPolicy(policy);
}
async function syncDirectory(directory: string) {
  const handle = await open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); }
}
export type JournalExportOptions = { databaseCopy: string; policy: string; policySha256: string; first: number; last: number; output: string };
export async function exportPointJournalFile(options: JournalExportOptions, dependencies: { openRepository?: typeof openReadOnly } = {}) {
  const policy = await policyFile(options.policy, options.policySha256);
  const output = resolve(options.output);
  need(await realpath(dirname(output)) === dirname(output), 'canonical existing output parent required');
  const relation = relative(options.databaseCopy, output);
  need(relation.startsWith('../') || isAbsolute(relation), 'output must be outside database copy');
  const before = await inventory(options.databaseCopy);
  const guard = async () => {
    need(pointsDigest(await inventory(options.databaseCopy)) === pointsDigest(before), 'database copy changed');
    await policyFile(options.policy, options.policySha256);
  };
  await mkdir(output);
  await writeNew(join(output, 'STARTED.json'), { schema: 'sora-nexus-soratopia-journal-export-start-v1', databaseFiles: before,
    policySha256: options.policySha256, first: options.first, last: options.last, readOnlyRequested: true, productionReady: false });
  const repository = await (dependencies.openRepository ?? openReadOnly)(options.databaseCopy);
  let summary;
  try {
    await repository.prepare?.();
    const file = await open(join(output, 'journal.jsonl'), 'wx', 0o600);
    try {
      summary = await exportPointJournalRange(repository, policy, options.first, options.last, async (entry) => { await file.writeFile(json(entry)); });
      await file.sync();
    } finally { await file.close(); }
  } finally { await repository.close(); }
  await guard();
  const journal = await hashFile(join(output, 'journal.jsonl'));
  need(journal.bytes === summary.bytes, 'export bytes mismatch');
  const receipt = { ...summary, policySha256: options.policySha256, journal: { file: 'journal.jsonl', ...journal },
    databaseInventorySha256: pointsDigest(before), readOnlyRequested: true, databaseUnchanged: true };
  const pin = await writeNew(join(output, 'EXPORT.json'), receipt);
  await syncDirectory(output); await guard();
  need(pointsDigest(await hashFile(join(output, 'journal.jsonl'))) === pointsDigest(journal) &&
    pointsDigest(await hashFile(join(output, 'EXPORT.json'))) === pointsDigest(pin), 'published journal changed');
  return { receipt: join(output, 'EXPORT.json'), ...pin, productionReady: false };
}

/** Bounded line decoder: never lets readline allocate an unbounded attacker-controlled line. */
export async function* pointJournalLines(path: string, expected?: { sha256: string; bytes: number }): AsyncGenerator<PointJournalEntry> {
  let parts: Buffer[] = []; let pending = 0; let total = 0; let rows = 0;
  const digest = createHash('sha256');
  for await (const raw of createReadStream(path, { highWaterMark: 64 * 1024 })) {
    const chunk = raw as Buffer; total += chunk.length;
    digest.update(chunk);
    need(total <= POINT_JOURNAL_MAX_BYTES, 'journal file byte bound');
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const part = chunk.subarray(start, newline === -1 ? chunk.length : newline);
      pending += part.length; need(pending <= POINT_JOURNAL_MAX_LINE_BYTES, 'journal line byte bound'); parts.push(part);
      if (newline === -1) break;
      need(pending > 0 && ++rows <= POINT_JOURNAL_MAX_BLOCKS, 'journal line/count bound');
      const bytes = Buffer.concat(parts, pending); const line = bytes.toString('utf8'); const value = JSON.parse(line);
      need(Buffer.from(JSON.stringify(value)).equals(bytes), 'noncanonical, duplicate-key or invalid UTF-8 journal JSON');
      parts = []; pending = 0; start = newline + 1;
      yield value as PointJournalEntry;
    }
  }
  need(pending === 0 && rows > 0, 'truncated or empty journal');
  const sha256 = digest.digest('hex');
  need(!expected || (expected.sha256 === sha256 && expected.bytes === total), 'parsed journal stream differs from its pin');
}
export type JournalValidationOptions = { manifest: string; manifestSha256: string; policy: string; policySha256: string; output: string };
export async function validatePointJournalFile(options: JournalValidationOptions) {
  const policy = await policyFile(options.policy, options.policySha256);
  const { value: manifest, pin: manifestPin } = await pinnedJson(options.manifest, options.manifestSha256, 1024 ** 2);
  need(manifest.schema === 'sora-nexus-soratopia-point-journal-range-v1' && manifest.policySha256 === options.policySha256 &&
    Number.isSafeInteger(manifest.first) && manifest.first >= 1 && Number.isSafeInteger(manifest.last) && manifest.last >= manifest.first &&
    manifest.last <= policy.checkpoint.block && manifest.last - manifest.first + 1 <= POINT_JOURNAL_MAX_BLOCKS &&
    manifest.blocks === manifest.last - manifest.first + 1 && manifest.storageProofsVerified === false && manifest.scoringReexecuted === false &&
    manifest.suppliedSegmentStartAuthenticated === false && manifest.historicalCoverageVerified === false && manifest.externalReplayVerified === false && manifest.productionReady === false &&
    manifest.journal?.file === 'journal.jsonl', 'invalid journal manifest or authentication claim');
  const path = join(dirname(resolve(options.manifest)), 'journal.jsonl');
  need(await realpath(path) === path, 'journal alias forbidden');
  need((await lstat(path)).size <= POINT_JOURNAL_MAX_BYTES, 'journal file byte bound');
  const pin = await hashFile(path);
  need(pointsDigest(pin) === pointsDigest({ sha256: manifest.journal.sha256, bytes: manifest.journal.bytes }) &&
    pin.bytes === manifest.bytes && pin.bytes <= POINT_JOURNAL_MAX_BYTES, 'journal pin/size mismatch');
  let cursor = manifest.start as PointJournalCursor;
  need(cursor?.block === manifest.first - 1, 'wrong journal start');
  if (manifest.first === 1) need(pointsDigest(cursor) === pointsDigest(initialPointJournalCursor(policy)), 'wrong genesis receipt seed');
  let count = 0;
  for await (const entry of pointJournalLines(path, pin)) {
    cursor = validatePointJournalEntry(entry, policy, cursor);
    need(pointsDigest(entry.journal.data.allocation) === pointsDigest(manifest.allocation), 'manifest allocation differs'); count++;
  }
  need(count === manifest.blocks && pointsDigest(cursor) === pointsDigest(manifest.end), 'journal terminal/count mismatch');
  await policyFile(options.policy, options.policySha256);
  need(pointsDigest(await hashFile(path)) === pointsDigest(pin) && pointsDigest(await hashFile(options.manifest)) === pointsDigest(manifestPin), 'journal inputs changed');
  const output = resolve(options.output); need(await realpath(dirname(output)) === dirname(output), 'canonical output parent required');
  const result = { schema: 'sora-nexus-soratopia-journal-validation-v1', manifest: manifestPin, policySha256: options.policySha256,
    journal: pin, first: manifest.first, last: manifest.last, blocks: count, start: manifest.start, end: cursor,
    commitmentChainVerified: true, suppliedSegmentStartAuthenticated: false, storageProofsVerified: false,
    scoringReexecuted: false, historicalCoverageVerified: false, externalReplayVerified: false, productionReady: false };
  const receipt = await writeNew(output, result); await syncDirectory(dirname(output));
  need(pointsDigest(await hashFile(output)) === pointsDigest(receipt), 'validation output changed');
  await policyFile(options.policy, options.policySha256);
  need(pointsDigest(await hashFile(path)) === pointsDigest(pin) && pointsDigest(await hashFile(options.manifest)) === pointsDigest(manifestPin), 'journal inputs changed after publication');
  return { receipt: output, ...receipt, productionReady: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, ...args] = process.argv.slice(2); const flags = new Map<string, string>();
  const required = mode === 'export' ? ['--database-copy', '--policy', '--policy-sha256', '--first', '--last', '--output'] :
    mode === 'validate' ? ['--manifest', '--manifest-sha256', '--policy', '--policy-sha256', '--output'] : [];
  need(required.length > 0, 'use export or validate with explicit pinned paths and a new output');
  for (let i = 0; i < args.length; i += 2) {
    need(required.includes(args[i]) && args[i + 1] && !flags.has(args[i]), 'unknown, duplicate or missing argument'); flags.set(args[i], args[i + 1]);
  }
  need(flags.size === required.length, 'all arguments required');
  const common = { policy: flags.get('--policy')!, policySha256: flags.get('--policy-sha256')!, output: flags.get('--output')! };
  if (mode === 'export') {
    for (const name of ['--first', '--last']) need(/^[1-9][0-9]*$/.test(flags.get(name)!), 'canonical positive block numbers required');
    process.stdout.write(json(await exportPointJournalFile({ ...common, databaseCopy: flags.get('--database-copy')!, first: Number(flags.get('--first')), last: Number(flags.get('--last')) })));
  } else process.stdout.write(json(await validatePointJournalFile({ ...common, manifest: flags.get('--manifest')!, manifestSha256: flags.get('--manifest-sha256')! })));
}
