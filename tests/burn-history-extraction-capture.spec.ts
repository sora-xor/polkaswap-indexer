import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {access, chmod, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gunzipSync, gzipSync} from 'node:zlib';
import {expandMetadata, Metadata, TypeRegistry} from '@polkadot/types';
import type {Call, Extrinsic} from '@polkadot/types/interfaces';
import {u8aConcat} from '@polkadot/util';
import {blake2AsHex} from '@polkadot/util-crypto';
import soraTypes from '../src/runtime/sora-legacy-types.json' with {type: 'json'};
import {canonicalAccount, SOLSWAP_START_BLOCK} from '../src/burn-recovery.js';
import {extractBurnHistory} from '../src/burn-history-extraction.js';

// The real checkpoint lies 3,148,815 blocks after SOLSWAP_START_BLOCK. Shortening only the checkpoint range lets a
// three-block stream reach the terminal-hash comparison and the capture write, with every other check unchanged.
const range = vi.hoisted(() => ({checkpoint: {block: 0, hash: ''}}));
vi.mock('../src/burn-recovery.js', async (importOriginal) =>
  ({...(await importOriginal<typeof import('../src/burn-recovery.js')>()), RECOVERY_CHECKPOINT: range.checkpoint}));

const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const soraMetadata = gunzipSync(readFileSync(new URL('./fixtures/recovery-134/original-134.metadata.scale.gz', import.meta.url)));
const minimalMetadata = Buffer.from(new Metadata(new TypeRegistry(), {magicNumber: 0x6174656d, metadata: {v14: {
  lookup: {types: [{id: 0, type: {path: [], params: [], def: {Primitive: 'U8'}, docs: []}}]},
  pallets: [], extrinsic: {type: 0, version: 4, signedExtensions: []}, type: 0}}}).toU8a());
const XOR = `0x02${'00'.repeat(31)}`, VAL = `0x0200040000${'00'.repeat(27)}`, ONE = 10n ** 18n;
const alice = `0x${'aa'.repeat(32)}`, bob = `0x${'bb'.repeat(32)}`, carol = `0x${'cc'.repeat(32)}`, dave = `0x${'dd'.repeat(32)}`;
const nexusRecipient = `0x${'cd'.repeat(20)}`;
const SORA_CODE = h(0x134), EMPTY_CODE = h(0x135);
const S = SOLSWAP_START_BLOCK;
const VERIFIER = '#!/bin/sh\nexit 0\n';

/** Three linked blocks: two runtime-134 blocks with XOR burns, then an empty block executed under another witness. */
function linkedStream() {
  const registry = new TypeRegistry(); registry.register(soraTypes);
  const metadata = new Metadata(registry, soraMetadata); registry.setMetadata(metadata);
  const {tx, events} = expandMetadata(registry, metadata);
  const assets = metadata.asLatest.pallets.find(pallet => pallet.name.eq('Assets'))!;
  const burnMeta = events.assets.Burn.meta;
  const assetIdType = registry.createLookupType(burnMeta.fields[1].type);
  const burnEvent = (who: string, asset: string, amount: bigint) => u8aConcat([assets.index.toNumber(), burnMeta.index.toNumber()],
    registry.createType('AccountId32', who).toU8a(), registry.createType(assetIdType, {code: asset}).toU8a(), registry.createType('u128', amount).toU8a());
  const applied = (records: Array<[number, Uint8Array]>) => registry.createType('Vec<EventRecord>',
    records.map(([index, event]) => ({phase: {ApplyExtrinsic: index}, event, topics: []}))).toHex();
  const extrinsic = (call: Call) => registry.createType<Extrinsic>('Extrinsic', call);
  const burnCall = (amount: bigint) => tx.assets.burn({code: XOR}, amount);
  const tonswap = extrinsic(tx.utility.batchAll([burnCall(ONE), tx.system.remark(JSON.stringify({app: 'polkaswap', kind: 'tonswap-xor-burn', version: 1}))]));
  const nexus = extrinsic(tx.utility.batchAll([burnCall(5n * ONE / 2n), tx.system.remark(JSON.stringify({type: 'soraNexusXorClaim', version: 1, recipient: nexusRecipient}))]));
  const plain = extrinsic(burnCall(3n * ONE)), later = extrinsic(burnCall(4n * ONE));
  const record = (height: number, parentHash: string, extrinsics: Extrinsic[], eventsHex: string, code = SORA_CODE, metadataSha256 = sha(soraMetadata)) => {
    const header = registry.createType('Header', {number: height, parentHash, stateRoot: h(2), extrinsicsRoot: h(3), digest: {logs: []}});
    return {hash: header.hash.toHex(), block: {block: {header: header.toJSON(), extrinsics: extrinsics.map(item => item.toHex())}, justifications: null},
      events: eventsHex, executingCodeHash: code, metadataSha256};
  };
  const first = record(S, h(1), [tonswap, nexus, plain], applied([
    [0, burnEvent(alice, XOR, ONE)], [1, burnEvent(bob, XOR, 5n * ONE / 2n)], [2, burnEvent(carol, VAL, ONE)], [2, burnEvent(carol, XOR, 3n * ONE)]]));
  const second = record(S + 1, first.hash, [later], applied([[0, burnEvent(dave, XOR, 4n * ONE)]]));
  const third = record(S + 2, second.hash, [], '0x00', EMPTY_CODE, sha(minimalMetadata));
  const address = (account: string) => registry.createType('AccountId32', account).toString();
  // Key order mirrors the extractor's receipt projection so the serialized capture can be compared byte for byte.
  const receipt = (block: {hash: string}, blockHeight: number, eventIndex: number, extrinsicIndex: number, item: Extrinsic,
    account: string, amount: string, extra: Record<string, string> = {}) => ({id: `${block.hash}:${eventIndex}`, blockHash: block.hash,
    eventIndex, blockHeight, extrinsicIndex, txHash: item.hash.toHex(), address: address(account), amount, ...extra});
  const receipts = [
    receipt(first, S, 0, 0, tonswap, alice, '1', {campaign: 'tonswap'}),
    receipt(first, S, 1, 1, nexus, bob, '2.5', {nexusRecipient}),
    receipt(first, S, 3, 2, plain, carol, '3'),
    receipt(second, S + 1, 0, 0, later, dave, '4'),
  ];
  return {first, second, third, receipts};
}
let built: ReturnType<typeof linkedStream> | undefined;
const stream = () => (built ??= linkedStream());

describe('complete Burn history capture over a shortened checkpoint range', () => {
  let directory: string, verified: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'burn-history-capture-'));
    verified = join(directory, 'verified'); await mkdir(verified);
  });
  afterEach(async () => {await rm(directory, {recursive: true, force: true});});

  const put = async (file: string, bytes: Uint8Array | string) => {
    await writeFile(join(verified, file), bytes); return {file, sha256: sha(bytes)};
  };
  /** Stages the linked stream as two pages (one record, then two) with one metadata witness per execution code. */
  async function prepare(linked: ReturnType<typeof linkedStream>, checkpointHash: string, tail = [linked.second, linked.third]) {
    range.checkpoint.block = S + 2; range.checkpoint.hash = checkpointHash;
    const verifier = join(directory, 'verifier'); await writeFile(verifier, VERIFIER); await chmod(verifier, 0o755);
    const manifest = join(directory, 'manifest.json'), manifestBytes = '{"syntheticHistory":true}';
    await writeFile(manifest, manifestBytes);
    const report = JSON.stringify({schema: 'sora-nexus-verified-burn-stream-v1', first: S, last: S + 2, checkpointHash,
      sourceManifestSha256: sha(manifestBytes), coverageComplete: true, blockCount: 3, headersLinkedToCheckpoint: true,
      extrinsicsRootsVerified: true, storageProofsVerified: true, metadataExecutedFromAuthenticatedParentCode: true, nativeExecution: false,
      pages: [
        await put('page-0.json.gz', gzipSync(JSON.stringify({schema: 'sora-nexus-verified-burn-page-v1', first: S, records: [linked.first]}))),
        await put('page-1.json.gz', gzipSync(JSON.stringify({schema: 'sora-nexus-verified-burn-page-v1', first: S + 1, records: tail}))),
      ],
      metadata: [
        {codeHash: SORA_CODE, specVersion: 134, metadata: await put('runtime-134.scale', soraMetadata)},
        {codeHash: EMPTY_CODE, specVersion: 134, metadata: await put('minimal.scale', minimalMetadata)},
      ]});
    await writeFile(join(verified, 'verification-complete.json'), report);
    return {options: {verifier, verifierSha256: sha(VERIFIER), manifest, verifiedOutput: verified, output: join(directory, 'canonical-receipts.json')},
      report, manifestBytes};
  }

  it('writes the exact capture for linked runtime-134 records accumulated across pages', async () => {
    const linked = stream();
    const {options, report, manifestBytes} = await prepare(linked, linked.third.hash);
    await extractBurnHistory(options);
    const expected = {version: 1, checkpoint: {block: S + 2, hash: linked.third.hash},
      coverage: {firstBlock: S, lastBlock: S + 2, evidenceHash: blake2AsHex(Buffer.from(report), 256)}, receipts: linked.receipts,
      verification: {verifierSha256: sha(VERIFIER), reportSha256: sha(report), sourceManifestSha256: sha(manifestBytes),
        independentStorageProofs: true, consensusFinalityVerified: false}};
    const written = await readFile(options.output, 'utf8');
    expect(written).toBe(`${JSON.stringify(expected, null, 2)}\n`);
    const capture = JSON.parse(written) as {receipts: Array<{address: string; blockHeight: number; eventIndex: number}>};
    expect(capture.receipts.map(receipt => [receipt.blockHeight, receipt.eventIndex, canonicalAccount(receipt.address)]))
      .toEqual([[S, 0, alice], [S, 1, bob], [S, 3, carol], [S + 1, 0, dave]]);
  }, 30_000);

  it('rejects a fully linked stream whose terminal block is not the pinned checkpoint hash', async () => {
    const {options} = await prepare(stream(), h(0xdead));
    await expect(extractBurnHistory(options)).rejects.toThrow('Burn extraction did not reach the checkpoint');
    expect(await access(options.output).then(() => true, () => false)).toBe(false);
  }, 30_000);

  it('rejects a valid linked nonempty stream that stops one block before the pinned checkpoint', async () => {
    const linked = stream();
    // Both remaining records decode and link; the report still pins the dropped third block as the checkpoint.
    const {options} = await prepare(linked, linked.third.hash, [linked.second]);
    await expect(extractBurnHistory(options)).rejects.toThrow('Burn extraction did not reach the checkpoint');
    expect(await access(options.output).then(() => true, () => false)).toBe(false);
  }, 30_000);
});
