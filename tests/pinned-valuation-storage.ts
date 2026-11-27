import { vi } from 'vitest';

type FixtureAsset = { id: string; symbol: string; name?: string; decimals: number };
type FixturePool = { baseAssetId: string; targetAssetId: string; baseAssetReserves: bigint; targetAssetReserves: bigint };

/**
 * Paged `assets.assetInfosV2` and `poolXYK.reserves` storage for a pinned historical query,
 * read from the fixture state when the worker scans it (hourly closes read their own state).
 */
export function pinnedValuationStorage(state: () => { assets: ReadonlyMap<string, FixtureAsset>; pools: ReadonlyMap<string, FixturePool> }) {
  return {
    assets: {
      assetInfosV2: {
        entriesPaged: vi.fn(async () => [...state().assets.values()].map((asset) => [
          { args: [asset.id] },
          { toHuman: () => ({ symbol: asset.symbol, name: asset.name ?? asset.symbol, precision: asset.decimals }) },
        ])),
      },
    },
    poolXYK: {
      reserves: {
        entriesPaged: vi.fn(async () => [...state().pools.values()].map((pool) => [
          { args: [pool.baseAssetId, pool.targetAssetId] },
          [pool.baseAssetReserves.toString(), pool.targetAssetReserves.toString()],
        ])),
      },
    },
  };
}
