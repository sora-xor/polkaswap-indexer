const ARRAY_OVERHEAD_BYTES = 32;
const OBJECT_OVERHEAD_BYTES = 64;
const MAP_ENTRY_OVERHEAD_BYTES = 32;
const PRIMITIVE_OVERHEAD_BYTES = 16;
const CODEC_HEAP_MULTIPLIER = 4;

type Frame =
  | { kind: 'array'; value: readonly unknown[]; index: number }
  | { kind: 'map'; iterator: Iterator<[unknown, unknown]>; pendingValue?: unknown }
  | { kind: 'set'; iterator: Iterator<unknown> }
  | { kind: 'object'; value: object; keys: string[]; index: number };

const addBounded = (current: number, amount: number, maximumBytes: number): number => {
  if (!Number.isFinite(amount) || amount < 0) return maximumBytes + 1;
  if (current > maximumBytes - amount) return maximumBytes + 1;
  return current + amount;
};

const stringBytes = (value: string): number =>
  Math.max(value.length * 2, Buffer.byteLength(value, 'utf8')) + PRIMITIVE_OVERHEAD_BYTES;

const externalByteLength = (value: object): number | null => {
  if (ArrayBuffer.isView(value)) return value.byteLength + OBJECT_OVERHEAD_BYTES;
  if (value instanceof ArrayBuffer) return value.byteLength + OBJECT_OVERHEAD_BYTES;

  // Polkadot codec instances expose their encoded size without allocating a
  // second encoded copy. Do not trust an `encodedLength` field on plain indexed
  // JSON documents as a size oracle.
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
  } catch {
    return OBJECT_OVERHEAD_BYTES;
  }
  if (prototype === Object.prototype || prototype === null) return null;

  try {
    const encodedLength = (value as { encodedLength?: unknown }).encodedLength;
    if (typeof encodedLength === 'number' && Number.isSafeInteger(encodedLength) && encodedLength >= 0) {
      return encodedLength * CODEC_HEAP_MULTIPLIER + OBJECT_OVERHEAD_BYTES;
    }
  } catch {
    return OBJECT_OVERHEAD_BYTES;
  }
  return null;
};

/**
 * Conservatively estimates retained heap bytes without serializing or cloning.
 * Traversal stops as soon as the configured budget is exceeded, so a rejected
 * cache/result cannot allocate or inspect a second full copy of hostile data.
 * The returned `maximumBytes + 1` is an intentional lower bound when capped.
 */
export const estimateRetainedValueBytes = (value: unknown, maximumBytes: number): number => {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new Error('Cache/result byte budget must be a non-negative safe integer');
  }

  const seen = new WeakSet<object>();
  const frames: Frame[] = [];
  let current: unknown = value;
  let hasCurrent = true;
  let bytes = 0;

  const add = (amount: number): boolean => {
    bytes = addBounded(bytes, amount, maximumBytes);
    return bytes <= maximumBytes;
  };

  const nextValue = (): boolean => {
    while (frames.length) {
      const frame = frames[frames.length - 1]!;
      if (frame.kind === 'array') {
        if (frame.index >= frame.value.length) {
          frames.pop();
          continue;
        }
        const index = frame.index++;
        try {
          current = frame.value[index];
        } catch {
          current = undefined;
        }
        return true;
      }
      if (frame.kind === 'map') {
        if (Object.prototype.hasOwnProperty.call(frame, 'pendingValue')) {
          current = frame.pendingValue;
          delete frame.pendingValue;
          return true;
        }
        const entry = frame.iterator.next();
        if (entry.done) {
          frames.pop();
          continue;
        }
        if (!add(MAP_ENTRY_OVERHEAD_BYTES)) return false;
        current = entry.value[0];
        frame.pendingValue = entry.value[1];
        return true;
      }
      if (frame.kind === 'set') {
        const entry = frame.iterator.next();
        if (entry.done) {
          frames.pop();
          continue;
        }
        if (!add(MAP_ENTRY_OVERHEAD_BYTES)) return false;
        current = entry.value;
        return true;
      }

      if (frame.index >= frame.keys.length) {
        frames.pop();
        continue;
      }
      const key = frame.keys[frame.index++]!;
      if (!add(stringBytes(key))) return false;
      try {
        current = (frame.value as Record<string, unknown>)[key];
      } catch {
        current = undefined;
      }
      return true;
    }
    return false;
  };

  while (hasCurrent) {
    if (current === null || current === undefined || typeof current === 'boolean') {
      if (!add(PRIMITIVE_OVERHEAD_BYTES)) break;
    } else if (typeof current === 'string') {
      if (!add(stringBytes(current))) break;
    } else if (typeof current === 'number' || typeof current === 'bigint') {
      if (!add(PRIMITIVE_OVERHEAD_BYTES)) break;
    } else if (typeof current === 'symbol' || typeof current === 'function') {
      if (!add(OBJECT_OVERHEAD_BYTES)) break;
    } else {
      const object = current as object;
      if (!seen.has(object)) {
        seen.add(object);
        const externalBytes = externalByteLength(object);
        if (externalBytes !== null) {
          if (!add(externalBytes)) break;
        } else if (Array.isArray(object)) {
          if (!add(ARRAY_OVERHEAD_BYTES + object.length * 8)) break;
          frames.push({ kind: 'array', value: object, index: 0 });
        } else if (object instanceof Map) {
          if (!add(OBJECT_OVERHEAD_BYTES)) break;
          frames.push({ kind: 'map', iterator: object.entries() });
        } else if (object instanceof Set) {
          if (!add(OBJECT_OVERHEAD_BYTES)) break;
          frames.push({ kind: 'set', iterator: object.values() });
        } else {
          let keys: string[];
          try {
            keys = Object.keys(object);
          } catch {
            keys = [];
          }
          if (!add(OBJECT_OVERHEAD_BYTES + keys.length * 8)) break;
          frames.push({ kind: 'object', value: object, keys, index: 0 });
        }
      }
    }

    hasCurrent = nextValue();
  }

  return bytes;
};
