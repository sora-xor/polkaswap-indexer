import { pathToFileURL } from 'node:url';

import { readConfig } from '../config.js';
import { RocksRepository } from '../repository/rocksdb.js';
import { rocksAvailableBytes } from '../repository/rocksdb-maintenance.js';
import {
  MAX_REPOSITORY_WRITE_CALL_DOCUMENTS,
} from '../repository/validation.js';
import { readPositiveSafeInteger, readStrictBoolean } from './env.js';
import {
  assertCurrentRocksdbArtifactSource,
  assertExistingRocksdbDirectory,
} from './rocksdb-artifact-source.js';

import type {
  IndexerCollection,
  IndexerDocument,
  IndexerRepository,
  RepositoryQueryArgs,
} from '../repository/types.js';

const SCALE = 10n ** 18n;
const PAGE_SIZE = 1_000;
const PAGE_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_WRITE_BATCH_SIZE = 500;
const DEFAULT_MAX_HISTORY_ROWS = 25_000_000;
const DEFAULT_MAX_SWAP_OBSERVATIONS = 1_000_000;
const DEFAULT_MAX_SNAPSHOTS = 1_000_000;
const DEFAULT_MAX_AGGREGATE_SNAPSHOTS = 10_000;
const DEFAULT_MAX_WRITE_GB = 4;
const DEFAULT_MIN_FREE_GB = 2;
const DEFAULT_PROGRESS_EVERY = 100_000;
const WRITE_AMPLIFICATION_RESERVE = 8;
const GIB = 1024 ** 3;
const APPLY_CONFIRMATION = 'REPAIR:networkSnapshots.volumeUSD:v1';
const REPAIR_VERSION = 1;
const REPAIR_SEMANTICS = 'persisted-exchangeVolumeUSD-or-legacy-liquidityProxy-v1';
const SWAP_METHODS = new Set(['swap', 'swapTransfer', 'swapTransferBatch']);
const SNAPSHOT_WINDOWS = {
  DEFAULT: 5 * 60,
  HOUR: 60 * 60,
  DAY: 24 * 60 * 60,
  MONTH: 30 * 24 * 60 * 60,
} as const;
const SNAPSHOT_TYPES = ['BLOCK', 'DEFAULT', 'HOUR', 'DAY', 'MONTH'] as const;

type AggregateSnapshotType = keyof typeof SNAPSHOT_WINDOWS;
type SnapshotType = (typeof SNAPSHOT_TYPES)[number];

export const NETWORK_VOLUME_REPAIR_MARKER_ID = 'networkVolumeRepair-v1';

export type NetworkVolumeRepairLimits = {
  maxHistoryRows: number;
  maxSwapObservations: number;
  maxSnapshots: number;
  maxAggregateSnapshots: number;
  maxWriteBytes: number;
  progressEvery: number;
  writeBatchSize: number;
};

export type NetworkVolumeRepairProgress = {
  phase:
    | 'snapshot-inventory'
    | 'history-scan'
    | 'block-plan'
    | 'block-apply'
    | 'block-verify'
    | 'aggregate-apply'
    | 'aggregate-verify';
  rows: number;
  valuedSwaps?: number;
  changedRows?: number;
};

export type NetworkVolumeRepairSpace = {
  availableBytes: number;
  estimatedWriteBytes: number;
  writeAmplificationReserveBytes: number;
  minimumFreeBytes: number;
  requiredAvailableBytes: number;
  sufficient: boolean;
};

export type NetworkVolumeRepairSummary = {
  status: 'dry-run' | 'applied' | 'already-applied';
  repairVersion: number;
  semantics: string;
  throughBlock: number;
  earliestHistoryTimestamp: number;
  latestSnapshotTimestamp: number;
  historyRowsScanned: number;
  valuedSwapRows: number;
  blockSnapshotsScanned: number;
  aggregateSnapshotsScanned: number;
  changedBlockSnapshots: number;
  changedAggregateSnapshots: number;
  estimatedWriteBytes: number;
  space: NetworkVolumeRepairSpace;
};

type RepairRepository = Pick<
  IndexerRepository,
  'query' | 'get' | 'upsert' | 'upsertMany'
>;

type SnapshotInventory = {
  throughBlock: number;
  earliestHistoryTimestamp: number;
  latestSnapshotTimestamp: number;
  blockSnapshots: Map<number, { id: string; timestamp: number; swaps: number }>;
  aggregateSnapshots: IndexerDocument[];
  blockSnapshotsScanned: number;
  aggregateSnapshotsScanned: number;
};

type SwapObservation = {
  blockHeight: number;
  timestamp: number;
  volumeUSD: bigint;
  countsTowardPersistedSnapshotSwaps: boolean;
};

type SwapScan = {
  observations: SwapObservation[];
  retainedBlockCounts: Map<number, number>;
  retainedBlockVolumes: Map<number, bigint>;
  historyRowsScanned: number;
  valuedSwapRows: number;
};

type NetworkVolumeRepairPlan = {
  summary: Omit<NetworkVolumeRepairSummary, 'status' | 'space'>;
  retainedBlockVolumes: Map<number, bigint>;
  aggregateUpdates: IndexerDocument[];
};

type ExecuteNetworkVolumeRepairOptions = {
  apply: boolean;
  availableBytes: number;
  minimumFreeBytes: number;
  limits?: Partial<NetworkVolumeRepairLimits>;
  now?: () => number;
  onProgress?: (progress: NetworkVolumeRepairProgress) => void;
};

type RepairMode = {
  apply: boolean;
  minimumFreeBytes: number;
  limits: NetworkVolumeRepairLimits;
};

const defaultLimits = (): NetworkVolumeRepairLimits => ({
  maxHistoryRows: DEFAULT_MAX_HISTORY_ROWS,
  maxSwapObservations: DEFAULT_MAX_SWAP_OBSERVATIONS,
  maxSnapshots: DEFAULT_MAX_SNAPSHOTS,
  maxAggregateSnapshots: DEFAULT_MAX_AGGREGATE_SNAPSHOTS,
  maxWriteBytes: DEFAULT_MAX_WRITE_GB * GIB,
  progressEvery: DEFAULT_PROGRESS_EVERY,
  writeBatchSize: DEFAULT_WRITE_BATCH_SIZE,
});

const withLimits = (overrides: Partial<NetworkVolumeRepairLimits> = {}): NetworkVolumeRepairLimits => {
  const limits = { ...defaultLimits(), ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Network volume repair limit ${name} must be a positive safe integer`);
    }
  }
  if (limits.writeBatchSize > MAX_REPOSITORY_WRITE_CALL_DOCUMENTS) {
    throw new Error(
      `Network volume repair writeBatchSize must not exceed ${MAX_REPOSITORY_WRITE_CALL_DOCUMENTS}`
    );
  }
  return limits;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const safeNonNegativeInteger = (value: unknown, label: string): number => {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return parsed;
};

const parseNaturalUsd = (value: unknown): bigint | null => {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)(?:\.\d{1,18})?$/.test(value)) return null;
  const [integer = '0', fraction = ''] = value.split('.');
  return BigInt(integer) * SCALE + BigInt(fraction.padEnd(18, '0'));
};

const scaledToString = (value: bigint, precision = 8): string => {
  if (value < 0n) throw new Error('Network volume must not be negative');
  const integer = value / SCALE;
  const fraction = value % SCALE;
  const fractionText = fraction
    .toString()
    .padStart(18, '0')
    .slice(0, precision)
    .replace(/0+$/, '');
  return `${integer.toString()}${fractionText ? `.${fractionText}` : ''}`;
};

const swapMethodsInHistory = (document: IndexerDocument): Set<string> => {
  const module = String(document.data.module ?? '');
  const method = String(document.data.method ?? '');
  const methods = new Set<string>();
  if (module === 'liquidityProxy' && SWAP_METHODS.has(method)) methods.add(method);

  const callNames = Array.isArray(document.data.callNames)
    ? document.data.callNames.map(String)
    : [];
  for (const callName of callNames) {
    const [callModule, callMethod] = callName.split('.');
    if (callModule === 'liquidityProxy' && SWAP_METHODS.has(callMethod ?? '')) {
      methods.add(callMethod!);
    }
  }
  return methods;
};

const historyExecution = (document: IndexerDocument): boolean | null => {
  const execution = document.data.execution;
  if (!isRecord(execution) || typeof execution.success !== 'boolean') return null;
  return execution.success;
};

/**
 * Reconstructs the persisted USD volume for one successful swap history row.
 * New rows use the exact event-derived projection. Legacy direct rows use the
 * same larger-side/batch-receiver fallback that the production UI used.
 */
export const volumeFromSwapHistory = (
  document: IndexerDocument
): {
  candidate: boolean;
  successful: boolean;
  volumeUSD: bigint | null;
  countsTowardPersistedSnapshotSwaps: boolean;
} => {
  const methods = swapMethodsInHistory(document);
  if (!methods.size) {
    return {
      candidate: false,
      successful: false,
      volumeUSD: null,
      countsTowardPersistedSnapshotSwaps: false,
    };
  }

  const execution = historyExecution(document);
  if (execution === false) {
    return {
      candidate: true,
      successful: false,
      volumeUSD: null,
      countsTowardPersistedSnapshotSwaps: false,
    };
  }

  const payload = isRecord(document.data.data) ? document.data.data : null;
  const exactProjection = Boolean(payload && Object.hasOwn(payload, 'exchangeVolumeUSD'));
  // Legacy snapshots counted swap and swapTransfer but not
  // swapTransferBatch. Exact projections were written by the corrected worker,
  // which counts every current classifier match once per extrinsic.
  const countsTowardPersistedSnapshotSwaps =
    exactProjection || [...methods].some((method) => method !== 'swapTransferBatch');
  if (execution === null) {
    return {
      candidate: true,
      successful: true,
      volumeUSD: null,
      countsTowardPersistedSnapshotSwaps,
    };
  }

  if (!payload) {
    return {
      candidate: true,
      successful: true,
      volumeUSD: null,
      countsTowardPersistedSnapshotSwaps,
    };
  }

  if (exactProjection) {
    return {
      candidate: true,
      successful: true,
      volumeUSD: parseNaturalUsd(payload.exchangeVolumeUSD),
      countsTowardPersistedSnapshotSwaps,
    };
  }

  if (methods.size !== 1) {
    return {
      candidate: true,
      successful: true,
      volumeUSD: null,
      countsTowardPersistedSnapshotSwaps,
    };
  }
  const [method] = methods;
  if (method === 'swapTransferBatch') {
    if (!Array.isArray(payload.receivers)) {
      return {
        candidate: true,
        successful: true,
        volumeUSD: null,
        countsTowardPersistedSnapshotSwaps,
      };
    }
    let total = 0n;
    for (const receiver of payload.receivers) {
      if (!isRecord(receiver)) {
        return {
          candidate: true,
          successful: true,
          volumeUSD: null,
          countsTowardPersistedSnapshotSwaps,
        };
      }
      const amount = parseNaturalUsd(receiver.amountUSD);
      if (amount === null) {
        return {
          candidate: true,
          successful: true,
          volumeUSD: null,
          countsTowardPersistedSnapshotSwaps,
        };
      }
      total += amount;
    }
    return {
      candidate: true,
      successful: true,
      volumeUSD: total,
      countsTowardPersistedSnapshotSwaps,
    };
  }

  const base = parseNaturalUsd(payload.baseAssetAmountUSD);
  const target = parseNaturalUsd(payload.targetAssetAmountUSD);
  if (base === null || target === null) {
    return {
      candidate: true,
      successful: true,
      volumeUSD: null,
      countsTowardPersistedSnapshotSwaps,
    };
  }
  return {
    candidate: true,
    successful: true,
    volumeUSD: base > target ? base : target,
    countsTowardPersistedSnapshotSwaps,
  };
};

const documentTimestamp = (document: IndexerDocument, label: string): number =>
  safeNonNegativeInteger(document.timestamp ?? document.data.timestamp, `${label} timestamp`);

const documentBlockHeight = (document: IndexerDocument, label: string): number =>
  safeNonNegativeInteger(
    document.blockHeight ?? document.data.blockHeight,
    `${label} block height`
  );

const encodedDocumentBytes = (document: IndexerDocument): number =>
  Buffer.byteLength(JSON.stringify(document), 'utf8');

const reportProgress = (
  onProgress: ExecuteNetworkVolumeRepairOptions['onProgress'],
  progressEvery: number,
  progress: NetworkVolumeRepairProgress
): void => {
  if (progress.rows > 0 && progress.rows % progressEvery === 0) onProgress?.(progress);
};

async function* queryPages(
  repository: RepairRepository,
  collection: IndexerCollection,
  args: RepositoryQueryArgs
): AsyncGenerator<IndexerDocument[], void, unknown> {
  if (!repository.query) throw new Error('Network volume repair requires a query-capable repository');

  let seek: RepositoryQueryArgs['seek'];
  while (true) {
    const page = await repository.query(collection, {
      ...args,
      first: PAGE_SIZE,
      maxBytes: PAGE_MAX_BYTES,
      includeTotalCount: false,
      offset: null,
      seek,
    });
    if (page.items.length) yield page.items;

    const hasNextPage = page.hasNextPage ?? page.items.length >= PAGE_SIZE;
    if (!hasNextPage) break;
    const last = page.items.at(-1);
    if (!last) {
      throw new Error(`Repository reported another ${collection} page without a cursor row`);
    }
    const timestamp = documentTimestamp(last, `${collection}/${last.id}`);
    seek = { field: 'timestamp', value: timestamp, id: last.id, direction: 'asc' };
  }
}

const collectSnapshotInventory = async (
  repository: RepairRepository,
  limits: NetworkVolumeRepairLimits,
  onProgress?: ExecuteNetworkVolumeRepairOptions['onProgress']
): Promise<SnapshotInventory> => {
  const blockSnapshots = new Map<number, { id: string; timestamp: number; swaps: number }>();
  const aggregateSnapshots: IndexerDocument[] = [];
  let blockSnapshotsScanned = 0;
  let aggregateSnapshotsScanned = 0;
  let totalSnapshots = 0;
  let throughBlock = 0;
  let earliestHistoryTimestamp = Number.POSITIVE_INFINITY;
  let latestSnapshotTimestamp = 0;

  for (const type of SNAPSHOT_TYPES) {
    for await (const page of queryPages(repository, 'networkSnapshots', {
      filter: { type: { equalTo: type } },
      orderBy: ['TIMESTAMP_ASC'],
    })) {
      for (const document of page) {
        totalSnapshots += 1;
        if (totalSnapshots > limits.maxSnapshots) {
          throw new Error(
            `Network volume repair snapshot limit exceeded (${limits.maxSnapshots})`
          );
        }
        const label = `networkSnapshots/${document.id}`;
        const timestamp = documentTimestamp(document, label);
        const blockHeight = documentBlockHeight(document, label);
        throughBlock = Math.max(throughBlock, blockHeight);
        latestSnapshotTimestamp = Math.max(latestSnapshotTimestamp, timestamp);

        if (type === 'BLOCK') {
          if (blockSnapshots.has(blockHeight)) {
            throw new Error(`Duplicate BLOCK network snapshot at block ${blockHeight}`);
          }
          blockSnapshots.set(blockHeight, {
            id: document.id,
            timestamp,
            swaps: safeNonNegativeInteger(
              document.data.swaps ?? 0,
              `${label} swaps`
            ),
          });
          blockSnapshotsScanned += 1;
          earliestHistoryTimestamp = Math.min(earliestHistoryTimestamp, timestamp);
        } else {
          aggregateSnapshots.push(document);
          aggregateSnapshotsScanned += 1;
          if (aggregateSnapshotsScanned > limits.maxAggregateSnapshots) {
            throw new Error(
              `Network volume repair aggregate snapshot limit exceeded (${limits.maxAggregateSnapshots})`
            );
          }
          earliestHistoryTimestamp = Math.min(
            earliestHistoryTimestamp,
            Math.max(0, timestamp - SNAPSHOT_WINDOWS[type])
          );
        }

        reportProgress(onProgress, limits.progressEvery, {
          phase: 'snapshot-inventory',
          rows: totalSnapshots,
        });
      }
    }
  }

  if (!Number.isFinite(earliestHistoryTimestamp) || latestSnapshotTimestamp <= 0) {
    throw new Error('No repairable network snapshots were found');
  }

  return {
    throughBlock,
    earliestHistoryTimestamp,
    latestSnapshotTimestamp,
    blockSnapshots,
    aggregateSnapshots,
    blockSnapshotsScanned,
    aggregateSnapshotsScanned,
  };
};

const scanSwapHistory = async (
  repository: RepairRepository,
  inventory: SnapshotInventory,
  limits: NetworkVolumeRepairLimits,
  onProgress?: ExecuteNetworkVolumeRepairOptions['onProgress']
): Promise<SwapScan> => {
  const observations: SwapObservation[] = [];
  const retainedBlockCounts = new Map<number, number>();
  const retainedBlockVolumes = new Map<number, bigint>();
  let historyRowsScanned = 0;
  let valuedSwapRows = 0;

  for await (const page of queryPages(repository, 'historyElements', {
    filter: {
      and: [
        {
          timestamp: {
            greaterThanOrEqualTo: inventory.earliestHistoryTimestamp,
            lessThanOrEqualTo: inventory.latestSnapshotTimestamp,
          },
        },
      ],
    },
    orderBy: ['TIMESTAMP_ASC'],
  })) {
    for (const document of page) {
      historyRowsScanned += 1;
      if (historyRowsScanned > limits.maxHistoryRows) {
        throw new Error(
          `Network volume repair history row limit exceeded (${limits.maxHistoryRows})`
        );
      }

      const reconstructed = volumeFromSwapHistory(document);
      if (!reconstructed.candidate || !reconstructed.successful) {
        reportProgress(onProgress, limits.progressEvery, {
          phase: 'history-scan',
          rows: historyRowsScanned,
          valuedSwaps: valuedSwapRows,
        });
        continue;
      }

      const blockHeight = documentBlockHeight(document, `historyElements/${document.id}`);
      const timestamp = documentTimestamp(document, `historyElements/${document.id}`);
      if (reconstructed.volumeUSD === null) {
        throw new Error(
          `Cannot safely value successful liquidityProxy history at block ${blockHeight}; repair aborted before writes`
        );
      }

      valuedSwapRows += 1;
      if (valuedSwapRows > limits.maxSwapObservations) {
        throw new Error(
          `Network volume repair swap observation limit exceeded (${limits.maxSwapObservations})`
        );
      }
      observations.push({
        blockHeight,
        timestamp,
        volumeUSD: reconstructed.volumeUSD,
        countsTowardPersistedSnapshotSwaps:
          reconstructed.countsTowardPersistedSnapshotSwaps,
      });

      if (inventory.blockSnapshots.has(blockHeight)) {
        if (reconstructed.countsTowardPersistedSnapshotSwaps) {
          retainedBlockCounts.set(
            blockHeight,
            (retainedBlockCounts.get(blockHeight) ?? 0) + 1
          );
        }
        retainedBlockVolumes.set(
          blockHeight,
          (retainedBlockVolumes.get(blockHeight) ?? 0n) + reconstructed.volumeUSD
        );
      }

      reportProgress(onProgress, limits.progressEvery, {
        phase: 'history-scan',
        rows: historyRowsScanned,
        valuedSwaps: valuedSwapRows,
      });
    }
  }

  observations.sort((left, right) => {
    if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp;
    return left.blockHeight - right.blockHeight;
  });

  return {
    observations,
    retainedBlockCounts,
    retainedBlockVolumes,
    historyRowsScanned,
    valuedSwapRows,
  };
};

const lowerBoundTimestamp = (observations: SwapObservation[], timestamp: number): number => {
  let low = 0;
  let high = observations.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((observations[middle]?.timestamp ?? Number.POSITIVE_INFINITY) < timestamp) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
};

const upperBoundTimestamp = (observations: SwapObservation[], timestamp: number): number => {
  let low = 0;
  let high = observations.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((observations[middle]?.timestamp ?? Number.POSITIVE_INFINITY) <= timestamp) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
};

const observationPrefixes = (
  observations: SwapObservation[]
): { volumes: bigint[]; counts: number[] } => {
  const volumes = new Array<bigint>(observations.length + 1);
  const counts = new Array<number>(observations.length + 1);
  volumes[0] = 0n;
  counts[0] = 0;
  for (let index = 0; index < observations.length; index += 1) {
    const observation = observations[index]!;
    volumes[index + 1] = volumes[index]! + observation.volumeUSD;
    counts[index + 1] =
      counts[index]! + (observation.countsTowardPersistedSnapshotSwaps ? 1 : 0);
  }
  return { volumes, counts };
};

const observationWindow = (
  observations: SwapObservation[],
  prefixes: { volumes: bigint[]; counts: number[] },
  from: number,
  to: number
): { count: number; volumeUSD: bigint } => {
  const start = lowerBoundTimestamp(observations, from);
  const end = upperBoundTimestamp(observations, to);
  return {
    count: prefixes.counts[end]! - prefixes.counts[start]!,
    volumeUSD: prefixes.volumes[end]! - prefixes.volumes[start]!,
  };
};

const withVolume = (document: IndexerDocument, volumeUSD: bigint): IndexerDocument => ({
  ...document,
  data: {
    ...document.data,
    volumeUSD: scaledToString(volumeUSD, 8),
  },
});

const volumeChanged = (document: IndexerDocument, volumeUSD: bigint): boolean =>
  String(document.data.volumeUSD ?? '') !== scaledToString(volumeUSD, 8);

const assertSnapshotSwapCounts = (
  inventory: SnapshotInventory,
  scan: SwapScan
): void => {
  const blockMismatches: string[] = [];
  let blockMismatchCount = 0;
  for (const [blockHeight, snapshot] of inventory.blockSnapshots) {
    const reconstructed = scan.retainedBlockCounts.get(blockHeight) ?? 0;
    if (reconstructed === snapshot.swaps) continue;
    blockMismatchCount += 1;
    if (blockMismatches.length < 10) {
      blockMismatches.push(
        `${blockHeight} (snapshot=${snapshot.swaps}, reconstructed=${reconstructed})`
      );
    }
  }
  if (blockMismatchCount) {
    throw new Error(
      `Cannot safely reconcile ${blockMismatchCount} BLOCK snapshot swap count(s): ${blockMismatches.join(', ')}; repair aborted before writes`
    );
  }
};

const planAggregateUpdates = (
  inventory: SnapshotInventory,
  observations: SwapObservation[]
): IndexerDocument[] => {
  const prefixes = observationPrefixes(observations);
  const updates: IndexerDocument[] = [];
  const countMismatches: string[] = [];
  let countMismatchTotal = 0;

  for (const document of inventory.aggregateSnapshots) {
    const type = String(document.data.type ?? '') as AggregateSnapshotType;
    if (!(type in SNAPSHOT_WINDOWS)) {
      throw new Error(`Unsupported aggregate network snapshot type on ${document.id}: ${type}`);
    }
    const timestamp = documentTimestamp(document, `networkSnapshots/${document.id}`);
    const window = observationWindow(
      observations,
      prefixes,
      Math.max(0, timestamp - SNAPSHOT_WINDOWS[type]),
      timestamp
    );
    const persistedSwaps = safeNonNegativeInteger(
      document.data.swaps ?? 0,
      `networkSnapshots/${document.id} swaps`
    );
    if (persistedSwaps !== window.count) {
      countMismatchTotal += 1;
      if (countMismatches.length < 10) {
        countMismatches.push(
          `${document.id} (snapshot=${persistedSwaps}, reconstructed=${window.count})`
        );
      }
      continue;
    }
    if (volumeChanged(document, window.volumeUSD)) {
      updates.push(withVolume(document, window.volumeUSD));
    }
  }

  if (countMismatchTotal) {
    throw new Error(
      `Cannot safely reconcile ${countMismatchTotal} aggregate snapshot swap count(s): ${countMismatches.join(', ')}; repair aborted before writes`
    );
  }
  return updates;
};

const scanChangedBlocks = async (
  repository: RepairRepository,
  retainedBlockVolumes: Map<number, bigint>,
  limits: NetworkVolumeRepairLimits,
  phase: 'block-plan' | 'block-verify',
  onProgress?: ExecuteNetworkVolumeRepairOptions['onProgress']
): Promise<{ scanned: number; changed: number; bytes: number }> => {
  let scanned = 0;
  let changed = 0;
  let bytes = 0;
  for await (const page of queryPages(repository, 'networkSnapshots', {
    filter: { type: { equalTo: 'BLOCK' } },
    orderBy: ['TIMESTAMP_ASC'],
  })) {
    for (const document of page) {
      scanned += 1;
      const blockHeight = documentBlockHeight(document, `networkSnapshots/${document.id}`);
      const volumeUSD = retainedBlockVolumes.get(blockHeight) ?? 0n;
      if (volumeChanged(document, volumeUSD)) {
        changed += 1;
        bytes += encodedDocumentBytes(withVolume(document, volumeUSD));
      }
      reportProgress(onProgress, limits.progressEvery, {
        phase,
        rows: scanned,
        changedRows: changed,
      });
    }
  }
  return { scanned, changed, bytes };
};

const planNetworkVolumeRepair = async (
  repository: RepairRepository,
  limits: NetworkVolumeRepairLimits,
  onProgress?: ExecuteNetworkVolumeRepairOptions['onProgress']
): Promise<NetworkVolumeRepairPlan> => {
  const inventory = await collectSnapshotInventory(repository, limits, onProgress);
  const scan = await scanSwapHistory(repository, inventory, limits, onProgress);
  assertSnapshotSwapCounts(inventory, scan);
  const aggregateUpdates = planAggregateUpdates(inventory, scan.observations);
  const changedBlocks = await scanChangedBlocks(
    repository,
    scan.retainedBlockVolumes,
    limits,
    'block-plan',
    onProgress
  );
  if (changedBlocks.scanned !== inventory.blockSnapshotsScanned) {
    throw new Error(
      `BLOCK snapshot inventory changed during repair planning (${inventory.blockSnapshotsScanned} -> ${changedBlocks.scanned})`
    );
  }

  const aggregateWriteBytes = aggregateUpdates.reduce(
    (total, document) => total + encodedDocumentBytes(document),
    0
  );
  // Reserve a small fixed envelope for the completion marker and transaction metadata.
  const estimatedWriteBytes = changedBlocks.bytes + aggregateWriteBytes + 4_096;
  if (estimatedWriteBytes > limits.maxWriteBytes) {
    throw new Error(
      `Network volume repair estimated writes ${estimatedWriteBytes} exceed the configured limit ${limits.maxWriteBytes}`
    );
  }

  return {
    summary: {
      repairVersion: REPAIR_VERSION,
      semantics: REPAIR_SEMANTICS,
      throughBlock: inventory.throughBlock,
      earliestHistoryTimestamp: inventory.earliestHistoryTimestamp,
      latestSnapshotTimestamp: inventory.latestSnapshotTimestamp,
      historyRowsScanned: scan.historyRowsScanned,
      valuedSwapRows: scan.valuedSwapRows,
      blockSnapshotsScanned: inventory.blockSnapshotsScanned,
      aggregateSnapshotsScanned: inventory.aggregateSnapshotsScanned,
      changedBlockSnapshots: changedBlocks.changed,
      changedAggregateSnapshots: aggregateUpdates.length,
      estimatedWriteBytes,
    },
    retainedBlockVolumes: scan.retainedBlockVolumes,
    aggregateUpdates,
  };
};

export const evaluateNetworkVolumeRepairSpace = (
  availableBytes: number,
  estimatedWriteBytes: number,
  minimumFreeBytes: number
): NetworkVolumeRepairSpace => {
  for (const [name, value] of Object.entries({
    availableBytes,
    estimatedWriteBytes,
    minimumFreeBytes,
  })) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${name} must be a non-negative safe integer`);
    }
  }
  const writeAmplificationReserveBytes = estimatedWriteBytes * WRITE_AMPLIFICATION_RESERVE;
  const requiredAvailableBytes = minimumFreeBytes + writeAmplificationReserveBytes;
  if (!Number.isSafeInteger(requiredAvailableBytes)) {
    throw new Error('Network volume repair free-space requirement exceeds the safe integer range');
  }
  return {
    availableBytes,
    estimatedWriteBytes,
    writeAmplificationReserveBytes,
    minimumFreeBytes,
    requiredAvailableBytes,
    sufficient: availableBytes >= requiredAvailableBytes,
  };
};

const flushDocuments = async (
  repository: RepairRepository,
  documents: IndexerDocument[],
  batchSize: number
): Promise<void> => {
  for (let start = 0; start < documents.length; start += batchSize) {
    await repository.upsertMany(documents.slice(start, start + batchSize));
  }
};

const applyBlockUpdates = async (
  repository: RepairRepository,
  plan: NetworkVolumeRepairPlan,
  limits: NetworkVolumeRepairLimits,
  onProgress?: ExecuteNetworkVolumeRepairOptions['onProgress']
): Promise<number> => {
  const pending: IndexerDocument[] = [];
  let scanned = 0;
  let changed = 0;
  const flush = async (): Promise<void> => {
    if (!pending.length) return;
    const batch = pending.splice(0, pending.length);
    await repository.upsertMany(batch);
  };

  for await (const page of queryPages(repository, 'networkSnapshots', {
    filter: { type: { equalTo: 'BLOCK' } },
    orderBy: ['TIMESTAMP_ASC'],
  })) {
    for (const document of page) {
      scanned += 1;
      const blockHeight = documentBlockHeight(document, `networkSnapshots/${document.id}`);
      const volumeUSD = plan.retainedBlockVolumes.get(blockHeight) ?? 0n;
      if (volumeChanged(document, volumeUSD)) {
        pending.push(withVolume(document, volumeUSD));
        changed += 1;
        if (pending.length >= limits.writeBatchSize) await flush();
      }
      reportProgress(onProgress, limits.progressEvery, {
        phase: 'block-apply',
        rows: scanned,
        changedRows: changed,
      });
    }
  }
  await flush();

  if (
    scanned !== plan.summary.blockSnapshotsScanned ||
    changed !== plan.summary.changedBlockSnapshots
  ) {
    throw new Error(
      `BLOCK snapshot apply pass diverged from the preflight plan (scanned ${scanned}/${plan.summary.blockSnapshotsScanned}, changed ${changed}/${plan.summary.changedBlockSnapshots})`
    );
  }
  return changed;
};

const verifyAggregateUpdates = async (
  repository: RepairRepository,
  updates: IndexerDocument[],
  onProgress?: ExecuteNetworkVolumeRepairOptions['onProgress'],
  progressEvery = DEFAULT_PROGRESS_EVERY
): Promise<void> => {
  let verified = 0;
  for (const expected of updates) {
    const actual = await repository.get('networkSnapshots', expected.id);
    if (
      !actual ||
      String(actual.data.volumeUSD ?? '') !== String(expected.data.volumeUSD ?? '')
    ) {
      throw new Error(`Aggregate network snapshot verification failed for ${expected.id}`);
    }
    verified += 1;
    reportProgress(onProgress, progressEvery, {
      phase: 'aggregate-verify',
      rows: verified,
    });
  }
};

const createRepairMarker = (
  plan: NetworkVolumeRepairPlan,
  completedAt: number
): IndexerDocument => ({
  collection: 'updatesStreams',
  id: NETWORK_VOLUME_REPAIR_MARKER_ID,
  blockHeight: plan.summary.throughBlock,
  timestamp: plan.summary.latestSnapshotTimestamp,
  data: {
    id: NETWORK_VOLUME_REPAIR_MARKER_ID,
    block: plan.summary.throughBlock,
    data: JSON.stringify({
      status: 'complete',
      completedAt,
      ...plan.summary,
    }),
  },
});

const readCompletedMarker = (
  document: IndexerDocument | null
): Omit<NetworkVolumeRepairSummary, 'status' | 'space'> | null => {
  if (!document) return null;
  if (typeof document.data.data !== 'string') {
    throw new Error('Network volume repair marker is malformed');
  }
  let value: unknown;
  try {
    value = JSON.parse(document.data.data);
  } catch {
    throw new Error('Network volume repair marker is malformed');
  }
  if (
    !isRecord(value) ||
    value.status !== 'complete' ||
    value.repairVersion !== REPAIR_VERSION ||
    value.semantics !== REPAIR_SEMANTICS
  ) {
    throw new Error('Network volume repair marker has an unsupported version or status');
  }

  const numberField = (field: keyof Omit<NetworkVolumeRepairSummary, 'status' | 'space'>): number =>
    safeNonNegativeInteger(value[field], `repair marker ${field}`);
  return {
    repairVersion: REPAIR_VERSION,
    semantics: REPAIR_SEMANTICS,
    throughBlock: numberField('throughBlock'),
    earliestHistoryTimestamp: numberField('earliestHistoryTimestamp'),
    latestSnapshotTimestamp: numberField('latestSnapshotTimestamp'),
    historyRowsScanned: numberField('historyRowsScanned'),
    valuedSwapRows: numberField('valuedSwapRows'),
    blockSnapshotsScanned: numberField('blockSnapshotsScanned'),
    aggregateSnapshotsScanned: numberField('aggregateSnapshotsScanned'),
    changedBlockSnapshots: numberField('changedBlockSnapshots'),
    changedAggregateSnapshots: numberField('changedAggregateSnapshots'),
    estimatedWriteBytes: numberField('estimatedWriteBytes'),
  };
};

/**
 * Plans and optionally applies the one-shot repair. No repository write occurs
 * until the complete history/snapshot consistency checks and disk preflight pass.
 */
export const executeNetworkVolumeRepair = async (
  repository: RepairRepository,
  options: ExecuteNetworkVolumeRepairOptions
): Promise<NetworkVolumeRepairSummary> => {
  const limits = withLimits(options.limits);
  const completed = readCompletedMarker(
    await repository.get('updatesStreams', NETWORK_VOLUME_REPAIR_MARKER_ID)
  );
  if (completed) {
    return {
      status: 'already-applied',
      ...completed,
      space: evaluateNetworkVolumeRepairSpace(
        options.availableBytes,
        completed.estimatedWriteBytes,
        options.minimumFreeBytes
      ),
    };
  }

  const plan = await planNetworkVolumeRepair(repository, limits, options.onProgress);
  const space = evaluateNetworkVolumeRepairSpace(
    options.availableBytes,
    plan.summary.estimatedWriteBytes,
    options.minimumFreeBytes
  );
  if (!options.apply) return { status: 'dry-run', ...plan.summary, space };
  if (!space.sufficient) {
    throw new Error(
      `Network volume repair requires ${space.requiredAvailableBytes} available bytes but only ${space.availableBytes} are free`
    );
  }

  await applyBlockUpdates(repository, plan, limits, options.onProgress);
  await flushDocuments(repository, plan.aggregateUpdates, limits.writeBatchSize);
  options.onProgress?.({
    phase: 'aggregate-apply',
    rows: plan.aggregateUpdates.length,
    changedRows: plan.aggregateUpdates.length,
  });

  const verification = await scanChangedBlocks(
    repository,
    plan.retainedBlockVolumes,
    limits,
    'block-verify',
    options.onProgress
  );
  if (
    verification.scanned !== plan.summary.blockSnapshotsScanned ||
    verification.changed !== 0
  ) {
    throw new Error(
      `BLOCK snapshot verification failed (scanned ${verification.scanned}/${plan.summary.blockSnapshotsScanned}, remaining changes ${verification.changed})`
    );
  }
  await verifyAggregateUpdates(
    repository,
    plan.aggregateUpdates,
    options.onProgress,
    limits.progressEvery
  );

  const completedAt = Math.floor((options.now?.() ?? Date.now()) / 1_000);
  await repository.upsert(createRepairMarker(plan, completedAt));
  return { status: 'applied', ...plan.summary, space };
};

export const readNetworkVolumeRepairMode = (
  env: NodeJS.ProcessEnv
): RepairMode => {
  const apply = readStrictBoolean(env, 'NETWORK_VOLUME_REPAIR_APPLY', false);
  if (apply && env.NETWORK_VOLUME_REPAIR_CONFIRM !== APPLY_CONFIRMATION) {
    throw new Error(
      `NETWORK_VOLUME_REPAIR_CONFIRM must exactly equal ${APPLY_CONFIRMATION} when apply mode is enabled`
    );
  }

  const minFreeGb = readPositiveSafeInteger(
    env,
    'NETWORK_VOLUME_REPAIR_MIN_FREE_GB',
    DEFAULT_MIN_FREE_GB
  );
  const maxWriteGb = readPositiveSafeInteger(
    env,
    'NETWORK_VOLUME_REPAIR_MAX_WRITE_GB',
    DEFAULT_MAX_WRITE_GB
  );
  return {
    apply,
    minimumFreeBytes: minFreeGb * GIB,
    limits: withLimits({
      maxHistoryRows: readPositiveSafeInteger(
        env,
        'NETWORK_VOLUME_REPAIR_MAX_HISTORY_ROWS',
        DEFAULT_MAX_HISTORY_ROWS
      ),
      maxSwapObservations: readPositiveSafeInteger(
        env,
        'NETWORK_VOLUME_REPAIR_MAX_SWAP_OBSERVATIONS',
        DEFAULT_MAX_SWAP_OBSERVATIONS
      ),
      maxSnapshots: readPositiveSafeInteger(
        env,
        'NETWORK_VOLUME_REPAIR_MAX_SNAPSHOTS',
        DEFAULT_MAX_SNAPSHOTS
      ),
      maxAggregateSnapshots: readPositiveSafeInteger(
        env,
        'NETWORK_VOLUME_REPAIR_MAX_AGGREGATE_SNAPSHOTS',
        DEFAULT_MAX_AGGREGATE_SNAPSHOTS
      ),
      maxWriteBytes: maxWriteGb * GIB,
      progressEvery: readPositiveSafeInteger(
        env,
        'NETWORK_VOLUME_REPAIR_PROGRESS_EVERY',
        DEFAULT_PROGRESS_EVERY
      ),
      writeBatchSize: readPositiveSafeInteger(
        env,
        'NETWORK_VOLUME_REPAIR_WRITE_BATCH_SIZE',
        DEFAULT_WRITE_BATCH_SIZE
      ),
    }),
  };
};

const progressToConsole = (progress: NetworkVolumeRepairProgress): void => {
  const details = [
    `${progress.phase}: ${progress.rows} row(s)`,
    progress.valuedSwaps === undefined ? '' : `${progress.valuedSwaps} valued swap(s)`,
    progress.changedRows === undefined ? '' : `${progress.changedRows} changed row(s)`,
  ].filter(Boolean);
  console.info(details.join('; '));
};

export const openOfflineNetworkVolumeRepairRepository = async (
  rocksdbPath: string,
  _apply: boolean,
  config: ReturnType<typeof readConfig>
): Promise<RocksRepository> => {
  await assertExistingRocksdbDirectory(rocksdbPath);

  // Validate through a non-mutating handle before asking RocksDB for its
  // exclusive writer lock. A typo or unversioned directory must never be
  // initialized merely because this is an offline maintenance command.
  let validator: RocksRepository;
  try {
    validator = RocksRepository.openReadOnly({
      ...config,
      rocksdbPath,
      storageEngine: 'rocksdb',
    });
  } catch (error) {
    throw new Error(
      `Cannot inspect RocksDB at ${rocksdbPath}; stop the combined indexer before running the network volume repair`,
      { cause: error }
    );
  }
  try {
    await validator.prepare();
    validator.inspectCurrentSnapshot((database) =>
      assertCurrentRocksdbArtifactSource(database, rocksdbPath)
    );
  } finally {
    await validator.close().catch(() => undefined);
  }

  let repository: RocksRepository;
  try {
    // Dry-run deliberately takes the same writer lock as apply mode. It never
    // calls a write method, but it must prove the combined service is stopped
    // and that the scanned snapshot cannot change beneath the preflight.
    repository = new RocksRepository({
      ...config,
      rocksdbPath,
      storageEngine: 'rocksdb',
    });
  } catch (error) {
    throw new Error(
      `Cannot open RocksDB exclusively at ${rocksdbPath}; stop the combined indexer before running the network volume repair`,
      { cause: error }
    );
  }

  try {
    await repository.prepare();
    repository.inspectCurrentSnapshot((database) =>
      assertCurrentRocksdbArtifactSource(database, rocksdbPath)
    );
    return repository;
  } catch (error) {
    await repository.close().catch(() => undefined);
    throw error;
  }
};

export const runNetworkVolumeRepairCli = async (
  env: NodeJS.ProcessEnv = process.env
): Promise<NetworkVolumeRepairSummary> => {
  const config = readConfig();
  const mode = readNetworkVolumeRepairMode(env);
  const repository = await openOfflineNetworkVolumeRepairRepository(
    config.rocksdbPath,
    mode.apply,
    config
  );

  try {
    const availableBytes = await rocksAvailableBytes(config.rocksdbPath);
    const summary = await executeNetworkVolumeRepair(repository, {
      apply: mode.apply,
      availableBytes,
      minimumFreeBytes: mode.minimumFreeBytes,
      limits: mode.limits,
      onProgress: progressToConsole,
    });
    console.info(JSON.stringify(summary, null, 2));
    if (!mode.apply && summary.status === 'dry-run') {
      console.info(
        `Dry run only. Set NETWORK_VOLUME_REPAIR_APPLY=true and NETWORK_VOLUME_REPAIR_CONFIRM=${APPLY_CONFIRMATION} to apply this exact plan while the combined service is stopped.`
      );
    }
    return summary;
  } finally {
    await repository.close().catch(() => undefined);
  }
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runNetworkVolumeRepairCli().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
