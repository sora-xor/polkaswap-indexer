interface DenominationQuery {
  denomination?: { denominator?: () => Promise<{ toString(): string }> };
}

/**
 * Read the cumulative denomination from the same immutable query context as a
 * price snapshot. Missing/pruned storage remains unknown; never infer a unit
 * coefficient or attach the current coefficient to an older close price.
 */
export async function readSnapshotDenominator(query: DenominationQuery): Promise<string | null> {
  try {
    if (typeof query.denomination?.denominator !== 'function') return null;
    const value = (await query.denomination.denominator()).toString();
    return /^[1-9]\d{0,119}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}
