import {createHash} from 'node:crypto';
import {mkdir, readFile, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {extractBurnHistory} from './burn-history-extraction.js';
import {prepareBurnRecovery} from './burn-recovery-preparation.js';
import {RECOVERY_CHECKPOINT} from './burn-recovery.js';

const MAX_JSON = 64 * 1024 * 1024;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function bounded(path: string): Promise<Buffer> {
  if ((await stat(path)).size > MAX_JSON) throw new Error('Burn release JSON exceeds bound');
  const bytes = await readFile(path);
  if (bytes.length > MAX_JSON) throw new Error('Burn release JSON grew beyond bound');
  return bytes;
}

/** Fixed offline workflow: authenticate every historical block, use the common
 * live/backfill event extractor, then reproduce the exact packaged ledger.
 * Caller reports and their success booleans are never accepted as execution. */
export async function verifyBurnRelease(options: {
  verifier: string; verifierSha256: string; manifest: string;
  policy: string; policySha256: string; expectedLedger: string; output: string;
}): Promise<Record<string, unknown>> {
  const expected = await bounded(options.expectedLedger);
  const manifest = await bounded(options.manifest);
  const policy = await bounded(options.policy);
  if (digest(policy) !== options.policySha256) throw new Error('Burn allocation policy hash mismatch');
  // mkdir is exclusive; neither an old verification directory nor an old report
  // can satisfy this execution, and failed runs never get the final receipt.
  await mkdir(options.output);
  const verifiedOutput = join(options.output, 'verified-history');
  const capture = join(options.output, 'canonical-receipts.json');
  const ledger = join(options.output, 'rederived-ledger.json');
  await extractBurnHistory({verifier: options.verifier, verifierSha256: options.verifierSha256,
    manifest: options.manifest, verifiedOutput, output: capture});
  const captureSha256 = digest(await bounded(capture));
  await prepareBurnRecovery({capture, captureSha256, policy: options.policy,
    policySha256: options.policySha256, output: ledger});
  const rederived = await bounded(ledger);
  if (!rederived.equals(expected)) throw new Error('Packaged Burn ledger differs from fresh complete rederivation');
  if (!(await bounded(options.expectedLedger)).equals(expected) ||
      !(await bounded(options.manifest)).equals(manifest) || !(await bounded(options.policy)).equals(policy)) {
    throw new Error('Burn release input changed during verification');
  }
  const native = await bounded(join(verifiedOutput, 'verification-complete.json'));
  const result = {
    schema: 'sora-nexus-burn-release-verification-v1', checkpoint: RECOVERY_CHECKPOINT,
    sourceManifestSha256: digest(manifest), allocationPolicySha256: digest(policy),
    expectedLedgerSha256: digest(expected), rederivedLedgerSha256: digest(rederived),
    canonicalReceiptsSha256: captureSha256, nativeVerificationSha256: digest(native),
    nativeVerifierSha256: options.verifierSha256,
    completeHistoryFreshlyVerified: true, sharedEventExtractorExecuted: true,
    exactAllocationRederived: true, ledgerBytesIdentical: true,
    // These conditions are recomputed by allocateRecoveryBurns for every row.
    replacementOwnershipAppliedAfterAllocation: true, attackerCurvePreserved: true,
    mappedNexusRecipientsHeld: true, consensusFinalityVerified: false,
    claimServiceDeploymentVerified: false, productionReady: false,
  };
  await writeFile(join(options.output, 'burn-verification-complete.json'), JSON.stringify(result, null, 2) + '\n', {flag: 'wx'});
  return result;
}
