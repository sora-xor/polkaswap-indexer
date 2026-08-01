import { ApiPromise, WsProvider } from '@polkadot/api';

import {
  isNonzeroCanonicalSubstrateHash,
  SORA_LEGACY_IDENTITY_ANCHOR,
  SORA_MAINNET_GENESIS_HASH,
} from '../soraIdentity.js';

const PREFLIGHT_TIMEOUT_MS = 15_000;
const PREFLIGHT_DISCONNECT_TIMEOUT_MS = 2_000;

const withTimeout = async <T>(promise: Promise<T>, label: string, timeoutMs = PREFLIGHT_TIMEOUT_MS): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const disconnect = async (endpoint: unknown): Promise<void> => {
  const close = (endpoint as { disconnect?: () => unknown } | null)?.disconnect;
  if (typeof close === 'function') {
    await withTimeout(
      Promise.resolve(close.call(endpoint)),
      'SORA identity preflight disconnect',
      PREFLIGHT_DISCONNECT_TIMEOUT_MS,
    );
  }
};

/**
 * Proves the configured endpoint is the reviewed SORA mainnet before the
 * worker constructs, migrates, reads, or writes its production database.
 */
export async function preflightSoraMainnetIdentity(
  endpoint: string,
  { requireAnchorTimestamp = false }: { requireAnchorTimestamp?: boolean } = {},
): Promise<void> {
  const provider = new WsProvider(endpoint);
  let api: ApiPromise | null = null;
  let acceptingConnection = true;
  try {
    const creation = ApiPromise.create({ provider }).then(async (created) => {
      if (!acceptingConnection) {
        await disconnect(created);
        throw new Error('SORA identity preflight connection completed after its deadline');
      }
      return created;
    });
    api = await withTimeout(creation, 'SORA identity preflight connection');
    const genesis = await withTimeout(api.rpc.chain.getBlockHash(0), 'SORA identity preflight chain.getBlockHash(0)');
    const observed = genesis?.toString?.().toLowerCase() ?? '';
    if (!isNonzeroCanonicalSubstrateHash(observed)) {
      throw new Error('SORA identity preflight returned a missing, zero, or malformed genesis hash');
    }
    if (observed !== SORA_MAINNET_GENESIS_HASH) {
      throw new Error('SORA identity preflight does not match the reviewed SORA mainnet genesis hash');
    }
    const anchor = await withTimeout(
      api.rpc.chain.getBlockHash(SORA_LEGACY_IDENTITY_ANCHOR.block),
      `SORA identity preflight chain.getBlockHash(${SORA_LEGACY_IDENTITY_ANCHOR.block})`,
    );
    if ((anchor?.toString?.().toLowerCase() ?? '') !== SORA_LEGACY_IDENTITY_ANCHOR.hash) {
      throw new Error('SORA identity preflight does not contain the reviewed SORA mainnet history anchor');
    }
    if (requireAnchorTimestamp) {
      const timestampNow = (api.query as unknown as
        { timestamp?: { now?: { at?: (hash: string) => Promise<unknown> } } } | undefined)
        ?.timestamp?.now;
      if (typeof timestampNow?.at !== 'function') {
        throw new Error('SORA identity preflight cannot verify the reviewed mainnet anchor timestamp');
      }
      const timestampCodec = await withTimeout(
        timestampNow.at(SORA_LEGACY_IDENTITY_ANCHOR.hash),
        'SORA identity preflight timestamp.now.at(anchor)',
      );
      const timestampText = String((timestampCodec as { toString?: () => string } | null)?.toString?.() ?? timestampCodec);
      if (!/^(0|[1-9][0-9]*)$/.test(timestampText) ||
          Number(timestampText) !== SORA_LEGACY_IDENTITY_ANCHOR.timestamp * 1000) {
        throw new Error('SORA identity preflight does not contain the reviewed SORA mainnet history anchor timestamp');
      }
    }
  } finally {
    acceptingConnection = false;
    await Promise.allSettled([disconnect(api), disconnect(provider)]);
  }
}
