import { GraphQLError } from 'graphql';
import { isDeepStrictEqual } from 'node:util';

import { decodeRepositoryCursor, MAX_REPOSITORY_CURSOR_LENGTH } from '../repository/cursor.js';
import { isNonzeroCanonicalSubstrateHash } from '../soraIdentity.js';
import type { StatsCoreGeneration } from '../stats-recovery.js';

const PREFIX = 'pscg1.';
const invalid = (message: string): never => { throw new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } }); };
const validGeneration = (value: StatsCoreGeneration): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.generation) &&
  Number.isSafeInteger(value.block) && value.block > 0 && isNonzeroCanonicalSubstrateHash(value.hash);

/** Bind one existing scoped repository cursor to the exact core reconciliation receipt. */
export function wrapStatsCoreCursor(cursor: string, generation: StatsCoreGeneration): string {
  if (!validGeneration(generation) || !decodeRepositoryCursor(cursor)) return invalid('Invalid stats core cursor inputs');
  const value = { v: 1, generation, cursor };
  const encoded = PREFIX + Buffer.from(JSON.stringify(value)).toString('base64url');
  if (encoded.length > MAX_REPOSITORY_CURSOR_LENGTH) return invalid('Stats core cursor exceeds its size bound');
  return encoded;
}

/** Later pages must remain in the captured generation; legacy/numeric/mixed cursors fail closed. */
export function unwrapStatsCoreCursor(cursor: unknown, generation: StatsCoreGeneration): string | null | undefined {
  if (cursor === null || cursor === undefined || cursor === '') return cursor as null | undefined | '';
  if (typeof cursor !== 'string' || cursor.length > MAX_REPOSITORY_CURSOR_LENGTH || !cursor.startsWith(PREFIX)) {
    return invalid('Stats core pagination requires a generation-bound cursor');
  }
  let value: { v: unknown; generation: StatsCoreGeneration; cursor: unknown };
  try {
    const encoded = cursor.slice(PREFIX.length), raw = Buffer.from(encoded, 'base64url');
    if (!/^[A-Za-z0-9_-]+$/.test(encoded) || raw.toString('base64url') !== encoded) throw new Error('encoding');
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    if (!value || Object.keys(value).sort().join(',') !== 'cursor,generation,v' || value.v !== 1 ||
      !value.generation || Object.keys(value.generation).sort().join(',') !== 'block,generation,hash' ||
      !validGeneration(value.generation) || !raw.equals(Buffer.from(JSON.stringify(value))) ||
      !decodeRepositoryCursor(value.cursor)) throw new Error('payload');
  } catch { return invalid('Invalid stats core pagination cursor'); }
  if (!isDeepStrictEqual(value.generation, generation)) return invalid('Stats core generation changed; restart pagination');
  return value.cursor as string;
}
