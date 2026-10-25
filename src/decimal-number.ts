/** Expands only a finite Number's own decimal representation, without rounding it. */
export const finiteNumberToPlainDecimal = (value: unknown): string | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;

  const text = String(value);
  const exponentIndex = text.indexOf('e');
  if (exponentIndex < 0) return text;

  const mantissa = text.slice(0, exponentIndex);
  const sign = mantissa.startsWith('-') ? '-' : '';
  const [integer, fraction = ''] = (sign ? mantissa.slice(1) : mantissa).split('.');
  const digits = integer! + fraction;
  // Number's IEEE-double exponent bounds this expansion to a few hundred characters.
  const point = integer!.length + Number(text.slice(exponentIndex + 1));
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return sign + digits + '0'.repeat(point - digits.length);
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
};
