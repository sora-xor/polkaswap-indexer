import { createHash } from 'node:crypto';
import { canonicalAccount, RECOVERY_CHECKPOINT, validateBurnAllocationPolicy, validateBurnRecoveryPolicy, type BurnAllocationPolicy, type BurnRecoveryPolicy } from './burn-recovery.js';
import type { IndexerDocument, IndexerRepository } from './repository/types.js';
import { serializeIndexerDocument } from './repository/validation.js';

export const POINTS_RECOVERY_ID = 'soratopiaRecoveryContinuity-v1';
export const POINTS_CHECKPOINT_ID = 'soratopiaRecoveryCheckpoint-v1';
export const POINTS_PROJECTION_ID = 'soratopiaRecoveryProjection-v1';
export const POINTS_REFERRAL_PREFIX = 'soratopiaReferralPoints-v1:';
export const POINTS_LEDGER_PREFIX = 'soratopiaRecoveryOwner-v1:';
export const POINTS_VALUATION_PREFIX = 'soratopiaValuationInputs-v1:';
export const POINTS_JOURNAL_PREFIX = 'soratopiaPointJournal-v1:';
export const POINTS_JOURNAL_SCHEMA = 'sora-nexus-soratopia-point-journal-v1';
const VALUATION_SCHEMA = 'sora-nexus-soratopia-valuation-inputs-v1';
const SCHEMA = 'sora-nexus-soratopia-checkpoint-projection-v1';
const MAX_ERAS = 128;
const MAX_OWNER_BYTES = 512 * 1024;
const MAX_TARGETS = 4096;
const MAX_EXPORT_BYTES = 64 * 1024 * 1024;
const HASH = /^0x[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{64}$/;
const MAX_VALUATION_ENTRIES = 8192;
const MAX_VALUATION_BYTES = 4 * 1024 * 1024;
const DECIMAL = /^(0|[1-9][0-9]{0,79})(\.[0-9]{1,40})?$/;
function need(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(`Soratopia recovery: ${message}`); }
const object = (value: unknown): Record<string, unknown> => {
  need(value !== null && typeof value === 'object' && !Array.isArray(value), 'invalid object');
  return value as Record<string, unknown>;
};
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) :
  value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, stable(v)])) : value;
/** Deterministic commitment to public source/projection evidence, without numeric coercion. */
export const pointsDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
export type PointValuationState = {
  blockHeight: number;
  blockHash?: string;
  assets: ReadonlyMap<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
  pools: ReadonlyMap<string, { baseAssetId: string; targetAssetId: string; baseAssetReserves: bigint; targetAssetReserves: bigint }>;
  prices: ReadonlyMap<string, bigint>;
};
export type PointValuationInputs = {
  schema: typeof VALUATION_SCHEMA;
  priceScaleDecimals: 18;
  assets: Array<[string, string, string, number, string]>;
  pools: Array<[string, string, string, string]>;
  prices: Array<[string, string]>;
};
export type PointValuation = { parentBlock: number; parentHash: string; inputsSha256: string; inputs: PointValuationInputs };
function validateValuationInputs(inputs: PointValuationInputs): void {
  need(inputs?.schema === VALUATION_SCHEMA && inputs.priceScaleDecimals === 18 &&
    Array.isArray(inputs.assets) && Array.isArray(inputs.pools) && Array.isArray(inputs.prices), 'invalid valuation inputs');
  need(inputs.assets.length + inputs.pools.length + inputs.prices.length <= MAX_VALUATION_ENTRIES, 'valuation input entry bound');
  need(Buffer.byteLength(JSON.stringify(inputs)) <= MAX_VALUATION_BYTES, 'valuation input byte bound');
  const amount = (value: unknown) => typeof value === 'string' && /^(0|[1-9][0-9]{0,119})$/.test(value);
  let previous = '';
  for (const row of inputs.assets) {
    need(Array.isArray(row) && row.length === 5 && HASH.test(row[0]) && row[0] > previous &&
      typeof row[1] === 'string' && typeof row[2] === 'string' && Number.isInteger(row[3]) && row[3] >= 0 && row[3] <= 255 && amount(row[4]),
    'invalid or unordered valuation assets');
    previous = row[0];
  }
  previous = '';
  for (const row of inputs.pools) {
    const key = Array.isArray(row) ? `${row[0]}\0${row[1]}` : '';
    need(Array.isArray(row) && row.length === 4 && HASH.test(row[0]) && HASH.test(row[1]) && key > previous && amount(row[2]) && amount(row[3]),
      'invalid or unordered valuation pools');
    previous = key;
  }
  previous = '';
  for (const row of inputs.prices) {
    need(Array.isArray(row) && row.length === 2 && HASH.test(row[0]) && row[0] > previous && amount(row[1]), 'invalid or unordered valuation prices');
    previous = row[0];
  }
}
/** Retains exactly the price inputs used by the worker; this is NOT a storage proof. */
export function pointValuation(state: PointValuationState, block: number, parentHash: string): PointValuation {
  need(Number.isSafeInteger(block) && block >= 1 && state.blockHeight === block - 1 &&
    HASH.test(parentHash) && parentHash !== '0x' + '0'.repeat(64) && state.blockHash === parentHash,
  'historical valuation must match the exact parent block hash and height');
  need(state.assets.size + state.pools.size + state.prices.size <= MAX_VALUATION_ENTRIES, 'valuation input entry bound');
  const unsigned = (value: bigint) => {
    need(typeof value === 'bigint' && value >= 0n && value.toString().length <= 120, 'invalid valuation integer');
    return value.toString();
  };
  const inputs: PointValuationInputs = { schema: VALUATION_SCHEMA, priceScaleDecimals: 18,
    assets: [...state.assets].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([id, asset]): [string, string, string, number, string] => {
      need(HASH.test(id) && asset.id === id && typeof asset.symbol === 'string' && typeof asset.name === 'string' &&
        Number.isInteger(asset.decimals) && asset.decimals >= 0 && asset.decimals <= 255, 'invalid valuation asset');
      return [id, asset.symbol, asset.name, asset.decimals, unsigned(asset.supply)];
    }),
    pools: [...state.pools].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([id, pool]): [string, string, string, string] => {
      need(HASH.test(pool.baseAssetId) && HASH.test(pool.targetAssetId) && id === `${pool.baseAssetId}\0${pool.targetAssetId}`,
        'invalid valuation pool');
      return [pool.baseAssetId, pool.targetAssetId, unsigned(pool.baseAssetReserves), unsigned(pool.targetAssetReserves)];
    }),
    prices: [...state.prices].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([id, price]): [string, string] => {
      need(HASH.test(id), 'invalid valuation price asset');
      return [id, unsigned(price)];
    }) };
  validateValuationInputs(inputs);
  return { parentBlock: state.blockHeight, parentHash, inputsSha256: pointsDigest(inputs), inputs };
}
const document = (id: string, block: number, data: Record<string, unknown>): IndexerDocument => ({
  collection: 'updatesStreams', id, blockHeight: block, timestamp: null, data: { id, ...data },
});
/** The data commitment excludes the outer manifest and future anchor to avoid circular release hashes. */
const allocationBinding = (policy: BurnAllocationPolicy) => ({
  schema: SCHEMA, policyHash: policy.policyHash, genesisHash: policy.genesisHash, checkpoint: policy.checkpoint,
  allocationPolicyDigest: pointsDigest({ version: policy.version, policyHash: policy.policyHash, genesisHash: policy.genesisHash,
    checkpoint: policy.checkpoint, substitutions: policy.substitutions, attackerAccounts: policy.attackerAccounts }),
});
const binding = (policy: BurnRecoveryPolicy) => ({ ...allocationBinding(policy),
  releaseManifestHash: policy.releaseManifestHash, postForkAnchor: policy.postForkAnchor, livePolicyDigest: pointsDigest(policy),
});
const read = async (repository: IndexerRepository, id: string, policy: BurnRecoveryPolicy): Promise<Record<string, unknown> | null> => {
  const row = await repository.get('updatesStreams', id);
  if (!row) return null;
  need(row.collection === 'updatesStreams' && row.id === id && row.data.id === id, 'invalid evidence envelope');
  for (const [key, value] of Object.entries(binding(policy))) need(pointsDigest(row.data[key]) === pointsDigest(value), 'policy/fork evidence mismatch');
  return row.data;
};
const integer = (v: unknown, minimum = 0): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= minimum;
const state = async (repository: IndexerRepository): Promise<{ block: number; hash: string } | null> => {
  const row = await repository.get('updatesStreams', 'chainState');
  if (!row) return null;
  need(typeof row.data.data === 'string', 'missing canonical chainState');
  const value = object(JSON.parse(row.data.data as string));
  need(integer(value.lastIndexedBlock, 1) && typeof value.blockHash === 'string' && HASH.test(value.blockHash), 'invalid chainState');
  return { block: value.lastIndexedBlock as number, hash: value.blockHash as string };
};
const continuity = async (repository: IndexerRepository, policy: BurnRecoveryPolicy) => {
  const row = await read(repository, POINTS_RECOVERY_ID, policy);
  need(row && integer(row.throughBlock) && typeof row.blockHash === 'string' && HASH.test(row.blockHash) &&
    typeof row.receiptRoot === 'string' && SHA.test(row.receiptRoot), 'missing continuity proof');
  need(row!.valuationReceiptSchema === VALUATION_SCHEMA, 'missing valuation-bound replay continuity; fresh replay required');
  need(row!.journalSchema === POINTS_JOURNAL_SCHEMA, 'missing append-only point journal; fresh replay required');
  if (row!.throughBlock === RECOVERY_CHECKPOINT.block) need(row!.blockHash === RECOVERY_CHECKPOINT.hash, 'continuity checkpoint hash mismatch');
  if (row!.throughBlock === policy.postForkAnchor.block) need(row!.blockHash === policy.postForkAnchor.hash, 'continuity fork anchor mismatch');
  const current = await state(repository);
  need(current ? current.block === row!.throughBlock && current.hash === row!.blockHash : row!.throughBlock === 0, 'point/chain checkpoint mismatch');
  return row!;
};

/** Only a fresh isolated recovery replay may establish point provenance. No legacy retrofit. */
export async function initializePointsRecovery(repository: IndexerRepository, policy: BurnRecoveryPolicy, startBlock: number): Promise<void> {
  validateBurnRecoveryPolicy(policy);
  targets(policy);
  need(integer(startBlock) && startBlock <= 1, 'complete point replay must start at block 1');
  const row = await read(repository, POINTS_RECOVERY_ID, policy);
  if (row) {
    const current = await continuity(repository, policy);
    if (Number(current.throughBlock) >= RECOVERY_CHECKPOINT.block) await projectCheckpointPoints(repository, policy);
    return;
  }
  need(!(await state(repository)), 'existing checkpoint cannot be retrofitted');
  for (const name of ['accountMeta', 'accountPointSystems'] as const) {
    need(repository.query, 'bounded repository queries required');
    need(!(await repository.query!(name, { first: 1, includeTotalCount: false })).items.length, 'point source is not empty');
  }
  need(repository.query, 'bounded initial identity query required');
  const identities = await repository.query!('updatesStreams', { first: 5, includeTotalCount: false });
  need(identities.items.every((item) => ['chainIdentity', 'workerStatus-v1', 'burnRecoveryIdentity-v1', 'xorBurnEventReceipts-v2'].includes(item.id)),
    'orphan or preexisting recovery data');
  for (const id of [POINTS_CHECKPOINT_ID, POINTS_PROJECTION_ID]) need(!(await repository.get('updatesStreams', id)), 'orphan projection evidence');
  await repository.upsert(document(POINTS_RECOVERY_ID, 0, { ...binding(policy), throughBlock: 0,
    blockHash: policy.genesisHash, valuationReceiptSchema: VALUATION_SCHEMA, journalSchema: POINTS_JOURNAL_SCHEMA,
    receiptRoot: pointsDigest({ ...allocationBinding(policy), startBlock: 1, valuationReceiptSchema: VALUATION_SCHEMA }) }));
}

/** Point storage uses one AccountId representation; old identities never accrue after the fork. */
export function pointAccount(address: string, policy: BurnRecoveryPolicy | null | undefined, block: number): string | null {
  if (!policy) return address;
  const id = canonicalAccount(address);
  if (block > RECOVERY_CHECKPOINT.block && (policy.substitutions.some((x) => canonicalAccount(x.old) === id) ||
    policy.attackerAccounts.some((x) => canonicalAccount(x) === id))) return null;
  return id;
}

/** Called before an indexing block, before any economic aggregate is evaluated. */
export async function admitPointBlock(repository: IndexerRepository, policy: BurnRecoveryPolicy, block: number, hash: string, parent: string): Promise<Record<string, unknown>> {
  const previous = await continuity(repository, policy);
  need(integer(block, 1) && block === Number(previous.throughBlock) + 1 && HASH.test(hash) && parent === previous.blockHash, 'noncontiguous or replayed point block');
  need(!(await repository.get('updatesStreams', pointJournalId(block))), 'point journal already exists; overwrite forbidden');
  if (block === RECOVERY_CHECKPOINT.block) need(hash === RECOVERY_CHECKPOINT.hash, 'checkpoint hash mismatch');
  if (block === RECOVERY_CHECKPOINT.block + 1) await projectCheckpointPoints(repository, policy);
  else if (block > RECOVERY_CHECKPOINT.block + 1) {
    const projected = await read(repository, POINTS_PROJECTION_ID, policy);
    need(projected?.complete === true && projected.cursor === targets(policy).length, 'child progressed without complete projection');
  }
  return previous;
}

/** Returned records MUST share the same atomic write call as point rows and chainState. */
export function pointBlockDocuments(policy: BurnRecoveryPolicy, previous: Record<string, unknown>, block: number, hash: string,
  blockHex: string, eventHexes: string[], pointRows: IndexerDocument[], valuation: PointValuation): IndexerDocument[] {
  need(/^0x(?:[0-9a-f]{2})+$/.test(blockHex) && eventHexes.every((x) => /^0x(?:[0-9a-f]{2})+$/.test(x)), 'missing canonical block/event bytes');
  need(valuation, 'missing parent valuation inputs');
  validateValuationInputs(valuation.inputs);
  need(valuation && valuation.parentBlock === block - 1 && valuation.parentHash === previous.blockHash &&
    previous.throughBlock === block - 1 && previous.journalSchema === POINTS_JOURNAL_SCHEMA &&
    previous.valuationReceiptSchema === VALUATION_SCHEMA && valuation.inputs.schema === VALUATION_SCHEMA &&
    valuation.inputsSha256 === pointsDigest(valuation.inputs), 'missing or mismatched parent valuation inputs');
  const valuationReference = { schema: VALUATION_SCHEMA, parentBlock: valuation.parentBlock, parentHash: valuation.parentHash,
    inputsSha256: valuation.inputsSha256, storageProofsVerified: false };
  const receiptRoot = pointsDigest({ previous: previous.receiptRoot, block, hash,
    blockSha256: createHash('sha256').update(Buffer.from(blockHex.slice(2), 'hex')).digest('hex'),
    orderedEventsSha256: pointsDigest(eventHexes), pointWritesSha256: pointsDigest(pointRows), valuation: valuationReference });
  const value = { ...binding(policy), throughBlock: block, blockHash: hash, receiptRoot,
    valuationReceiptSchema: VALUATION_SCHEMA, journalSchema: POINTS_JOURNAL_SCHEMA, valuation: valuationReference };
  // Content-addressed data is independent of its first observing block and is
  // safe to rewrite byte-identically when consecutive blocks use the same inputs.
  const rows = [document(POINTS_VALUATION_PREFIX + valuation.inputsSha256, 0,
    { schema: VALUATION_SCHEMA, inputsSha256: valuation.inputsSha256, inputs: valuation.inputs, storageProofsVerified: false }),
  document(POINTS_RECOVERY_ID, block, value),
  document(pointJournalId(block), block, { schema: POINTS_JOURNAL_SCHEMA, allocation: allocationBinding(policy),
    block, hash, parentHash: previous.blockHash, previousReceiptRoot: previous.receiptRoot, receiptRoot,
    blockHex, eventHexes: [...eventHexes], pointRows: JSON.parse(JSON.stringify(pointRows)), valuation: valuationReference,
    storageProofsVerified: false, scoringReexecuted: false, productionReady: false })];
  // The existing repository's document/batch limits remain authoritative. Fail
  // before the shared atomic write rather than splitting an oversized block.
  serializeIndexerDocument(rows[2]);
  if (block === RECOVERY_CHECKPOINT.block) rows.push(document(POINTS_CHECKPOINT_ID, block, value));
  return rows;
}

export type PointReferralEvent = { referrer: string; referral: string; amount: string };
/** One pass over actual ReferrerRewarded events; generic history refreshes cannot seed point rewards. */
export async function referralPointDocuments(repository: IndexerRepository, policy: BurnRecoveryPolicy, block: number, timestamp: number,
  events: PointReferralEvent[]): Promise<IndexerDocument[]> {
  const totals = new Map<string, bigint>();
  for (const event of events) {
    canonicalAccount(event.referral);
    need(/^(0|[1-9][0-9]{0,38})$/.test(event.amount) && BigInt(event.amount) <= (1n << 128n) - 1n, 'invalid referral event amount');
    const owner = pointAccount(event.referrer, policy, block);
    if (owner === null || event.amount === '0') continue;
    totals.set(owner, (totals.get(owner) ?? 0n) + BigInt(event.amount));
  }
  const result: IndexerDocument[] = [];
  for (const [owner, delta] of totals) {
    const id = POINTS_REFERRAL_PREFIX + owner;
    const old = await repository.get('updatesStreams', id);
    if (old) need(old.id === id && old.data.accountId === owner && old.data.policyHash === policy.policyHash &&
      typeof old.data.amountCodec === 'string' && /^(0|[1-9][0-9]{0,79})$/.test(old.data.amountCodec), 'invalid stored referral points');
    const amount = BigInt(String(old?.data.amountCodec ?? '0')) + delta;
    need(amount.toString().length <= 80, 'referral total bound exceeded');
    result.push({ collection: 'updatesStreams', id, blockHeight: block, timestamp, data: { ...old?.data,
      id, accountId: owner, policyHash: policy.policyHash, amountCodec: amount.toString() } });
  }
  return result;
}
const validateReferral = (row: IndexerDocument, owner: string, policy: BurnAllocationPolicy): void => {
  need(row.collection === 'updatesStreams' && row.id === POINTS_REFERRAL_PREFIX + owner && row.data.id === row.id &&
    row.data.accountId === owner && row.data.policyHash === policy.policyHash && row.data.recovery === undefined &&
    integer(row.blockHeight, 1) && row.blockHeight <= RECOVERY_CHECKPOINT.block && integer(row.timestamp, 1) &&
    typeof row.data.amountCodec === 'string' && /^(0|[1-9][0-9]{0,79})$/.test(row.data.amountCodec), 'invalid checkpoint referral source');
};
const projectReferral = (row: IndexerDocument, original: string, owner: string, policy: BurnAllocationPolicy): IndexerDocument => ({
  ...row, id: POINTS_REFERRAL_PREFIX + owner, blockHeight: RECOVERY_CHECKPOINT.block,
  data: { ...row.data, id: POINTS_REFERRAL_PREFIX + owner, accountId: owner,
    recovery: { ...allocationBinding(policy), originalAccount: original, status: 'replacement', sourceSha256: pointsDigest(row) } },
});

const targets = (policy: BurnAllocationPolicy) => {
  need(policy.substitutions.length + policy.attackerAccounts.length <= MAX_TARGETS, 'owner bound exceeded');
  const result = [
  ...policy.substitutions.map((x) => ({ original: canonicalAccount(x.old), owner: canonicalAccount(x.new), status: 'replaced' })),
  ...policy.attackerAccounts.map((x) => ({ original: canonicalAccount(x), owner: null, status: 'extinguished' })),
].sort((a, b) => a.original < b.original ? -1 : 1);
  need(new Set(result.map((x) => x.original)).size === result.length, 'duplicate projected owner');
  return result;
};

/** Validate copied amounts/creation/era domains; historical values are preserved byte-for-byte. */
export function validatePointSource(row: IndexerDocument, account: string): void {
  const data = row.data;
  need(row.collection === 'accountMeta' || row.collection === 'accountPointSystems', 'invalid point collection');
  need(data.id === row.id && data.accountId === account && canonicalAccount(account) === account, 'noncanonical point owner');
  need(integer(row.blockHeight, 1) && row.blockHeight <= RECOVERY_CHECKPOINT.block && integer(row.timestamp, 1), 'point source outside checkpoint');
  need(integer(data.createdAtBlock, 1) && data.createdAtBlock <= row.blockHeight && integer(data.createdAtTimestamp, 1) && data.createdAtTimestamp <= Number(row.timestamp), 'invalid creation history');
  need(data.recovery === undefined, 'source already projected');
  if (row.collection === 'accountMeta') {
    need(row.id === account, 'invalid metadata id');
    addressAliases(data.pointSourceAddresses, account);
  }
  else need(integer(data.version, 1) && data.version <= 0xffffffff && row.id === `${account}-${data.version}` &&
    integer(data.startedAtBlock, 1) && data.startedAtBlock <= row.blockHeight, 'invalid era identity');
  for (const [field, values] of Object.entries({ xorFees: ['amount', 'amountUSD'], xorBurned: ['amount', 'amountUSD'],
    xorStakingValRewards: ['amount', 'amountUSD'], orderBook: ['amountUSD'], vault: ['amountUSD'],
    governance: ['amount', 'amountUSD'], deposit: ['incomingUSD', 'outgoingUSD'] })) {
    const v = object(data[field]);
    for (const name of values) need(typeof v[name] === 'string' && DECIMAL.test(v[name] as string), 'invalid exact point amount');
  }
  for (const [field, names] of Object.entries({ orderBook: ['created', 'closed'], vault: ['created', 'closed'], governance: ['votes'] })) {
    for (const name of names) need(integer(object(data[field])[name]), 'invalid point counter');
  }
}
const eras = async (repository: IndexerRepository, account: string) => {
  need(repository.query, 'bounded era query required');
  const result = await repository.query!('accountPointSystems', { first: MAX_ERAS + 1, orderBy: ['ID_ASC'],
    filter: { accountId: { equalTo: account } }, includeTotalCount: false, maxBytes: MAX_OWNER_BYTES });
  need(result.items.length <= MAX_ERAS && !result.hasNextPage && Buffer.byteLength(JSON.stringify(result.items)) <= MAX_OWNER_BYTES, 'era/source bound exceeded');
  return result.items;
};
const project = (row: IndexerDocument, original: string, owner: string | null, policy: BurnAllocationPolicy): IndexerDocument => {
  const id = owner === null ? row.id : row.collection === 'accountMeta' ? owner : `${owner}-${row.data.version}`;
  const data = { ...structuredClone(row.data), id, accountId: owner ?? original,
    recovery: { ...allocationBinding(policy), originalAccount: original, status: owner === null ? 'extinguished' : 'replacement', sourceSha256: pointsDigest(row) } };
  return { ...row, id, blockHeight: RECOVERY_CHECKPOINT.block, data };
};

const retirement = (row: IndexerDocument, original: string, status: string, policy: BurnAllocationPolicy): IndexerDocument => ({
  ...row, blockHeight: RECOVERY_CHECKPOINT.block, data: { ...row.data,
    recovery: { ...allocationBinding(policy), originalAccount: original, status: status === 'extinguished' ? 'extinguished' : 'retired', claimable: false } },
});

/** Recompute the committed prefix on restart/export; cursors alone cannot authorize skipping work. */
async function verifyProjectionPrefix(repository: IndexerRepository, policy: BurnRecoveryPolicy,
  checkpoint: Record<string, unknown>, progress: Record<string, unknown>, checkCurrent: boolean, retainRecords = false) {
  const items = targets(policy);
  need(integer(progress.cursor) && progress.cursor <= items.length && progress.targetCount === items.length, 'invalid prefix cursor');
  let root = pointsDigest({ ...allocationBinding(policy), checkpointReceiptRoot: checkpoint.receiptRoot, targetCount: items.length });
  const records: Record<string, unknown>[] = [];
  const rowPins = new Map<string, string>();
  let retainedBytes = 0;
  for (let index = 0; index < progress.cursor; index++) {
    const item = items[index];
    const row = await read(repository, `${POINTS_LEDGER_PREFIX}${item.original}`, policy);
    need(row, 'missing projection row');
    need(Buffer.byteLength(JSON.stringify(row)) <= MAX_OWNER_BYTES + 4096, 'retained owner row bound exceeded');
    rowPins.set(items[index].original, pointsDigest(row));
    const { id: _id, rowHash, releaseManifestHash: _manifest, postForkAnchor: _anchor, livePolicyDigest: _live, ...evidence } = row;
    need(evidence.index === index && evidence.original === item.original && evidence.owner === item.owner && evidence.status === item.status &&
      evidence.previousLedgerRoot === root && evidence.checkpointReceiptRoot === checkpoint.receiptRoot && rowHash === pointsDigest(evidence), 'projection row commitment mismatch');
    need(Array.isArray(evidence.sourceEras) && evidence.sourceEras.length <= MAX_ERAS, 'invalid retained eras');
    const sourceMeta = evidence.sourceMeta as IndexerDocument | null;
    const sourceEras = evidence.sourceEras as IndexerDocument[];
    need((sourceMeta === null || sourceMeta.collection === 'accountMeta') && sourceEras.every((x) => x.collection === 'accountPointSystems'), 'retained source kind mismatch');
    const referralSource = evidence.referralSource as IndexerDocument | null;
    need(referralSource !== undefined, 'missing retained referral disposition');
    if (referralSource) validateReferral(referralSource, item.original, policy);
    const sourcePresent = sourceMeta !== null || referralSource !== null;
    need(sourceMeta !== undefined && Boolean(sourceMeta) === Boolean(sourceEras.length) && evidence.sourcePresent === sourcePresent &&
      evidence.claimable === (item.owner !== null && sourcePresent), 'retained source disposition mismatch');
    const sources = [...(sourceMeta ? [sourceMeta] : []), ...sourceEras];
    sources.forEach((source) => validatePointSource(source, item.original));
    need(sources.every((row) => row.data.pointRecoveryPolicyHash === policy.policyHash), 'retained source point policy mismatch');
    need(new Set(sources.map((source) => `${source.collection}/${source.id}`)).size === sources.length, 'duplicate retained source');
    const projected = item.owner ? [...sources.map((source) => project(source, item.original, item.owner, policy)),
      ...(referralSource ? [projectReferral(referralSource, item.original, item.owner, policy)] : [])] : [];
    need(pointsDigest(evidence.projected) === pointsDigest(projected), 'projection is not exact source ownership transfer');
    if (checkCurrent) {
      for (const expected of [...projected, ...[...sources, ...(referralSource ? [referralSource] : [])].map((source) => retirement(source, item.original, item.status, policy))]) {
        need(pointsDigest(await repository.get(expected.collection, expected.id)) === pointsDigest(expected), 'committed projection row changed before child');
      }
    }
    root = pointsDigest({ previous: root, rowHash });
    if (retainRecords) {
      retainedBytes += Buffer.byteLength(JSON.stringify(row));
      need(retainedBytes <= MAX_EXPORT_BYTES, 'release ledger export bound exceeded');
      records.push({ id: row.id, ...evidence, rowHash });
    }
  }
  need(progress.ledgerRoot === root, 'projection root mismatch');
  return { root, records, rowPins };
}

/**
 * Bounded atomic per-owner projection. chainState stays at checkpoint until all
 * entries commit; every entry includes immutable source, destination and cursor.
 * A crash can only leave a complete prefix, never an applied transfer to retry.
 */
export async function projectCheckpointPoints(repository: IndexerRepository, policy: BurnRecoveryPolicy): Promise<void> {
  const current = await continuity(repository, policy);
  need(Number(current.throughBlock) >= RECOVERY_CHECKPOINT.block, 'checkpoint has not been indexed');
  const checkpoint = await read(repository, POINTS_CHECKPOINT_ID, policy);
  need(checkpoint?.throughBlock === RECOVERY_CHECKPOINT.block && checkpoint.blockHash === RECOVERY_CHECKPOINT.hash &&
    typeof checkpoint.receiptRoot === 'string' && SHA.test(checkpoint.receiptRoot), 'missing immutable checkpoint receipt');
  const items = targets(policy);
  let progress = await read(repository, POINTS_PROJECTION_ID, policy);
  const seed = pointsDigest({ ...allocationBinding(policy), checkpointReceiptRoot: checkpoint.receiptRoot, targetCount: items.length });
  if (!progress) {
    need(current.throughBlock === RECOVERY_CHECKPOINT.block, 'postfork data lacks point projection');
    progress = { ...binding(policy), cursor: 0, targetCount: items.length, ledgerRoot: seed,
      checkpointReceiptRoot: checkpoint.receiptRoot, complete: false };
  }
  need(integer(progress.cursor) && progress.cursor <= items.length && progress.targetCount === items.length &&
    progress.checkpointReceiptRoot === checkpoint.receiptRoot && typeof progress.ledgerRoot === 'string' && SHA.test(progress.ledgerRoot), 'invalid projection cursor');
  await verifyProjectionPrefix(repository, policy, checkpoint, progress, current.throughBlock === RECOVERY_CHECKPOINT.block);
  if (progress.complete === true) { need(progress.cursor === items.length, 'incomplete projection'); return; }
  need(current.throughBlock === RECOVERY_CHECKPOINT.block, 'child progressed before point projection');
  for (let index = Number(progress.cursor); index < items.length; index++) {
    const target = items[index];
    const id = `${POINTS_LEDGER_PREFIX}${target.original}`;
    need(!(await repository.get('updatesStreams', id)), 'projection ledger collision');
    const meta = await repository.get('accountMeta', target.original);
    const sourceEras = await eras(repository, target.original);
    const referralSource = await repository.get('updatesStreams', POINTS_REFERRAL_PREFIX + target.original);
    if (referralSource) validateReferral(referralSource, target.original, policy);
    need(Boolean(meta) === Boolean(sourceEras.length), 'metadata/era source mismatch');
    if (meta) validatePointSource(meta, target.original);
    sourceEras.forEach((row) => validatePointSource(row, target.original));
    if (target.owner) {
      need(!(await repository.get('accountMeta', target.owner)) && !(await eras(repository, target.owner)).length &&
        !(await repository.get('updatesStreams', POINTS_REFERRAL_PREFIX + target.owner)),
        'replacement destination already has point history');
    }
    const sources = [...(meta ? [meta] : []), ...sourceEras];
    need(sources.every((row) => row.data.pointRecoveryPolicyHash === policy.policyHash), 'source point policy mismatch');
    const projected = target.owner ? [...sources.map((row) => project(row, target.original, target.owner, policy)),
      ...(referralSource ? [projectReferral(referralSource, target.original, target.owner, policy)] : [])] : [];
    const retired = [...sources, ...(referralSource ? [referralSource] : [])].map((row) => retirement(row, target.original, target.status, policy));
    const evidence = { ...allocationBinding(policy), index, ...target, claimable: target.owner !== null && (meta !== null || referralSource !== null),
      sourcePresent: meta !== null || referralSource !== null, sourceMeta: meta, sourceEras, referralSource, projected,
      checkpointReceiptRoot: checkpoint.receiptRoot, previousLedgerRoot: progress.ledgerRoot };
    need(Buffer.byteLength(JSON.stringify(evidence)) <= MAX_OWNER_BYTES, 'owner evidence bound exceeded');
    const rowHash = pointsDigest(evidence);
    progress = { ...binding(policy), cursor: index + 1, targetCount: items.length,
      checkpointReceiptRoot: checkpoint.receiptRoot, ledgerRoot: pointsDigest({ previous: progress.ledgerRoot, rowHash }), complete: index + 1 === items.length };
    await repository.upsertMany([...projected, ...retired, document(id, RECOVERY_CHECKPOINT.block, { ...binding(policy), ...evidence, rowHash }),
      document(POINTS_PROJECTION_ID, RECOVERY_CHECKPOINT.block, progress)]);
  }
  if (!items.length) await repository.upsert(document(POINTS_PROJECTION_ID, RECOVERY_CHECKPOINT.block, { ...progress, complete: true }));
}

/** Queries never expose a partial projection or treat a retired key as a claimant. */
export async function pointsQueryIdentity(repository: IndexerRepository): Promise<BurnRecoveryPolicy | null> {
  const identity = await repository.get('updatesStreams', 'burnRecoveryIdentity-v1');
  if (!identity) {
    need(!(await repository.get('updatesStreams', POINTS_RECOVERY_ID)), 'policy is missing');
    const legacyHead = await state(repository);
    need(!legacyHead || legacyHead.block <= RECOVERY_CHECKPOINT.block, 'postcheckpoint points require a recovery identity');
    return null;
  }
  const policy = validateBurnRecoveryPolicy(JSON.parse(String(identity.data.data)));
  const current = await continuity(repository, policy);
  const progress = await read(repository, POINTS_PROJECTION_ID, policy);
  const checkpoint = await read(repository, POINTS_CHECKPOINT_ID, policy);
  need(progress?.complete === true && progress.cursor === targets(policy).length && progress.targetCount === targets(policy).length &&
    checkpoint?.throughBlock === RECOVERY_CHECKPOINT.block && checkpoint.blockHash === RECOVERY_CHECKPOINT.hash &&
    progress.checkpointReceiptRoot === checkpoint.receiptRoot && typeof progress.ledgerRoot === 'string' && SHA.test(progress.ledgerRoot) &&
    Number(current.throughBlock) >= RECOVERY_CHECKPOINT.block &&
    (current.throughBlock !== RECOVERY_CHECKPOINT.block || current.receiptRoot === checkpoint.receiptRoot), 'checkpoint projection unavailable');
  return policy;
}

/** Exact address spellings observed in canonical history; no guessed SS58 aliases or unbounded selectors. */
function addressAliases(value: unknown, owner: string): string[] {
  need(Array.isArray(value) && value.length <= 8 && value.every((v) => typeof v === 'string' && canonicalAccount(v) === owner) &&
    new Set(value).size === value.length, 'invalid point history aliases');
  return value as string[];
}

export type PointOwnership = {
  status: 'legacy' | 'active' | 'replacement' | 'retired' | 'extinguished';
  ready: boolean;
  accountId: string;
  referralRewardsCodec: string;
  policyHash: string | null;
  checkpointBlock: number | null;
  checkpointHash: string | null;
  sources: Array<{ account: string; firstBlock: number; lastBlock: number | null }>;
};

type ProjectionCacheEntry = { identity: string; pins: Promise<Map<string, string>> };
const projectionCache = new WeakMap<IndexerRepository, ProjectionCacheEntry>();
const projectionIdentity = (policy: BurnRecoveryPolicy, checkpoint: Record<string, unknown>, projection: Record<string, unknown>) => pointsDigest({
  binding: binding(policy), checkpoint, projection,
});

/** One bounded full validation per immutable root, with concurrent query deduplication. */
async function selectedProjectionRow(repository: IndexerRepository, policy: BurnRecoveryPolicy, original: string): Promise<Record<string, unknown>> {
  const checkpoint = await read(repository, POINTS_CHECKPOINT_ID, policy);
  const projection = await read(repository, POINTS_PROJECTION_ID, policy);
  need(checkpoint && projection?.complete === true && projection.cursor === targets(policy).length &&
    projection.checkpointReceiptRoot === checkpoint.receiptRoot, 'projection unavailable for selected owner');
  const identity = projectionIdentity(policy, checkpoint, projection);
  let entry = projectionCache.get(repository);
  if (entry?.identity !== identity) {
    const pins = verifyProjectionPrefix(repository, policy, checkpoint, projection, false).then((result) => result.rowPins);
    entry = { identity, pins }; projectionCache.set(repository, entry);
  }
  let pins: Map<string, string>;
  try { pins = await entry.pins; } catch (error) {
    if (projectionCache.get(repository) === entry) projectionCache.delete(repository);
    throw error;
  }
  const row = await read(repository, POINTS_LEDGER_PREFIX + original, policy);
  need(row && pointsDigest(row) === pins.get(original), 'selected immutable owner row changed');
  const lastCheckpoint = await read(repository, POINTS_CHECKPOINT_ID, policy);
  const lastProjection = await read(repository, POINTS_PROJECTION_ID, policy);
  need(lastCheckpoint && lastProjection && projectionIdentity(policy, lastCheckpoint, lastProjection) === identity,
    'projection identity changed during selected read');
  return row;
}

/** Bounded UI ownership admission for both historical and live-contribution scoring paths. */
export async function pointOwnership(repository: IndexerRepository, address: string): Promise<PointOwnership> {
  const id = canonicalAccount(address);
  const policy = await pointsQueryIdentity(repository);
  if (!policy) return { status: 'legacy', ready: true, accountId: id, referralRewardsCodec: '0', policyHash: null, checkpointBlock: null,
    checkpointHash: null, sources: [{ account: address, firstBlock: 1, lastBlock: null }] };
  const base = { ready: true, accountId: id, policyHash: policy.policyHash,
    checkpointBlock: RECOVERY_CHECKPOINT.block, checkpointHash: RECOVERY_CHECKPOINT.hash };
  if (policy.attackerAccounts.some((a) => canonicalAccount(a) === id)) return { ...base, referralRewardsCodec: '0', status: 'extinguished', sources: [] };
  if (policy.substitutions.some((a) => canonicalAccount(a.old) === id)) return { ...base, referralRewardsCodec: '0', status: 'retired', sources: [] };
  const mapping = policy.substitutions.find((a) => canonicalAccount(a.new) === id);
  const current = await repository.get('accountMeta', id);
  let historical = current?.data.pointSourceAddresses ?? [];
  if (mapping) {
    // The finalized projection root, not an arbitrary source-address alias, authorizes old history.
    const entry = await selectedProjectionRow(repository, policy, canonicalAccount(mapping.old));
    historical = (entry.sourceMeta as IndexerDocument | null)?.data.pointSourceAddresses ?? [];
  }
  const original = mapping ? canonicalAccount(mapping.old) : id;
  const oldAliases = addressAliases(historical, original);
  const newAliases = addressAliases(current?.data.pointPostforkAddresses ?? [], id);
  const referral = await repository.get('updatesStreams', POINTS_REFERRAL_PREFIX + id);
  need(!referral || (referral.id === POINTS_REFERRAL_PREFIX + id && referral.data.accountId === id &&
    referral.data.policyHash === policy.policyHash && typeof referral.data.amountCodec === 'string' &&
    /^(0|[1-9][0-9]{0,79})$/.test(referral.data.amountCodec)), 'invalid current referral points');
  return { ...base, referralRewardsCodec: String(referral?.data.amountCodec ?? '0'), status: mapping ? 'replacement' : 'active', sources: [
    ...oldAliases.map((account) => ({ account, firstBlock: 1, lastBlock: RECOVERY_CHECKPOINT.block })),
    ...newAliases.map((account) => ({ account, firstBlock: RECOVERY_CHECKPOINT.block + 1, lastBlock: null })),
  ] };
}

export type CheckpointPointOwnerSource = {
  original: string;
  sourceMeta: IndexerDocument | null;
  sourceEras: IndexerDocument[];
  referralSource: IndexerDocument | null;
  destinationMeta: null;
  destinationEras: [];
  destinationReferral: null;
};
const ledgerResult = (policy: BurnAllocationPolicy, checkpointReceiptRoot: unknown, root: string, records: Record<string, unknown>[]) => ({
  ...allocationBinding(policy), checkpointReceiptRoot, projectionLedgerRoot: root, records,
  source: 'canonical-indexer-checkpoint-projection', scope: 'affected-checkpoint-point-ownership', scoringRulesChanged: false,
  externalReplayVerified: false, productionReady: false,
});

/**
 * Executable acyclic allocation API for a BEFORE-release verifier. No manifest,
 * future anchor, live DB or fabricated recovery identity is needed. This pure
 * transformation does NOT authenticate caller data: a fresh complete-history
 * verifier must establish source/valuation/continuity before using it as evidence.
 */
export function deriveCheckpointPointLedger(input: BurnAllocationPolicy, checkpointReceiptRoot: string, sources: CheckpointPointOwnerSource[]) {
  need(Object.keys(input).sort().join(',') === 'attackerAccounts,checkpoint,genesisHash,policyHash,substitutions,version', 'offline allocation excludes future live fields');
  const policy = validateBurnAllocationPolicy(input); const items = targets(policy);
  need(SHA.test(checkpointReceiptRoot) && sources.length === items.length, 'offline checkpoint source coverage mismatch');
  let root = pointsDigest({ ...allocationBinding(policy), checkpointReceiptRoot, targetCount: items.length });
  let retainedBytes = 0; const records: Record<string, unknown>[] = [];
  for (const [index, target] of items.entries()) {
    const source = sources[index];
    need(source.original === target.original && source.destinationMeta === null && source.destinationReferral === null &&
      Array.isArray(source.destinationEras) && source.destinationEras.length === 0, 'offline target order/destination absence mismatch');
    const { sourceMeta, sourceEras, referralSource } = source;
    need(sourceMeta !== undefined && referralSource !== undefined && Array.isArray(sourceEras) && sourceEras.length <= MAX_ERAS &&
      Boolean(sourceMeta) === Boolean(sourceEras.length), 'offline metadata/era source mismatch');
    need((sourceMeta === null || sourceMeta.collection === 'accountMeta') && sourceEras.every((x) => x.collection === 'accountPointSystems'), 'offline source kind mismatch');
    const rows = [...(sourceMeta ? [sourceMeta] : []), ...sourceEras];
    rows.forEach((row) => validatePointSource(row, target.original));
    need(new Set(rows.map((row) => row.collection + '/' + row.id)).size === rows.length &&
      rows.every((row) => row.data.pointRecoveryPolicyHash === policy.policyHash), 'offline source duplication/policy mismatch');
    if (referralSource) validateReferral(referralSource, target.original, policy);
    const projected = target.owner ? [...rows.map((row) => project(row, target.original, target.owner, policy)),
      ...(referralSource ? [projectReferral(referralSource, target.original, target.owner, policy)] : [])] : [];
    const evidence = { ...allocationBinding(policy), index, ...target, claimable: target.owner !== null && (sourceMeta !== null || referralSource !== null),
      sourcePresent: sourceMeta !== null || referralSource !== null, sourceMeta, sourceEras, referralSource, projected,
      checkpointReceiptRoot, previousLedgerRoot: root };
    const bytes = Buffer.byteLength(JSON.stringify(evidence)); retainedBytes += bytes;
    need(bytes <= MAX_OWNER_BYTES && retainedBytes <= MAX_EXPORT_BYTES, 'offline source/export bound exceeded');
    const rowHash = pointsDigest(evidence);
    records.push({ id: POINTS_LEDGER_PREFIX + target.original, ...evidence, rowHash });
    root = pointsDigest({ previous: root, rowHash });
  }
  return ledgerResult(policy, checkpointReceiptRoot, root, records);
}

/** Finite export for release binding: original affected sources plus exact once-only projected values. */
export async function exportPointsRecovery(repository: IndexerRepository, policy: BurnRecoveryPolicy) {
  const checkpoint = await read(repository, POINTS_CHECKPOINT_ID, policy);
  const projection = await read(repository, POINTS_PROJECTION_ID, policy);
  need(checkpoint && projection?.complete === true, 'projection is incomplete');
  need(checkpoint.throughBlock === RECOVERY_CHECKPOINT.block && checkpoint.blockHash === RECOVERY_CHECKPOINT.hash &&
    projection.checkpointReceiptRoot === checkpoint.receiptRoot && projection.cursor === targets(policy).length, 'invalid checkpoint/projection identity');
  const { root, records } = await verifyProjectionPrefix(repository, policy, checkpoint, projection, false, true);
  return ledgerResult(policy, checkpoint.receiptRoot, root, records);
}

export const POINT_JOURNAL_MAX_BLOCKS = 4096;
export const POINT_JOURNAL_MAX_BYTES = 512 * 1024 ** 2;
export const POINT_JOURNAL_MAX_LINE_BYTES = 40 * 1024 ** 2;
export type PointJournalCursor = { block: number; hash: string; receiptRoot: string };
export type PointJournalEntry = { journal: IndexerDocument; valuation: IndexerDocument };
export function pointJournalId(block: number): string {
  need(integer(block, 1) && block <= 0xffffffff, 'invalid journal block');
  return POINTS_JOURNAL_PREFIX + String(block).padStart(10, '0');
}
export function initialPointJournalCursor(policy: BurnAllocationPolicy): PointJournalCursor {
  validateBurnAllocationPolicy(policy); targets(policy);
  return { block: 0, hash: policy.genesisHash, receiptRoot: pointsDigest({ ...allocationBinding(policy),
    startBlock: 1, valuationReceiptSchema: VALUATION_SCHEMA }) };
}
function journalCursor(cursor: PointJournalCursor): void {
  need(cursor && Object.keys(cursor).sort().join(',') === 'block,hash,receiptRoot' &&
    integer(cursor.block) && cursor.block <= 0xffffffff && HASH.test(cursor.hash) && SHA.test(cursor.receiptRoot), 'invalid journal cursor');
}
/** Recompute the stored commitment only. This does not execute scoring or authenticate chain storage. */
export function validatePointJournalEntry(entry: PointJournalEntry, policy: BurnAllocationPolicy, previous: PointJournalCursor): PointJournalCursor {
  journalCursor(previous);
  need(entry && Object.keys(entry).sort().join(',') === 'journal,valuation', 'invalid journal entry');
  const row = entry.journal; const data = object(row?.data);
  serializeIndexerDocument(row);
  need(Object.keys(data).sort().join(',') === 'allocation,block,blockHex,eventHexes,hash,id,parentHash,pointRows,previousReceiptRoot,productionReady,receiptRoot,schema,scoringReexecuted,storageProofsVerified,valuation', 'journal fields differ');
  const block = data.block;
  need(integer(block, 1) && block === previous.block + 1 && row.collection === 'updatesStreams' &&
    row.id === pointJournalId(block) && data.id === row.id && row.blockHeight === block && row.timestamp === null &&
    data.schema === POINTS_JOURNAL_SCHEMA && pointsDigest(data.allocation) === pointsDigest(allocationBinding(policy)) &&
    data.parentHash === previous.hash && data.previousReceiptRoot === previous.receiptRoot &&
    typeof data.hash === 'string' && HASH.test(data.hash) && data.storageProofsVerified === false &&
    data.scoringReexecuted === false && data.productionReady === false, 'journal identity, policy or continuity mismatch');
  if (block === RECOVERY_CHECKPOINT.block) need(data.hash === RECOVERY_CHECKPOINT.hash, 'journal checkpoint mismatch');
  need(typeof data.blockHex === 'string' && /^0x(?:[0-9a-f]{2})+$/.test(data.blockHex) && Array.isArray(data.eventHexes) &&
    data.eventHexes.every((x) => typeof x === 'string' && /^0x(?:[0-9a-f]{2})+$/.test(x)) && Array.isArray(data.pointRows), 'journal raw inputs missing');
  for (const point of data.pointRows) {
    serializeIndexerDocument(point);
    need(point.blockHeight === block && (point.collection === 'accountMeta' || point.collection === 'accountPointSystems' ||
      (point.collection === 'updatesStreams' && point.id.startsWith(POINTS_REFERRAL_PREFIX))), 'journal includes non-point writes');
  }
  const valuation = entry.valuation; serializeIndexerDocument(valuation);
  const inputs = valuation.data.inputs as PointValuationInputs; validateValuationInputs(inputs);
  const digest = pointsDigest(inputs);
  const reference = { schema: VALUATION_SCHEMA, parentBlock: previous.block, parentHash: previous.hash, inputsSha256: digest, storageProofsVerified: false };
  need(valuation.collection === 'updatesStreams' && valuation.id === POINTS_VALUATION_PREFIX + digest && valuation.blockHeight === 0 &&
    valuation.timestamp === null && pointsDigest(valuation.data) === pointsDigest({ id: valuation.id, schema: VALUATION_SCHEMA,
      inputsSha256: digest, inputs, storageProofsVerified: false }) && pointsDigest(data.valuation) === pointsDigest(reference), 'journal valuation mismatch');
  const receiptRoot = pointsDigest({ previous: previous.receiptRoot, block, hash: data.hash,
    blockSha256: createHash('sha256').update(Buffer.from(data.blockHex.slice(2), 'hex')).digest('hex'),
    orderedEventsSha256: pointsDigest(data.eventHexes), pointWritesSha256: pointsDigest(data.pointRows), valuation: reference });
  need(data.receiptRoot === receiptRoot, 'journal receipt commitment mismatch');
  need(Buffer.byteLength(JSON.stringify(entry)) <= POINT_JOURNAL_MAX_LINE_BYTES, 'journal entry byte bound');
  return { block, hash: data.hash, receiptRoot };
}

/** Finite, read-only export. No list(), RPC, whole-history allocation or score reconstruction. */
export async function exportPointJournalRange(repository: IndexerRepository, policy: BurnAllocationPolicy, first: number, last: number,
  emit: (entry: PointJournalEntry) => Promise<void>) {
  const initial = initialPointJournalCursor(policy);
  need(integer(first, 1) && integer(last, first) && last <= RECOVERY_CHECKPOINT.block && last - first + 1 <= POINT_JOURNAL_MAX_BLOCKS, 'journal range bound');
  const head = await repository.get('updatesStreams', POINTS_RECOVERY_ID);
  need(head?.data.journalSchema === POINTS_JOURNAL_SCHEMA && integer(head.data.throughBlock) && head.data.throughBlock >= last &&
    Object.entries(allocationBinding(policy)).every(([key, value]) => pointsDigest(head.data[key]) === pointsDigest(value)), 'journal head or allocation mismatch');
  let previous = initial;
  if (first !== 1) {
    const preceding = await repository.get('updatesStreams', pointJournalId(first - 1));
    need(preceding?.data.schema === POINTS_JOURNAL_SCHEMA && preceding.id === pointJournalId(first - 1) &&
      preceding.data.block === first - 1 && pointsDigest(preceding.data.allocation) === pointsDigest(allocationBinding(policy)), 'missing preceding journal segment');
    previous = { block: first - 1, hash: preceding.data.hash as string, receiptRoot: preceding.data.receiptRoot as string };
    journalCursor(previous);
  }
  const start = previous; let bytes = 0;
  for (let block = first; block <= last; block++) {
    const journal = await repository.get('updatesStreams', pointJournalId(block));
    need(journal, 'missing journal block');
    const digest = object(journal.data.valuation).inputsSha256;
    need(typeof digest === 'string' && SHA.test(digest), 'invalid journal valuation reference');
    const valuation = await repository.get('updatesStreams', POINTS_VALUATION_PREFIX + digest);
    need(valuation, 'missing journal valuation snapshot');
    const entry = { journal, valuation };
    previous = validatePointJournalEntry(entry, policy, previous);
    bytes += Buffer.byteLength(JSON.stringify(entry) + '\n');
    need(bytes <= POINT_JOURNAL_MAX_BYTES, 'journal range byte bound; choose a smaller range');
    await emit(entry);
  }
  if (last === head.data.throughBlock) need(previous.hash === head.data.blockHash && previous.receiptRoot === head.data.receiptRoot, 'journal/head mismatch');
  if (last === RECOVERY_CHECKPOINT.block) {
    const checkpoint = await repository.get('updatesStreams', POINTS_CHECKPOINT_ID);
    need(checkpoint?.data.receiptRoot === previous.receiptRoot && checkpoint.data.blockHash === previous.hash, 'journal/checkpoint mismatch');
  }
  need(pointsDigest(await repository.get('updatesStreams', POINTS_RECOVERY_ID)) === pointsDigest(head), 'journal source advanced during export');
  return { schema: 'sora-nexus-soratopia-point-journal-range-v1', first, last, blocks: last - first + 1, start, end: previous,
    allocation: allocationBinding(policy), bytes, commitmentChainVerified: true, storageProofsVerified: false,
    suppliedSegmentStartAuthenticated: false, scoringReexecuted: false, historicalCoverageVerified: false, externalReplayVerified: false, productionReady: false };
}
