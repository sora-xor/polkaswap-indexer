const JSON_NUMBER_PARTS = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/;
const JSON_NUMBER_DELIMITER = /^[\s,\]}]$/;
const MAX_EXPONENT_DIGITS = 9;
const MAX_RAW_EXPONENT_DIGITS = 16;
const MAX_JSON_NUMBER_TOKEN_LENGTH = 1_024;

type CanonicalDecimal = {
  negative: boolean;
  digits: string;
  exponent: number;
};

const invalidNumber = (token: string, context: string): never => {
  throw new Error(`${context} contains a JSON number that cannot be represented exactly by the indexer: ${token}`);
};

/**
 * Normalizes a JSON decimal without converting its coefficient to Number or
 * BigInt. This keeps validation linear and bounded even for PostgreSQL numeric
 * values with very large coefficients.
 */
const canonicalDecimal = (token: string, context: string): CanonicalDecimal => {
  const match = JSON_NUMBER_PARTS.exec(token);
  if (!match) return invalidNumber(token, context);

  const fraction = match[3] ?? '';
  const rawExponent = match[4] ?? '0';
  const rawExponentDigits = rawExponent.replace(/^[+-]/, '');
  if (rawExponentDigits.length > MAX_RAW_EXPONENT_DIGITS) return invalidNumber(token, context);
  const unsignedExponent = rawExponentDigits.replace(/^0+/, '') || '0';
  if (unsignedExponent.length > MAX_EXPONENT_DIGITS) return invalidNumber(token, context);
  const parsedExponent = Number(rawExponent);
  if (!Number.isSafeInteger(parsedExponent)) return invalidNumber(token, context);

  let digits = `${match[2]}${fraction}`.replace(/^0+/, '');
  if (digits === '') return { negative: false, digits: '0', exponent: 0 };

  let exponent = parsedExponent - fraction.length;
  if (!Number.isSafeInteger(exponent)) return invalidNumber(token, context);
  const trailingZeroes = /0+$/.exec(digits)?.[0].length ?? 0;
  if (trailingZeroes) {
    digits = digits.slice(0, -trailingZeroes);
    exponent += trailingZeroes;
  }
  if (!Number.isSafeInteger(exponent)) return invalidNumber(token, context);

  return { negative: match[1] === '-', digits, exponent };
};

const decimalsEqual = (left: CanonicalDecimal, right: CanonicalDecimal): boolean =>
  left.negative === right.negative && left.digits === right.digits && left.exponent === right.exponent;

// canonicalDecimal removes every coefficient trailing zero, so a remaining
// negative power of ten necessarily denotes a non-integer value.
const decimalIsInteger = ({ digits, exponent }: CanonicalDecimal): boolean => digits === '0' || exponent >= 0;

/**
 * Enforces the one numeric domain shared by JavaScript, PostgreSQL JSONB, and
 * RocksDB. Integer-valued JSON numbers must be safe JS integers. Fractional
 * values must equal the shortest decimal emitted by JSON.stringify(Number), so
 * arbitrary-precision JSONB values can never be silently rounded on export.
 */
export const assertExactlyRepresentableJsonNumber = (token: string, context = 'JSON'): void => {
  if (token.length > MAX_JSON_NUMBER_TOKEN_LENGTH) return invalidNumber(token.slice(0, 64), context);
  const source = canonicalDecimal(token, context);
  const parsed = Number(token);
  if (!Number.isFinite(parsed)) return invalidNumber(token, context);

  const shortest = JSON.stringify(parsed);
  if (typeof shortest !== 'string' || !decimalsEqual(source, canonicalDecimal(shortest, context))) {
    return invalidNumber(token, context);
  }
  if (decimalIsInteger(source) && !Number.isSafeInteger(parsed)) return invalidNumber(token, context);
};

const readJsonNumberToken = (json: string, start: number, context: string): { token: string; end: number } => {
  let cursor = start;
  const advance = (): void => {
    cursor += 1;
    if (cursor - start > MAX_JSON_NUMBER_TOKEN_LENGTH) {
      invalidNumber(`${json.slice(start, start + 64)}…`, context);
    }
  };
  const digit = (): boolean => json[cursor] !== undefined && json[cursor]! >= '0' && json[cursor]! <= '9';

  if (json[cursor] === '-') advance();
  if (json[cursor] === '0') {
    advance();
  } else {
    if (!digit() || json[cursor] === '0') {
      throw new Error(`${context} contains malformed JSON numeric syntax at offset ${start}`);
    }
    while (digit()) advance();
  }
  if (json[cursor] === '.') {
    advance();
    if (!digit()) throw new Error(`${context} contains malformed JSON numeric syntax at offset ${start}`);
    while (digit()) advance();
  }
  if (json[cursor] === 'e' || json[cursor] === 'E') {
    advance();
    if (json[cursor] === '+' || json[cursor] === '-') advance();
    if (!digit()) throw new Error(`${context} contains malformed JSON numeric syntax at offset ${start}`);
    while (digit()) advance();
  }
  if (cursor < json.length && !JSON_NUMBER_DELIMITER.test(json[cursor]!)) {
    throw new Error(`${context} contains malformed JSON numeric syntax at offset ${start}`);
  }
  return { token: json.slice(start, cursor), end: cursor };
};

/** Scans raw JSON while deliberately ignoring number-like text inside strings. */
export const assertExactlyRepresentableJsonNumbers = (json: string, context = 'JSON'): void => {
  if (typeof json !== 'string') throw new Error(`${context} must be raw JSON text`);

  let index = 0;
  while (index < json.length) {
    const character = json[index]!;
    if (character === '"') {
      index += 1;
      while (index < json.length) {
        const stringCharacter = json[index++]!;
        if (stringCharacter === '"') break;
        if (stringCharacter === '\\') index += 1;
      }
      continue;
    }

    if (character === '-' || (character >= '0' && character <= '9')) {
      const { token, end } = readJsonNumberToken(json, index, context);
      assertExactlyRepresentableJsonNumber(token, context);
      index = end;
      continue;
    }
    index += 1;
  }
};

export const parseExactJsonObject = (json: string, context = 'JSON'): Record<string, unknown> => {
  assertExactlyRepresentableJsonNumbers(json, context);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch (error) {
    throw new Error(`${context} is malformed JSON`, { cause: error });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${context} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
};
