import { WsProvider } from '@polkadot/api';
import { isDiscardedTimestampState } from './historicalTimestamp.js';

import {
  isNonzeroCanonicalSubstrateHash,
  SORA_LEGACY_IDENTITY_ANCHOR,
  SORA_MAINNET_GENESIS_HASH,
} from '../soraIdentity.js';

const PREFLIGHT_TIMEOUT_MS = 15_000;
const PREFLIGHT_DISCONNECT_TIMEOUT_MS = 2_000;
// Twox128("Timestamp") ++ Twox128("Now") at the fixed, reviewed history anchor.
const ANCHOR_TIMESTAMP_STORAGE_KEY =
  '0xf0c365c3cf59d671eb72da0e7a4113c49f1f0515f462cdcf84e0f1d6045dfcbb';

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
 *
 * The pinned anchor uses Timestamp.Now's eight-byte SCALE u64 milliseconds.
 * Reading that exact key at that exact hash preserves the decorated query's
 * node-response trust boundary without downloading unrelated runtime metadata.
 * This is a fixed-anchor identity check, not a decoder for arbitrary runtimes
 * or a cryptographic storage proof; normal indexing still uses runtime metadata.
 */
export async function preflightSoraMainnetIdentity(
  endpoint: string,
  { requireAnchorTimestamp = false, historicalEndpoint }: {
    requireAnchorTimestamp?: boolean;
    historicalEndpoint?: string;
  } = {},
): Promise<void> {
  const provider = new WsProvider(endpoint, false, {}, PREFLIGHT_TIMEOUT_MS);
  let acceptingConnection = true;
  let rejectTransport!: (error: Error) => void;
  const transportFailure = new Promise<never>((_resolve, reject) => {
    rejectTransport = reject;
  });
  const offError = provider.on('error', (error: unknown) => {
    rejectTransport(error instanceof Error ? error : new Error('SORA identity preflight websocket error'));
  });
  const offDisconnected = provider.on('disconnected', () => {
    rejectTransport(new Error('SORA identity preflight websocket disconnected'));
  });
  const query = (method: string, parameters: unknown[], label: string): Promise<unknown> =>
    withTimeout(Promise.race([provider.send<unknown>(method, parameters, false), transportFailure]), label);
  try {
    // connect() starts the handshake; isReady resolves only once the socket opens.
    const creation = provider.connect().then(() => provider.isReady).then(async () => {
      if (!acceptingConnection) {
        await disconnect(provider);
        throw new Error('SORA identity preflight connection completed after its deadline');
      }
    });
    await withTimeout(Promise.race([creation, transportFailure]), 'SORA identity preflight connection');
    const genesis = await query('chain_getBlockHash', [0], 'SORA identity preflight chain.getBlockHash(0)');
    const observed = typeof genesis === 'string' ? genesis.toLowerCase() : '';
    if (!isNonzeroCanonicalSubstrateHash(observed)) {
      throw new Error('SORA identity preflight returned a missing, zero, or malformed genesis hash');
    }
    if (observed !== SORA_MAINNET_GENESIS_HASH) {
      throw new Error('SORA identity preflight does not match the reviewed SORA mainnet genesis hash');
    }
    const anchor = await query(
      'chain_getBlockHash', [SORA_LEGACY_IDENTITY_ANCHOR.block],
      `SORA identity preflight chain.getBlockHash(${SORA_LEGACY_IDENTITY_ANCHOR.block})`,
    );
    if ((typeof anchor === 'string' ? anchor.toLowerCase() : '') !== SORA_LEGACY_IDENTITY_ANCHOR.hash) {
      throw new Error('SORA identity preflight does not contain the reviewed SORA mainnet history anchor');
    }
    if (requireAnchorTimestamp) {
      let timestampStorage: unknown;
      try {
        timestampStorage = await query(
          'state_getStorage', [ANCHOR_TIMESTAMP_STORAGE_KEY, SORA_LEGACY_IDENTITY_ANCHOR.hash],
          'SORA identity preflight state_getStorage(Timestamp.Now at anchor)',
        );
      } catch (error) {
        if (!isDiscardedTimestampState(error) || !historicalEndpoint || historicalEndpoint === endpoint) throw error;
        // The primary already proved the canonical hash. Independently prove
        // the archive's genesis, same anchor hash, and exact audited timestamp.
        await preflightSoraMainnetIdentity(historicalEndpoint, { requireAnchorTimestamp: true });
        return;
      }
      if (typeof timestampStorage !== 'string' || !/^0x[0-9a-fA-F]{16}$/.test(timestampStorage) ||
          Buffer.from(timestampStorage.slice(2), 'hex').readBigUInt64LE() !==
            BigInt(SORA_LEGACY_IDENTITY_ANCHOR.timestamp) * 1000n) {
        throw new Error('SORA identity preflight does not contain the reviewed SORA mainnet history anchor timestamp');
      }
    }
  } finally {
    acceptingConnection = false;
    offError();
    offDisconnected();
    await Promise.allSettled([disconnect(provider)]);
  }
}
