import { GraphQLError } from 'graphql';

import { evaluateServiceReadiness, type WorkerReadinessThresholds } from '../readiness.js';

import type { IndexerRepository, RepositoryQueryResult } from '../repository/types.js';
import type { ChainIndexerStatusProvider } from '../worker/status.js';

export type CheckpointContext = {
  repository: IndexerRepository;
  workerStatusProvider?: ChainIndexerStatusProvider;
  workerReadinessThresholds?: WorkerReadinessThresholds;
  graphqlQueryMaxBytes?: number;
};

const LATEST_BLOCK_ARGS = {
  first: 1,
  orderBy: ['TIMESTAMP_DESC'],
  filter: { type: { equalTo: 'BLOCK' } },
  includeTotalCount: true,
};

/**
 * Captures current checkpoint reads inside a stable state/worker fence. This is
 * a bounded optimistic read, not a database transaction: only observed movement
 * retries, while a stable worker/state disagreement remains visible to health.
 * Every read uses the operation's materialization-budgeted repository.
 */
const captureCheckpointView = async (context: CheckpointContext) => {
  const readiness = () => evaluateServiceReadiness(
    context.repository,
    context.workerStatusProvider,
    context.workerReadinessThresholds ?? { maxLagBlocks: 25, maxStalenessSeconds: 120 }
  );
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const stateDocument = await context.repository.get('updatesStreams', 'chainState');
    const before = await readiness();
    const identityDocument = await context.repository.get('updatesStreams', 'chainIdentity');
    // All production backends implement bounded query. Legacy test/custom
    // repositories without it retain their normal connection fallback.
    const latestBlock: RepositoryQueryResult | null = context.repository.query
      ? await context.repository.query('networkSnapshots', {
          ...LATEST_BLOCK_ARGS,
          maxBytes: context.graphqlQueryMaxBytes,
        })
      : null;
    const stateAfter = await context.repository.get('updatesStreams', 'chainState');
    const after = await readiness();
    if (
      JSON.stringify(stateDocument) === JSON.stringify(stateAfter) &&
      JSON.stringify(before.worker) === JSON.stringify(after.worker)
    ) {
      return { stateDocument, identityDocument, readiness: after, latestBlock };
    }
  }
  throw new GraphQLError('Current chain checkpoint moved during its bounded read.', {
    extensions: { code: 'CHECKPOINT_VIEW_UNAVAILABLE' },
  });
};

type CheckpointView = Awaited<ReturnType<typeof captureCheckpointView>>;
const views = new WeakMap<CheckpointContext, Promise<CheckpointView>>();

/** One immutable read result per execution context, shared across field aliases. */
export const currentCheckpointView = (context: CheckpointContext): Promise<CheckpointView> => {
  let pending = views.get(context);
  if (!pending) {
    pending = captureCheckpointView(context);
    views.set(context, pending);
  }
  return pending;
};
