import { GraphQLError } from 'graphql';

import { estimateRetainedValueBytes } from '../cache-weight.js';

import type { IndexerRepository, RepositoryQueryArgs } from '../repository/types.js';

const materializationLimitError = (maximumBytes: number): GraphQLError =>
  new GraphQLError(
    `GraphQL operation exceeds its ${maximumBytes} byte repository materialization budget.`,
    { extensions: { code: 'GRAPHQL_EXECUTION_MEMORY_LIMIT_EXCEEDED' } }
  );

/**
 * Aggregate retained-document budget shared by every resolver in one GraphQL
 * execution. Reads are serialized so parallel aliases cannot each observe and
 * spend the same remaining allowance.
 */
export class GraphQLMaterializationBudget {
  #remainingBytes: number;
  #tail = Promise.resolve();

  constructor(readonly maximumBytes: number) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
      throw new Error('GraphQL materialization budget must be a positive safe integer');
    }
    this.#remainingBytes = maximumBytes;
  }

  get remainingBytes(): number {
    return this.#remainingBytes;
  }

  get usedBytes(): number {
    return this.maximumBytes - this.#remainingBytes;
  }

  materialize<T>(load: (remainingBytes: number) => Promise<T>): Promise<T> {
    const result = this.#tail.then(async () => {
      const remainingBytes = this.#remainingBytes;
      if (remainingBytes <= 0) throw materializationLimitError(this.maximumBytes);

      const value = await load(remainingBytes);
      const retainedBytes = estimateRetainedValueBytes(value, remainingBytes);
      if (retainedBytes > remainingBytes) {
        // Repository pages intentionally retain their first matching document
        // even when that one document exceeds maxBytes, so cursor pagination
        // can make progress. Charge the full remaining operation allowance and
        // reject every later materializing resolver; this preserves that
        // single-document behavior without allowing alias multiplication.
        this.#remainingBytes = 0;
        return value;
      }
      this.#remainingBytes -= retainedBytes;
      return value;
    });
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

const clampQueryBytes = (args: RepositoryQueryArgs, remainingBytes: number): number | null => {
  const requested = args.maxBytes;
  if (requested === null || requested === undefined) return remainingBytes;
  if (!Number.isSafeInteger(requested) || requested <= 0) return requested;
  return Math.min(requested, remainingBytes);
};

export type BudgetedRepository = {
  repository: IndexerRepository;
  budget: GraphQLMaterializationBudget;
};

/** Wraps materializing reads while preserving the repository's optional API. */
export const createMaterializationBudgetedRepository = (
  repository: IndexerRepository,
  maximumBytes: number
): BudgetedRepository => {
  const budget = new GraphQLMaterializationBudget(maximumBytes);
  const bounded: IndexerRepository = {
    list: (collection) => budget.materialize(() => repository.list(collection)),
    get: (collection, id) => budget.materialize(() => repository.get(collection, id)),
    getMany: (collection, ids) => budget.materialize(() => repository.getMany(collection, ids)),
    upsert: (document) => repository.upsert(document),
    upsertMany: (documents) => repository.upsertMany(documents),
    deleteMany: (collection, ids) => repository.deleteMany(collection, ids),
    close: () => repository.close(),
  };

  if (repository.query) {
    bounded.query = (collection, args) =>
      budget.materialize((remainingBytes) =>
        repository.query!(collection, {
          ...args,
          maxBytes: clampQueryBytes(args, remainingBytes),
        })
      );
  }
  if (repository.watch) {
    // Source-event waiting is governed separately from one emitted GraphQL
    // execution; charging a lifetime stream here would exhaust idle/persistent
    // subscriptions instead of bounding a single result.
    bounded.watch = (collection, ids, signal) => repository.watch!(collection, ids, signal);
  }
  if (repository.prepare) bounded.prepare = () => repository.prepare!();
  if (repository.metricsSnapshot) bounded.metricsSnapshot = () => repository.metricsSnapshot!();
  if (repository.healthCheck) bounded.healthCheck = () => repository.healthCheck!();

  return { repository: bounded, budget };
};
