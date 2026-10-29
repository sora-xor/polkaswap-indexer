import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { allocateRecoveryBurns, loadBurnAllocationPolicy, RECOVERY_CHECKPOINT, SOLSWAP_START_BLOCK, type CanonicalBurnReceipt } from './burn-recovery.js';
import { isNonzeroCanonicalSubstrateHash } from './soraIdentity.js';

/**
 * Compiles an externally verified event capture without touching an indexer database.
 * Capture SHA-256 and coverage-evidence hash must be bound by the reviewed release.
 * Neither declarations nor this compiler alone prove event-stream completeness.
 */
export async function prepareBurnRecovery(options: {
  capture: string; captureSha256: string; policy: string; policySha256: string; output: string;
}): Promise<void> {
  const policy = loadBurnAllocationPolicy(options.policy, options.policySha256);
  const bytes = await readFile(options.capture);
  if (!/^[a-f0-9]{64}$/.test(options.captureSha256) || createHash('sha256').update(bytes).digest('hex') !== options.captureSha256) {
    throw new Error('Burn capture SHA-256 mismatch');
  }
  const capture = JSON.parse(bytes.toString('utf8')) as {
    version: number; checkpoint: { block: number; hash: string };
    coverage: { firstBlock: number; lastBlock: number; evidenceHash: string };
    receipts: CanonicalBurnReceipt[];
  };
  if (capture.version !== 1 || capture.checkpoint?.block !== RECOVERY_CHECKPOINT.block || capture.checkpoint.hash !== RECOVERY_CHECKPOINT.hash ||
      capture.coverage?.firstBlock !== SOLSWAP_START_BLOCK || capture.coverage.lastBlock !== RECOVERY_CHECKPOINT.block ||
      !isNonzeroCanonicalSubstrateHash(capture.coverage.evidenceHash) || !Array.isArray(capture.receipts)) throw new Error('Incomplete checkpoint burn capture');
  const entitlements = allocateRecoveryBurns(capture.receipts, policy);
  const encoded = JSON.stringify(entitlements);
  const output = {
    schema: 'sora-nexus.burn-recovery-ledger', version: 1, status: 'prepared-requires-release-verification',
    checkpoint: RECOVERY_CHECKPOINT, policyHash: policy.policyHash, allocationPolicySha256: options.policySha256,
    sourceCaptureSha256: options.captureSha256, coverage: capture.coverage,
    receiptCount: entitlements.length, entitlementsSha256: createHash('sha256').update(encoded).digest('hex'), entitlements,
  };
  // Exclusive creation ensures no original database/export is overwritten accidentally.
  await writeFile(options.output, `${JSON.stringify(output, null, 2)}\n`, { flag: 'wx' });
}

