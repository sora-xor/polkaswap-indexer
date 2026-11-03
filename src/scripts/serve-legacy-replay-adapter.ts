/**
 * Local-only bounded pre-fork replay endpoint for a replay worker on this machine. It serves
 * canonical shared history through block 28,191,816 and nothing later. Bound to loopback.
 *
 * LEGACY_REPLAY_ARCHIVE_URL  historical reads (default https://mof2.sora.org/archive)
 * LEGACY_REPLAY_RECOVERY_URL finality and block-identity cross-check (default https://mof2.sora.org)
 * LEGACY_REPLAY_PORT         loopback port (default 9955)
 */
import { createLegacyReplayServer, jsonRpcClient, LEGACY_REPLAY_CAP, LegacyReplayAdapter } from '../legacy-replay-adapter.js';

const port = Number(process.env.LEGACY_REPLAY_PORT ?? 9955);
if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) throw new Error('LEGACY_REPLAY_PORT must be a TCP port');
const adapter = new LegacyReplayAdapter(
  jsonRpcClient(process.env.LEGACY_REPLAY_ARCHIVE_URL ?? 'https://mof2.sora.org/archive'),
  jsonRpcClient(process.env.LEGACY_REPLAY_RECOVERY_URL ?? 'https://mof2.sora.org'),
);
await adapter.verify();
const replay = createLegacyReplayServer(adapter);
replay.server.listen(port, '127.0.0.1', () => {
  console.log(`pre-fork replay through block ${LEGACY_REPLAY_CAP.height} on ws://127.0.0.1:${port}`);
});
const timer = setInterval(() => { void adapter.verify().catch(() => {
  console.error('Pre-fork replay identity check failed; closing clients');
  clearInterval(timer);
  void replay.close().then(() => process.exit(1), () => process.exit(1));
}); }, 30_000);
