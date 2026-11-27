import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ATTACKER_ACCOUNT, RECOVERY_CHECKPOINT, type BurnAllocationPolicy} from '../src/burn-recovery.js';
import {SORA_MAINNET_GENESIS_HASH} from '../src/soraIdentity.js';
import {prepareBurnRecovery} from '../src/burn-recovery-preparation.js';
import {extractBurnHistory} from '../src/burn-history-extraction.js';
import {verifyBurnRelease} from '../src/burn-release-verification.js';

// These orchestration fixtures do not establish real history or production
// readiness. Proof correctness belongs to the native verifier's separate tests.
vi.mock('../src/burn-history-extraction.js', () => ({extractBurnHistory: vi.fn()}));
const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
let directory: string;
beforeEach(async () => {directory = await mkdtemp(join(tmpdir(), 'sora-nexus-burn-release-')); vi.resetAllMocks();});
afterEach(async () => {await rm(directory, {recursive: true, force: true});});

async function fixture() {
  const policy: BurnAllocationPolicy = {version: 1, policyHash: h(9), genesisHash: SORA_MAINNET_GENESIS_HASH,
    checkpoint: RECOVERY_CHECKPOINT, substitutions: [{old: h(1), new: h(2)}], attackerAccounts: [ATTACKER_ACCOUNT]};
  const capture = {version: 1, checkpoint: RECOVERY_CHECKPOINT,
    coverage: {firstBlock: 25_043_003, lastBlock: RECOVERY_CHECKPOINT.block, evidenceHash: h(8)},
    receipts: [
      {id: `${h(3)}:0`, blockHash: h(3), eventIndex: 0, blockHeight: 27_720_479,
        extrinsicIndex: 0, txHash: h(4), address: ATTACKER_ACCOUNT, amount: '1', campaign: 'tonswap'},
      {id: `${h(3)}:1`, blockHash: h(3), eventIndex: 1, blockHeight: 27_720_479,
        extrinsicIndex: 1, txHash: h(5), address: h(1), amount: '2', campaign: 'tonswap'},
      {id: `${h(3)}:2`, blockHash: h(3), eventIndex: 2, blockHeight: 27_720_479,
        extrinsicIndex: 2, txHash: h(6), address: h(1), amount: '3', nexusRecipient: 'historical-evidence'},
    ]};
  const policyBytes = Buffer.from(JSON.stringify(policy));
  const captureBytes = Buffer.from(JSON.stringify(capture));
  const policyPath = join(directory, 'policy.json'), capturePath = join(directory, 'capture.json');
  const expectedLedger = join(directory, 'ledger.json'), manifest = join(directory, 'manifest.json');
  await writeFile(policyPath, policyBytes); await writeFile(capturePath, captureBytes);
  await writeFile(manifest, '{"syntheticHistory":true}');
  await prepareBurnRecovery({capture: capturePath, captureSha256: sha(captureBytes), policy: policyPath,
    policySha256: sha(policyBytes), output: expectedLedger});
  vi.mocked(extractBurnHistory).mockImplementation(async options => {
    await mkdir(options.verifiedOutput);
    await writeFile(join(options.verifiedOutput, 'verification-complete.json'), '{"syntheticNativeProof":true}');
    await writeFile(options.output, captureBytes, {flag: 'wx'});
  });
  return {verifier: '/explicit/pinned-native-verifier', verifierSha256: '1'.repeat(64), manifest,
    policy: policyPath, policySha256: sha(policyBytes), expectedLedger, output: join(directory, 'new-verification')};
}

describe('fixed Burn release workflow', () => {
  it('freshly extracts and rederives exact mapped, held and extinguished allocations', async () => {
    const options = await fixture();
    const report = await verifyBurnRelease(options);
    expect(extractBurnHistory).toHaveBeenCalledExactlyOnceWith({verifier: options.verifier,
      verifierSha256: options.verifierSha256, manifest: options.manifest,
      verifiedOutput: join(options.output, 'verified-history'), output: join(options.output, 'canonical-receipts.json')});
    expect(report).toMatchObject({ledgerBytesIdentical: true, productionReady: false,
      consensusFinalityVerified: false, claimServiceDeploymentVerified: false,
      expectedLedgerSha256: sha(await readFile(options.expectedLedger))});
    const ledger = JSON.parse(await readFile(join(options.output, 'rederived-ledger.json'), 'utf8'));
    expect(ledger.entitlements[0]).toMatchObject({claimStatus: 'extinguished', tsClaimable: '0'});
    expect(ledger.entitlements[1]).toMatchObject({claimOwner: h(2)});
    expect(ledger.entitlements[2]).toMatchObject({claimOwner: h(2), ssAllocated: '150',
      claimStatus: 'recipient-confirmation-required', nexusXorAllocated: '3', nexusXorClaimable: '0'});
  });
  it('rejects a changed allocation despite supplied pass flags', async () => {
    const options = await fixture();
    await writeFile(options.expectedLedger, '{"productionReady":true,"ledgerBytesIdentical":true}');
    await expect(verifyBurnRelease(options)).rejects.toThrow('differs from fresh complete rederivation');
    await expect(readFile(join(options.output, 'burn-verification-complete.json'))).rejects.toThrow();
  });
  it('rejects bad native proof and never reuses an old completion directory', async () => {
    const options = await fixture();
    vi.mocked(extractBurnHistory).mockRejectedValue(new Error('native storage proof rejected'));
    await expect(verifyBurnRelease(options)).rejects.toThrow('native storage proof rejected');
    await expect(readFile(join(options.output, 'burn-verification-complete.json'))).rejects.toThrow();
    await expect(verifyBurnRelease(options)).rejects.toThrow();
    expect(extractBurnHistory).toHaveBeenCalledTimes(1);
  });
});
