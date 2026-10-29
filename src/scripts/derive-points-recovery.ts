import { createHash } from 'node:crypto';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RECOVERY_CHECKPOINT, validateBurnAllocationPolicy } from '../burn-recovery.js';
import { deriveCheckpointPointLedger, pointsDigest, type CheckpointPointOwnerSource } from '../points-recovery.js';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const need = (ok: unknown, message: string): void => { if (!ok) throw new Error(`Point derivation: ${message}`); };
async function pinned(path: string, expected: string, limit: number) {
  need(/^[0-9a-f]{64}$/.test(expected) && await realpath(path) === resolve(path), 'input path/hash must be explicit and unaliased');
  const stat = await lstat(path);
  need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= limit, 'input file/type/size bound');
  const bytes = await readFile(path); need(sha(bytes) === expected, 'input SHA-256 mismatch');
  return bytes;
}
export type PointDerivationOptions = { policy: string; policySha256: string; capture: string; captureSha256: string; output: string };
/** Pure pre-release data preparation. Caller-supplied source records are NEVER finality/replay evidence. */
export async function derivePointRecoveryFile(options: PointDerivationOptions) {
  const policyBytes = await pinned(options.policy, options.policySha256, 16 * 1024 * 1024);
  const sourceBytes = await pinned(options.capture, options.captureSha256, 64 * 1024 * 1024);
  const policy = validateBurnAllocationPolicy(JSON.parse(policyBytes.toString('utf8')));
  const capture = JSON.parse(sourceBytes.toString('utf8'));
  need(capture?.schema === 'sora-nexus-soratopia-checkpoint-owner-sources-v1' &&
    pointsDigest(capture.checkpoint) === pointsDigest(RECOVERY_CHECKPOINT) &&
    typeof capture.checkpointReceiptRoot === 'string' && Array.isArray(capture.sources), 'invalid checkpoint source capture');
  const ledger = deriveCheckpointPointLedger(policy, capture.checkpointReceiptRoot, capture.sources as CheckpointPointOwnerSource[]);
  const bytes = Buffer.from(JSON.stringify(ledger, null, 2) + '\n');
  const output = resolve(options.output); need(await realpath(dirname(output)) === dirname(output), 'output parent is aliased');
  await pinned(options.policy, options.policySha256, 16 * 1024 * 1024);
  await pinned(options.capture, options.captureSha256, 64 * 1024 * 1024);
  const file = await open(output, 'wx', 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  const dir = await open(dirname(output), 'r'); try { await dir.sync(); } finally { await dir.close(); }
  await pinned(options.policy, options.policySha256, 16 * 1024 * 1024);
  await pinned(options.capture, options.captureSha256, 64 * 1024 * 1024);
  need(sha(await readFile(output)) === sha(bytes), 'output changed after write');
  return { schema: 'sora-nexus-soratopia-pure-derivation-v1', output, sha256: sha(bytes), bytes: bytes.length,
    policySha256: options.policySha256, sourceCaptureSha256: options.captureSha256,
    futureAnchorRequired: false, externalReplayVerified: false, productionReady: false };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const flags = new Map<string, string>(); const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    need(['--policy', '--policy-sha256', '--capture', '--capture-sha256', '--output'].includes(args[i]) && args[i + 1] && !flags.has(args[i]),
      'Use --policy ALLOCATION_JSON --policy-sha256 SHA256 --capture SOURCE_JSON --capture-sha256 SHA256 --output NEW_FILE');
    flags.set(args[i], args[i + 1]);
  }
  need(flags.size === 5, 'all five explicit arguments are required');
  process.stdout.write(JSON.stringify(await derivePointRecoveryFile({ policy: flags.get('--policy')!, policySha256: flags.get('--policy-sha256')!,
    capture: flags.get('--capture')!, captureSha256: flags.get('--capture-sha256')!, output: flags.get('--output')! })) + '\n');
}
