import { SORA_MAINNET_GENESIS_HASH, isNonzeroCanonicalSubstrateHash } from '../soraIdentity.js';

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

/** Exact storage key introduced by the historical denomination pallet. */
export const HISTORICAL_DENOMINATOR_KEY = '0x349246788a5a1a2b4c7f5025f3620fdf88fbfb377e1c57a4a58beac21d5b56d6';

/** Evidence from the same verified historical api.at context, never the head registry. */
export type PreDenominationEvidence = {
  genesisHash: string;
  block: number;
  blockHash: string;
  specName: string;
  specVersion: number;
  palletNames: readonly string[];
  rawDenominator: unknown;
};

/**
 * Original SORA Nexus units predate the denomination pallet (source 93cf5ca2f).
 * That pallet introduced a unit default; the first denomination is block
 * 21,063,093. Admit one only for an identified earlier mainnet runtime whose
 * pinned metadata lacks the pallet AND whose exact raw denominator key is absent.
 * A missing callable on a later/present pallet, pruned state or unknown context
 * is not evidence of original units. See docs/bot-history.md for source pins.
 */
export function preDenominationSnapshotFactor(evidence: PreDenominationEvidence): '1' | null {
  if (evidence.genesisHash !== SORA_MAINNET_GENESIS_HASH ||
      !Number.isSafeInteger(evidence.block) || evidence.block < 0 || evidence.block > 21_063_092 ||
      !isNonzeroCanonicalSubstrateHash(evidence.blockHash) ||
      evidence.specName !== 'sora-substrate' || !Number.isSafeInteger(evidence.specVersion) ||
      evidence.specVersion < 1 || evidence.specVersion > 113 ||
      !Array.isArray(evidence.palletNames) || evidence.palletNames.length > 1024 ||
      !evidence.palletNames.every((name) => typeof name === 'string' && name.length > 0) ||
      evidence.rawDenominator !== null) return null;
  const pallets = new Set(evidence.palletNames.map((name) => name.toLowerCase()));
  return pallets.has('system') && pallets.has('timestamp') && pallets.has('assets') &&
    !pallets.has('denomination') ? '1' : null;
}
