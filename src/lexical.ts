/** Deterministic, locale-independent string ordering used by every keyset engine. */
export const compareLexical = (left: string, right: string): number => {
  if (left === right) return 0;
  return left < right ? -1 : 1;
};
