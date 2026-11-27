import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {access, chmod, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gunzipSync, gzipSync} from 'node:zlib';
import {expandMetadata, Metadata, TypeRegistry} from '@polkadot/types';
import type {Call, Extrinsic} from '@polkadot/types/interfaces';
import substrateMetadata from '@polkadot/types-support/metadata/v14/substrate-hex';
import {u8aConcat} from '@polkadot/util';
import soraTypes from '../src/runtime/sora-legacy-types.json' with {type: 'json'};
import {canonicalAccount, RECOVERY_CHECKPOINT, SOLSWAP_START_BLOCK} from '../src/burn-recovery.js';
import {decodeAuthenticatedBurnRecord, extractBurnHistory} from '../src/scripts/extract-burn-history.js';

const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
describe('authenticated Burn stream decoding', () => {
  it('uses the explicitly supplied registry and rejects changed headers and trailing event bytes', () => {
    const registry = new TypeRegistry(); registry.setMetadata(new Metadata(registry, substrateMetadata));
    const header = registry.createType('Header', {number: 25_043_003, parentHash:h(1), stateRoot:h(2), extrinsicsRoot:h(3), digest:{logs:[]}});
    const record = {hash:header.hash.toHex(),block:{block:{header:header.toJSON(),extrinsics:[]},justifications:null},
      events:'0x00',executingCodeHash:h(4),metadataSha256:'5'.repeat(64)};
    expect(decodeAuthenticatedBurnRecord(record,registry)).toMatchObject({height:25_043_003,parentHash:h(1),receipts:[]});
    expect(() => decodeAuthenticatedBurnRecord({...record,hash:h(8)},registry)).toThrow('header changed');
    expect(() => decodeAuthenticatedBurnRecord({...record,events:'0x0000'},registry)).toThrow('roundtrip');
  });
  it('cannot accept an old JSON success report in place of a fresh pinned verifier', async () => {
    await expect(extractBurnHistory({verifier:'/does/not/exist',verifierSha256:'invalid',manifest:'unused',
      verifiedOutput:'unused',output:'unused'})).rejects.toThrow('SHA-256');
  });
});

// Real SORA runtime-134 metadata, decoded with the locally owned legacy schema exactly as the extractor does.
const soraMetadata = gunzipSync(readFileSync(new URL('./fixtures/recovery-134/original-134.metadata.scale.gz', import.meta.url)));
// A synthetic, palletless V14 metadata: enough for header/empty-event linkage checks without a full runtime decode.
const minimalMetadata = Buffer.from(new Metadata(new TypeRegistry(), {magicNumber: 0x6174656d, metadata: {v14: {
  lookup: {types: [{id: 0, type: {path: [], params: [], def: {Primitive: 'U8'}, docs: []}}]},
  pallets: [], extrinsic: {type: 0, version: 4, signedExtensions: []}, type: 0}}}).toU8a());
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const XOR = `0x02${'00'.repeat(31)}`, VAL = `0x0200040000${'00'.repeat(27)}`, ONE = 10n ** 18n;
const alice = `0x${'aa'.repeat(32)}`, bob = `0x${'bb'.repeat(32)}`, carol = `0x${'cc'.repeat(32)}`;
const nexusRecipient = `0x${'cd'.repeat(20)}`;
const CODE = h(0x134), OTHER_CODE = h(0x135);

let sora: ReturnType<typeof soraRuntime> | undefined;
function soraRuntime() {
  const registry = new TypeRegistry(); registry.register(soraTypes);
  const metadata = new Metadata(registry, soraMetadata); registry.setMetadata(metadata);
  const {tx, events} = expandMetadata(registry, metadata);
  const assets = metadata.asLatest.pallets.find(pallet => pallet.name.eq('Assets'))!;
  const burnMeta = events.assets.Burn.meta;
  const assetIdType = registry.createLookupType(burnMeta.fields[1].type);
  const burnEvent = (who: string, asset: string, amount: bigint) => u8aConcat([assets.index.toNumber(), burnMeta.index.toNumber()],
    registry.createType('AccountId32', who).toU8a(), registry.createType(assetIdType, {code: asset}).toU8a(), registry.createType('u128', amount).toU8a());
  const eventRecords = (records: Array<{phase: unknown; event: Uint8Array}>) =>
    registry.createType('Vec<EventRecord>', records.map(record => ({...record, topics: []}))).toHex();
  const extrinsic = (call: Call) => registry.createType<Extrinsic>('Extrinsic', call);
  const burnCall = (amount: bigint) => tx.assets.burn({code: XOR}, amount);
  const tonswap = extrinsic(tx.utility.batchAll([burnCall(ONE), tx.system.remark(JSON.stringify({app: 'polkaswap', kind: 'tonswap-xor-burn', version: 1}))]));
  const nexus = extrinsic(tx.utility.batchAll([burnCall(5n * ONE / 2n), tx.system.remark(JSON.stringify({type: 'soraNexusXorClaim', version: 1, recipient: nexusRecipient}))]));
  const plain = extrinsic(burnCall(3n * ONE));
  const record = (height: number, parentHash: string, extrinsics: Extrinsic[], eventsHex: string) => {
    const header = registry.createType('Header', {number: height, parentHash, stateRoot: h(2), extrinsicsRoot: h(3), digest: {logs: []}});
    return {hash: header.hash.toHex(), block: {block: {header: header.toJSON(), extrinsics: extrinsics.map(item => item.toHex())}, justifications: null},
      events: eventsHex, executingCodeHash: CODE, metadataSha256: sha(soraMetadata)};
  };
  // Events are positioned in the full block stream: the VAL burn occupies index 2 but yields no XOR receipt.
  const burnBlock = (height: number, parentHash: string) => record(height, parentHash, [tonswap, nexus, plain], eventRecords([
    {phase: {ApplyExtrinsic: 0}, event: burnEvent(alice, XOR, ONE)},
    {phase: {ApplyExtrinsic: 1}, event: burnEvent(bob, XOR, 5n * ONE / 2n)},
    {phase: {ApplyExtrinsic: 2}, event: burnEvent(carol, VAL, ONE)},
    {phase: {ApplyExtrinsic: 2}, event: burnEvent(carol, XOR, 3n * ONE)},
  ]));
  return {registry, burnEvent, eventRecords, record, burnBlock, tonswap, nexus, plain};
}
const runtime = () => (sora ??= soraRuntime());

describe('authenticated Burn receipts under the local SORA runtime schema', () => {
  it('derives tonswap, Nexus-recipient and plain receipts from executed XOR Burn events only', () => {
    const {registry, burnBlock, tonswap, nexus, plain} = runtime();
    const record = burnBlock(25_867_650, h(1));
    const decoded = decodeAuthenticatedBurnRecord(record, registry);
    const base = {blockHash: record.hash, blockHeight: 25_867_650};
    expect(decoded).toEqual({height: 25_867_650, parentHash: h(1), receipts: [
      {...base, id: `${record.hash}:0`, eventIndex: 0, extrinsicIndex: 0, txHash: tonswap.hash.toHex(), address: expect.any(String), amount: '1', campaign: 'tonswap'},
      {...base, id: `${record.hash}:1`, eventIndex: 1, extrinsicIndex: 1, txHash: nexus.hash.toHex(), address: expect.any(String), amount: '2.5', nexusRecipient},
      {...base, id: `${record.hash}:3`, eventIndex: 3, extrinsicIndex: 2, txHash: plain.hash.toHex(), address: expect.any(String), amount: '3'},
    ]});
    expect(decoded.receipts.map(receipt => canonicalAccount(receipt.address))).toEqual([alice, bob, carol]);
    expect(decoded.receipts[0]).not.toHaveProperty('nexusRecipient');
    expect(decoded.receipts[1]).not.toHaveProperty('campaign');
    expect(decoded.receipts[2]).not.toHaveProperty('campaign');
    expect(decoded.receipts[2]).not.toHaveProperty('nexusRecipient');
  });
  it('rejects a Burn event outside an extrinsic or bound to an extrinsic the block does not contain', () => {
    const {registry, burnEvent, eventRecords, record, plain} = runtime();
    const finalization = record(25_867_650, h(1), [plain], eventRecords([{phase: {Finalization: null}, event: burnEvent(alice, XOR, ONE)}]));
    expect(() => decodeAuthenticatedBurnRecord(finalization, registry)).toThrow('Burn event has no authenticated extrinsic association');
    const missing = record(25_867_650, h(1), [plain], eventRecords([{phase: {ApplyExtrinsic: 4}, event: burnEvent(alice, XOR, ONE)}]));
    expect(() => decodeAuthenticatedBurnRecord(missing, registry)).toThrow('Burn event has no authenticated extrinsic association');
  });
});

const VERIFIER = '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$(dirname "$0")/verifier-argv.txt"\n';
const BLOCK_COUNT = RECOVERY_CHECKPOINT.block - SOLSWAP_START_BLOCK + 1;
type Artifact = {file: unknown; sha256: string};
const emptyHeaders = new TypeRegistry(); emptyHeaders.register(soraTypes);
/** Empty-block record whose header hash links to the given parent; decodable under the minimal metadata. */
const emptyRecord = (height: number, parentHash: string, executingCodeHash = CODE, metadataSha256 = sha(minimalMetadata)) => {
  const header = emptyHeaders.createType('Header', {number: height, parentHash, stateRoot: h(2), extrinsicsRoot: h(3), digest: {logs: []}});
  return {hash: header.hash.toHex(), block: {block: {header: header.toJSON(), extrinsics: []}, justifications: null},
    events: '0x00', executingCodeHash, metadataSha256};
};

describe('fresh pinned Burn history extraction', () => {
  let directory: string, verified: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'burn-history-extraction-'));
    verified = join(directory, 'verified'); await mkdir(verified);
  });
  afterEach(async () => {await rm(directory, {recursive: true, force: true});});

  const put = async (file: string, bytes: Uint8Array | string): Promise<Artifact> => {
    await writeFile(join(verified, file), bytes); return {file, sha256: sha(bytes)};
  };
  const page = (file: string, value: unknown) => put(file, gzipSync(JSON.stringify(value)));
  const witness = async (codeHash: string, bytes: Uint8Array = minimalMetadata) =>
    ({codeHash, specVersion: 134, metadata: await put(`metadata-${sha(bytes).slice(0, 8)}.scale`, bytes)});
  /** Stages a SHA-pinned no-op verifier plus the report and artifacts its fresh execution would leave behind. */
  async function prepare(report: Record<string, unknown> = {}) {
    const verifier = join(directory, 'verifier'); await writeFile(verifier, VERIFIER); await chmod(verifier, 0o755);
    const manifest = join(directory, 'manifest.json'), manifestBytes = '{"syntheticHistory":true}';
    await writeFile(manifest, manifestBytes);
    await writeFile(join(verified, 'verification-complete.json'), JSON.stringify({schema: 'sora-nexus-verified-burn-stream-v1',
      first: SOLSWAP_START_BLOCK, last: RECOVERY_CHECKPOINT.block, checkpointHash: RECOVERY_CHECKPOINT.hash,
      sourceManifestSha256: sha(manifestBytes), coverageComplete: true, blockCount: BLOCK_COUNT, headersLinkedToCheckpoint: true,
      extrinsicsRootsVerified: true, storageProofsVerified: true, metadataExecutedFromAuthenticatedParentCode: true,
      nativeExecution: false, pages: [], metadata: [], ...report}));
    return {verifier, verifierSha256: sha(VERIFIER), manifest, verifiedOutput: verified, output: join(directory, 'canonical-receipts.json')};
  }
  const extract = async (report: Record<string, unknown> = {}) => extractBurnHistory(await prepare(report));
  const exists = (path: string) => access(path).then(() => true, () => false);

  it('refuses a well-formed but different verifier digest without executing it', async () => {
    const options = await prepare();
    await expect(extractBurnHistory({...options, verifierSha256: sha('another verifier')})).rejects.toThrow('Native burn verifier SHA-256 mismatch');
    expect(await exists(join(directory, 'verifier-argv.txt'))).toBe(false);
  });

  it('executes the pinned verifier with explicit absolute paths and never writes a partial capture', async () => {
    const options = await prepare();
    await expect(extractBurnHistory(options)).rejects.toThrow('Burn extraction did not reach the checkpoint');
    expect((await readFile(join(directory, 'verifier-argv.txt'), 'utf8')).trim().split('\n'))
      .toEqual(['verify-burn-history', '--manifest', options.manifest, '--output', verified]);
    expect(await exists(options.output)).toBe(false);
  });

  it.each([
    ['schema', {schema: 'sora-nexus-verified-burn-stream-v0'}],
    ['first block', {first: SOLSWAP_START_BLOCK + 1}],
    ['last block', {last: RECOVERY_CHECKPOINT.block - 1}],
    ['checkpoint hash', {checkpointHash: h(1)}],
    ['coverage flag', {coverageComplete: false}],
    ['block count', {blockCount: BLOCK_COUNT - 1}],
    ['header linkage', {headersLinkedToCheckpoint: false}],
    ['extrinsics roots', {extrinsicsRootsVerified: false}],
    ['storage proofs', {storageProofsVerified: false}],
    ['parent-code metadata execution', {metadataExecutedFromAuthenticatedParentCode: false}],
    ['claimed native execution', {nativeExecution: true}],
    ['page list', {pages: null}],
    ['metadata list', {metadata: {}}],
  ])('rejects a verification report with an unacceptable %s', async (_name, patch) => {
    await expect(extract(patch)).rejects.toThrow('Complete independently verified checkpoint burn history is required');
  });

  it('rejects a source manifest that differs from the one the verifier attested', async () => {
    await expect(extract({sourceManifestSha256: sha('another manifest')})).rejects.toThrow('Burn source manifest changed during verification');
  });

  it('rejects invalid code witnesses and malformed, escaping or altered artifact references', async () => {
    const valid = await witness(CODE);
    await expect(extract({metadata: [{...valid, codeHash: CODE.toUpperCase()}]})).rejects.toThrow('Duplicate or invalid execution code witness');
    await expect(extract({metadata: [valid, valid]})).rejects.toThrow('Duplicate or invalid execution code witness');
    await expect(extract({metadata: [{...valid, metadata: {...valid.metadata, file: 42}}]})).rejects.toThrow('Invalid burn artifact reference');
    await expect(extract({metadata: [{...valid, metadata: {...valid.metadata, sha256: valid.metadata.sha256.toUpperCase()}}]}))
      .rejects.toThrow('Invalid burn artifact reference');
    await writeFile(join(directory, 'outside.scale'), minimalMetadata);
    await expect(extract({metadata: [{...valid, metadata: {...valid.metadata, file: '../outside.scale'}}]}))
      .rejects.toThrow('Burn artifact escapes verified directory');
    await expect(extract({metadata: [{...valid, metadata: {...valid.metadata, sha256: sha('different bytes')}}]}))
      .rejects.toThrow('Verified burn artifact checksum differs');
  });

  it('rejects pages that do not continue the attested range within the page bound', async () => {
    const record = emptyRecord(SOLSWAP_START_BLOCK, h(1));
    const pages = [
      {schema: 'sora-nexus-verified-burn-page-v0', first: SOLSWAP_START_BLOCK, records: [record]},
      {schema: 'sora-nexus-verified-burn-page-v1', first: SOLSWAP_START_BLOCK + 1, records: [record]},
      {schema: 'sora-nexus-verified-burn-page-v1', first: SOLSWAP_START_BLOCK, records: {0: record}},
      {schema: 'sora-nexus-verified-burn-page-v1', first: SOLSWAP_START_BLOCK, records: []},
      {schema: 'sora-nexus-verified-burn-page-v1', first: SOLSWAP_START_BLOCK, records: Array(17).fill(record)},
    ];
    for (const [index, value] of pages.entries()) {
      await expect(extract({pages: [await page(`page-${index}.json.gz`, value)]})).rejects.toThrow('Invalid verified burn page range');
    }
  });

  it('binds every record to a witnessed execution code and its exact metadata digest', async () => {
    const pages = [await page('page.json.gz', {schema: 'sora-nexus-verified-burn-page-v1', first: SOLSWAP_START_BLOCK,
      records: [emptyRecord(SOLSWAP_START_BLOCK, h(1))]})];
    await expect(extract({pages})).rejects.toThrow('Unbound parent execution metadata');
    await expect(extract({pages, metadata: [await witness(OTHER_CODE)]})).rejects.toThrow('Unbound parent execution metadata');
    const otherDigest = [await page('other.json.gz', {schema: 'sora-nexus-verified-burn-page-v1', first: SOLSWAP_START_BLOCK,
      records: [emptyRecord(SOLSWAP_START_BLOCK, h(1), CODE, sha(soraMetadata))]})];
    await expect(extract({pages: otherDigest, metadata: [await witness(CODE)]})).rejects.toThrow('Unbound parent execution metadata');
  });

  it('rejects a height gap or a broken parent-hash link between authenticated records', async () => {
    const metadata = [await witness(CODE)];
    const first = emptyRecord(SOLSWAP_START_BLOCK, h(1));
    const skipped = [await page('skip.json.gz', {schema: 'sora-nexus-verified-burn-page-v1', first: SOLSWAP_START_BLOCK,
      records: [emptyRecord(SOLSWAP_START_BLOCK + 1, first.hash)]})];
    await expect(extract({pages: skipped, metadata})).rejects.toThrow('Verified burn stream has a gap');
    const unlinked = [await page('unlinked.json.gz', {schema: 'sora-nexus-verified-burn-page-v1', first: SOLSWAP_START_BLOCK,
      records: [first, emptyRecord(SOLSWAP_START_BLOCK + 1, h(99))]})];
    await expect(extract({pages: unlinked, metadata})).rejects.toThrow('Verified burn stream has a gap');
  });
  // The complete-stream capture is exercised with a shortened checkpoint range in burn-history-extraction-capture.spec.ts.
});
