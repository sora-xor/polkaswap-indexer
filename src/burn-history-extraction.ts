import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile, stat, realpath, writeFile} from 'node:fs/promises';
import {resolve, join, sep} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {Metadata, TypeRegistry} from '@polkadot/types';
import type {SignedBlock, EventRecord} from '@polkadot/types/interfaces';
import {blake2AsHex} from '@polkadot/util-crypto';
import {types as soraTypes} from '@sora-substrate/type-definitions';
import {createXorBurnDocumentsFromEvents} from './worker/chain.js';
import {RECOVERY_CHECKPOINT, SOLSWAP_START_BLOCK, type CanonicalBurnReceipt} from './burn-recovery.js';

const exec = promisify(execFile);
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const MAX_BYTES = 64 * 1024 * 1024;
type Artifact = {file: string; sha256: string};
type MetadataWitness = {codeHash: string; metadata: Artifact; specVersion: number};
type VerifiedRecord = {hash: string; block: unknown; events: string; executingCodeHash: string; metadataSha256: string};
function ensure(condition: unknown, message: string): asserts condition {if (!condition) throw new Error(message);}

async function bounded(path: string): Promise<Buffer> {
  ensure((await stat(path)).size <= MAX_BYTES, 'Burn artifact exceeds size bound');
  const bytes = await readFile(path);
  ensure(bytes.length <= MAX_BYTES, 'Burn artifact grew beyond size bound');
  return bytes;
}
async function artifact(root: string, reference: Artifact): Promise<Buffer> {
  ensure(typeof reference.file === 'string' && /^[a-f0-9]{64}$/.test(reference.sha256), 'Invalid burn artifact reference');
  const base = await realpath(root), path = await realpath(resolve(root, reference.file));
  ensure(path.startsWith(base + sep), 'Burn artifact escapes verified directory');
  const bytes = await bounded(path);
  ensure(digest(bytes) === reference.sha256, 'Verified burn artifact checksum differs');
  return bytes;
}

/** Pure decoder used only after the native verifier has authenticated these bytes.
 * The same createXorBurnDocumentsFromEvents function serves live and backfill. */
export function decodeAuthenticatedBurnRecord(record: VerifiedRecord, registry: TypeRegistry): {height: number; parentHash: string; receipts: CanonicalBurnReceipt[]} {
  ensure(/^0x[0-9a-f]{64}$/.test(record.hash) && /^0x(?:[0-9a-f]{2})+$/.test(record.events), 'Invalid verified burn bytes');
  const signedBlock = registry.createType<SignedBlock>('SignedBlock', record.block);
  ensure(signedBlock.block.header.hash.toHex() === record.hash, 'Verified burn header changed');
  const events = registry.createType('Vec<EventRecord>', record.events);
  ensure(events.toHex() === record.events, 'Historical events do not roundtrip under parent metadata');
  const height = signedBlock.block.header.number.toNumber();
  const rows = createXorBurnDocumentsFromEvents(record.hash, height, null, signedBlock,
    Array.from(events) as EventRecord[], new Map());
  const receipts = rows.map(row => {
    const data = row.data;
    ensure(Number.isSafeInteger(data.extrinsicIndex) && Number(data.extrinsicIndex) >= 0 &&
      typeof data.txHash === 'string' && /^0x[0-9a-f]{64}$/.test(data.txHash),
    'Burn event has no authenticated extrinsic association');
    return {id: row.id, blockHash: record.hash, eventIndex: Number(data.eventIndex), blockHeight: height,
      extrinsicIndex: Number(data.extrinsicIndex), txHash: data.txHash, address: String(data.address), amount: String(data.amount),
      ...(data.campaign === 'tonswap' ? {campaign: 'tonswap' as const} : {}),
      ...(typeof data.nexusRecipient === 'string' ? {nexusRecipient: data.nexusRecipient} : {}),
    };
  });
  return {height, parentHash: signedBlock.block.header.parentHash.toHex(), receipts};
}

/** Executes a SHA-pinned native verifier afresh. Caller-supplied pass flags or an
 * old verification JSON cannot substitute for proof execution. No RPC/database. */
export async function extractBurnHistory(options: {
  verifier: string; verifierSha256: string; manifest: string; verifiedOutput: string; output: string;
}): Promise<void> {
  ensure(/^[a-f0-9]{64}$/.test(options.verifierSha256) && digest(await readFile(options.verifier)) === options.verifierSha256,
    'Native burn verifier SHA-256 mismatch');
  await exec(resolve(options.verifier), ['verify-burn-history', '--manifest', resolve(options.manifest),
    '--output', resolve(options.verifiedOutput)], {maxBuffer: MAX_BYTES});
  const reportBytes = await bounded(join(options.verifiedOutput, 'verification-complete.json'));
  const report = JSON.parse(reportBytes.toString('utf8')) as {
    schema: string; first: number; last: number; checkpointHash: string; sourceManifestSha256: string;
    coverageComplete: boolean; blockCount: number; headersLinkedToCheckpoint: boolean; extrinsicsRootsVerified: boolean;
    storageProofsVerified: boolean; metadataExecutedFromAuthenticatedParentCode: boolean; nativeExecution: boolean;
    pages: Artifact[]; metadata: MetadataWitness[];
  };
  ensure(report.schema === 'sora-nexus-verified-burn-stream-v1' && report.first === SOLSWAP_START_BLOCK &&
    report.last === RECOVERY_CHECKPOINT.block && report.checkpointHash === RECOVERY_CHECKPOINT.hash && report.coverageComplete &&
    report.blockCount === RECOVERY_CHECKPOINT.block - SOLSWAP_START_BLOCK + 1 && report.headersLinkedToCheckpoint &&
    report.extrinsicsRootsVerified && report.storageProofsVerified && report.metadataExecutedFromAuthenticatedParentCode &&
    report.nativeExecution === false && Array.isArray(report.pages) && Array.isArray(report.metadata),
  'Complete independently verified checkpoint burn history is required');
  ensure(digest(await bounded(options.manifest)) === report.sourceManifestSha256, 'Burn source manifest changed during verification');
  const registries = new Map<string, {registry: TypeRegistry; metadataSha256: string}>();
  for (const witness of report.metadata) {
    ensure(/^0x[0-9a-f]{64}$/.test(witness.codeHash) && !registries.has(witness.codeHash), 'Duplicate or invalid execution code witness');
    const bytes = await artifact(options.verifiedOutput, witness.metadata);
    const registry = new TypeRegistry(); registry.register(soraTypes); registry.setMetadata(new Metadata(registry, bytes));
    registries.set(witness.codeHash, {registry, metadataSha256: witness.metadata.sha256});
  }
  const receipts: CanonicalBurnReceipt[] = []; let next = SOLSWAP_START_BLOCK; let previousHash: string | undefined;
  for (const reference of report.pages) {
    const bytes = await artifact(options.verifiedOutput, reference);
    const page = JSON.parse(gunzipSync(bytes, {maxOutputLength: MAX_BYTES}).toString('utf8')) as {
      schema: string; first: number; records: VerifiedRecord[];
    };
    ensure(page.schema === 'sora-nexus-verified-burn-page-v1' && page.first === next && Array.isArray(page.records) &&
      page.records.length > 0 && page.records.length <= 16, 'Invalid verified burn page range');
    for (const record of page.records) {
      const witness = registries.get(record.executingCodeHash);
      ensure(witness && witness.metadataSha256 === record.metadataSha256, 'Unbound parent execution metadata');
      const decoded = decodeAuthenticatedBurnRecord(record, witness.registry);
      ensure(decoded.height === next && (previousHash === undefined || decoded.parentHash === previousHash), 'Verified burn stream has a gap');
      receipts.push(...decoded.receipts); previousHash = record.hash; next += 1;
    }
  }
  ensure(next === RECOVERY_CHECKPOINT.block + 1 && previousHash === RECOVERY_CHECKPOINT.hash, 'Burn extraction did not reach the checkpoint');
  const capture = {version: 1, checkpoint: RECOVERY_CHECKPOINT, coverage: {firstBlock: SOLSWAP_START_BLOCK,
    lastBlock: RECOVERY_CHECKPOINT.block, evidenceHash: blake2AsHex(reportBytes, 256)}, receipts,
    verification: {verifierSha256: options.verifierSha256, reportSha256: digest(reportBytes),
      sourceManifestSha256: report.sourceManifestSha256, independentStorageProofs: true, consensusFinalityVerified: false}};
  await writeFile(options.output, JSON.stringify(capture, null, 2) + '\n', {flag: 'wx'});
}

