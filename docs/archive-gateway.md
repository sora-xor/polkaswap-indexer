# Canonical historical RPC gateway

The approved MOF2 OVH host serves historical reads at
`https://mof2.sora.org/archive` and `wss://mof2.sora.org/archive`. The existing
root RPC remains the recovery node. No frontend publication is needed.

The retained 657 GiB database is opened by the old 4.8.6 binary in its original
`archive-canonical` state/block pruning mode. A dedicated systemd network
namespace prevents it from contacting any peers. Its separate node key is a
raw 32-byte networking key, with no validator keystore. Preserve this database;
do not enable its former public service or change its pruning mode.

The routing boundary is shared block 28,191,817,
`0x7f7c253fa72f32e7b03f32bdc9ae456fd7174fb131b689be6d876006124129f0`.
Explicit historical hashes must match the retained canonical height mapping.
Later hashes must match the recovery node's canonical height mapping. An
available abandoned-fork header is insufficient for admission.

Current/default reads, heads, finality and subscriptions always use the recovery
node. Stored state through the shared checkpoint uses the archive. Runtime API
calls, metadata and runtime version **at the checkpoint** use the recovery node,
because its code substitute executes the first child. To decode a block's
events/extrinsics, use the executing parent's metadata; do not cache metadata
across the fork by spec version 134, which both runtimes reuse.

Startup and 30-second rechecks pin both genesis/checkpoint identities plus the
recovery node's first child hash
`0x15f8dc66c3be19d8de14acfe2558209a9140bc94c64aaf00b36507020f6aae75`
and its parent. This branch pin is **not a finality assertion**. A changed first
child fails closed and requires independent branch review. A failed recheck
closes clients and exits; systemd can restart only after identity succeeds.
The worker separately retains its finalized recovery-policy admission.

Only an explicit read-method allowlist is exposed. Writes, cross-block range
queries and unknown methods are rejected. HTTP supports batches of at most 16;
WebSocket subscriptions are forwarded only to the recovery node. Requests are
limited to 256 KiB, upstream responses to 32 MiB and calls to 30 seconds. The
gateway binds only to host loopback, behind the existing TLS reverse proxy.

## Services and paths

- `sora-retained-archive.service`: old database, private namespace, RPC port 9946.
- `sora-retained-archive-rpc.socket`: host **loopback-only** port 9947.
- `sora-retained-archive-rpc.service`: systemd socket proxy joining the archive
  namespace. The gateway sends native Host `127.0.0.1:9946`, preserving the old
  node's Host allowlist across the port bridge.
- `sora-archive-gateway.service`: host loopback port 9948, network access limited
  to localhost, dynamic user and read-only system filesystem.
- Current release:
  `/opt/sora-retained-archive-gateway/releases/20261031-v3`.
- Retained archive:
  `/root/sora2-network-4.8.6/db/chains/sora-substrate-main-net/db`.
- Separate archive node key and empty keystore:
  `/var/lib/sora-retained-archive/`.
- Nginx: the exact `/archive` location in `/etc/nginx/nginx.conf`; previous
  configuration retained as `nginx.conf.before-archive-20261031`.

On 1 November at 00:03 JST, only the retained archive's memory ceiling was
raised from 4 GiB to 12 GiB with `systemctl set-property`. At 4 GiB it had
recorded 182,550 memory-limit hits and about 47.6 million reclaimed pages;
the host had more than 64 GiB available. The PID and restart count did not
change. CPU quota, private networking, database path, gateway and recovery node
were unchanged. The receipt is
`/var/lib/sora-retained-archive/memory-budget-20261101.json`; rollback is
`systemctl set-property sora-retained-archive.service MemoryMax=4G`.
The six-height public historical/boundary checks passed again afterward,
including rejection of abandoned-fork state and transaction submission.

The gateway is a small standalone assembly from `src/archive-router.ts`,
`src/archive-gateway.ts`, `src/scripts/serve-archive-gateway.ts` and the existing
`ws` dependency. It was exercised on MOF2's installed Node 22.22.1; the full
indexer retains its Node 24+ requirement. No dependency installation or node
upgrade was performed on MOF2. Gateway v3 archive SHA-256:
`7b69de72f76b12dc0f668306a836d2f7eb5352ed9a0fe1699da134c8f335993c`.

## Validation and recovery

Thirteen focused router/transport tests passed, including swapped upstreams,
noncanonical hashes, metadata at the boundary, HTTP/WS transport, live-only
subscriptions and native Host forwarding. TypeScript compilation passed.
Public checks read blocks, timestamps, events and metadata at six historical
and recovery heights, rejected abandoned-fork state and transaction submission,
and retained the recovery node's actual finalized head. Pi's deployed identity
preflight and a real `ApiPromise` connection passed against the new endpoint.

The full indexer suite retained 16 baseline burn-boundary failures and had four
timeouts in two unrelated suites. Those two suites passed all 33 tests when
rerun alone. The full suite is not represented as passing.

Evidence is retained in the adjacent frontend checkout under
`output/ops/archive-recovery-20261031/`, including source deployment bundles,
systemd installation scripts, nginx before/after hashes, public checks and Pi
connection receipts. The temporary startup error from a hex-encoded networking
key was corrected to the required raw 32-byte format before publication; the
archive then ran with zero peers and no restarts.

To roll back the gateway, remove only its `/archive` nginx location after checking
for intervening configuration edits, validate nginx and reload, then stop its
gateway/socket/archive units. Do not replace the entire current nginx file with
an old backup, restart the former public archive node, stop the recovery node,
or delete either database. The unmodified root RPC remains available throughout.

Archive availability does not by itself restore the indexer. See
`post-fork-recovery-20261031.md` and `claude-recovery-coordination-20261031.md`
for finality, metadata, materialized-state reconciliation and rebuild constraints.
