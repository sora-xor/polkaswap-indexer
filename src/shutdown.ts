export type AsyncShutdownStep = () => void | Promise<void>;

/** Runs every cleanup step in order and rethrows the first failure afterward. */
export async function runShutdownSteps(steps: readonly AsyncShutdownStep[]): Promise<void> {
  let firstError: unknown;
  let failed = false;

  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      if (!failed) firstError = error;
      failed = true;
    }
  }

  if (failed) throw firstError;
}

/** Starts independent cleanup steps together and rethrows the first failure in declaration order. */
export async function runShutdownGroup(steps: readonly AsyncShutdownStep[]): Promise<void> {
  const results = await Promise.allSettled(steps.map((step) => Promise.resolve().then(step)));
  const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failure) throw failure.reason;
}

/** Coalesces concurrent shutdown requests onto one cleanup operation. */
export function idempotentShutdown(operation: AsyncShutdownStep): () => Promise<void> {
  let promise: Promise<void> | null = null;

  return () => {
    promise ??= Promise.resolve().then(operation);
    return promise;
  };
}
