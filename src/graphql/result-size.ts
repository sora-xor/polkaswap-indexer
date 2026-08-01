import { GraphQLError } from 'graphql';

import type { ExecutionResult } from 'graphql';

export const GRAPHQL_RESULT_TOO_LARGE_CODE = 'GRAPHQL_RESULT_TOO_LARGE';
export const GRAPHQL_RESULT_NOT_SERIALIZABLE_CODE = 'GRAPHQL_RESULT_NOT_SERIALIZABLE';

type JsonFrame =
  | { kind: 'array'; value: readonly unknown[]; index: number; length: number }
  | { kind: 'object'; value: object; keys: string[]; index: number; wroteProperty: boolean };

type PreparedJsonValue =
  | { kind: 'omit' }
  | { kind: 'null' }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'object'; value: object };

const escapedJsonStringBytes = (value: string, maximumBytes: number): number => {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    let added: number;
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
      added = 2;
    } else if (code <= 0x1f || (code >= 0xd800 && code <= 0xdfff && !(code <= 0xdbff && index + 1 < value.length && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff))) {
      added = 6;
    } else if (code <= 0x7f) {
      added = 1;
    } else if (code <= 0x7ff) {
      added = 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      added = 4;
      index += 1;
    } else {
      added = 3;
    }
    if (bytes > maximumBytes - added) return maximumBytes + 1;
    bytes += added;
  }
  return bytes;
};

const prepareJsonValue = (input: unknown, key: string): PreparedJsonValue => {
  let value = input;
  if ((typeof value === 'object' && value !== null) || typeof value === 'bigint') {
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === 'function') value = toJSON.call(value, key);
  }

  if (value === null) return { kind: 'null' };
  if (typeof value === 'string') return { kind: 'string', value };
  if (typeof value === 'boolean') return { kind: 'boolean', value };
  if (typeof value === 'number') return { kind: 'number', value };
  if (typeof value === 'bigint') throw new TypeError('BigInt cannot be serialized as JSON');
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return { kind: 'omit' };

  if (value instanceof String) return { kind: 'string', value: value.valueOf() };
  if (value instanceof Number) return { kind: 'number', value: value.valueOf() };
  if (value instanceof Boolean) return { kind: 'boolean', value: value.valueOf() };
  if (Object.getPrototypeOf(value) === BigInt.prototype) {
    throw new TypeError('BigInt cannot be serialized as JSON');
  }
  return { kind: 'object', value: value as object };
};

/**
 * Counts the exact UTF-8 bytes produced by JSON.stringify without building the
 * encoded string. The iterative traversal fails on cycles and exits as soon as
 * the caller's byte limit is crossed.
 */
export const measureJsonUtf8Bytes = (value: unknown, maximumBytes: number): number => {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new Error('GraphQL result byte budget must be a non-negative safe integer');
  }

  const active = new WeakSet<object>();
  const frames: JsonFrame[] = [];
  let bytes = 0;

  const add = (amount: number): boolean => {
    if (!Number.isFinite(amount) || amount < 0 || bytes > maximumBytes - amount) {
      bytes = maximumBytes + 1;
      return false;
    }
    bytes += amount;
    return true;
  };

  const write = (prepared: PreparedJsonValue): boolean => {
    if (prepared.kind === 'omit') return false;
    if (prepared.kind === 'null') return add(4);
    if (prepared.kind === 'boolean') return add(prepared.value ? 4 : 5);
    if (prepared.kind === 'number') {
      return add(Number.isFinite(prepared.value) ? String(prepared.value).length : 4);
    }
    if (prepared.kind === 'string') {
      return add(escapedJsonStringBytes(prepared.value, maximumBytes - bytes));
    }

    const object = prepared.value;
    if (active.has(object)) throw new TypeError('Converting circular structure to JSON');
    active.add(object);
    if (Array.isArray(object)) {
      if (!add(1)) return true;
      frames.push({ kind: 'array', value: object, index: 0, length: object.length });
    } else {
      if (!add(1)) return true;
      frames.push({ kind: 'object', value: object, keys: Object.keys(object), index: 0, wroteProperty: false });
    }
    return true;
  };

  const root = prepareJsonValue(value, '');
  if (root.kind === 'omit') throw new TypeError('GraphQL result cannot be omitted from JSON');
  write(root);

  while (bytes <= maximumBytes && frames.length) {
    const frame = frames[frames.length - 1]!;
    if (frame.kind === 'array') {
      if (frame.index >= frame.length) {
        frames.pop();
        active.delete(frame.value);
        add(1);
        continue;
      }
      if (frame.index > 0 && !add(1)) break;
      const index = frame.index++;
      const prepared = prepareJsonValue(frame.value[index], String(index));
      write(prepared.kind === 'omit' ? { kind: 'null' } : prepared);
      continue;
    }

    let wroteValue = false;
    while (frame.index < frame.keys.length && !wroteValue) {
      const key = frame.keys[frame.index++]!;
      const prepared = prepareJsonValue((frame.value as Record<string, unknown>)[key], key);
      if (prepared.kind === 'omit') continue;
      if (frame.wroteProperty && !add(1)) break;
      if (!add(escapedJsonStringBytes(key, maximumBytes - bytes)) || !add(1)) break;
      frame.wroteProperty = true;
      write(prepared);
      wroteValue = true;
    }
    if (bytes > maximumBytes) break;
    if (!wroteValue && frame.index >= frame.keys.length) {
      frames.pop();
      active.delete(frame.value);
      add(1);
    }
  }

  return bytes;
};

const errorResult = (message: string, code: string): ExecutionResult => ({
  errors: [new GraphQLError(message, { extensions: { code } })],
});

export const boundGraphQLExecutionResult = (
  result: ExecutionResult,
  maximumBytes: number
): ExecutionResult => {
  try {
    return measureJsonUtf8Bytes(result, maximumBytes) > maximumBytes
      ? errorResult(
          `GraphQL result exceeds the configured ${maximumBytes}-byte response budget.`,
          GRAPHQL_RESULT_TOO_LARGE_CODE
        )
      : result;
  } catch {
    return errorResult(
      'GraphQL result could not be serialized safely.',
      GRAPHQL_RESULT_NOT_SERIALIZABLE_CODE
    );
  }
};

export const boundGraphQLExecutionResults = async function* (
  source: AsyncIterable<ExecutionResult>,
  maximumBytes: number
): AsyncIterable<ExecutionResult> {
  for await (const result of source) yield boundGraphQLExecutionResult(result, maximumBytes);
};
