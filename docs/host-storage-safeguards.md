# Pi host storage safeguards

The approved MOF host is `207.254.29.218`. The controls introduced on October 17,
2026 protect the Pi GraphQL service and its existing RocksDB history. They do
not change snapshot retention, chain endpoints, public routing, or database
contents.

## Installed controls

- `/Library/PolkaswapStorage/host-storage-guard.py` runs through the root
  LaunchDaemon `org.polkaswap.storage-guard` at startup and every 300 seconds.
- Root-owned `/Library/PolkaswapStorage/config.json` declares protected paths,
  active environment files, explicit retired artifacts, and capacity thresholds.
- The monitor warns at 150 GiB free, becomes urgent at 75 GiB, and warns when
  measured growth predicts exhaustion within seven days. Forecasts require at
  least one day of observations. It measures filesystem-available bytes; it does
  not add directory sizes that can double-count shared RocksDB files.
- Private state is bounded to seven days of samples and 200 recent events under
  `/Library/PolkaswapStorage/state`. A read-only, nonsecret summary is published
  at `/Library/PolkaswapStorage/status.json`.
- The guard records alerts through macOS `logger` on severity changes, delivery
  failures, cleanup failures, or a daily reminder for an unresolved alert.
  The paired monitor checks this status and public API health every
  15 minutes and emails `takemiya@soramitsu.co.jp` through the connected Gmail
  account on new problems, worsening, recovery, and at most one daily reminder.
  Host checks continue independently; email delivery needs the local Codex
  scheduler to run. Delivery failures are reported in the chat. Treat an
  unreadable status or a timestamp older than 15 minutes as a monitoring failure,
  never as healthy.

## Cleanup boundaries

Cleanup is an explicit allowlist, not an age-based search across databases.
The initial seven old transport tarballs were removed with their extracted
releases/tools retained. Their missing manifest entries remain harmless and
are skipped, including if an old parent directory is later removed.
All discovered databases, repair checkpoints, native backups,
source receipts, chain databases, and the IPFS repository remain protected.
The original database/checkpoint cleanup from October 16 is not repeated.

Each retired entry records an exact absolute path, UTC expiry, filesystem device,
inode, and SHA-256 for files. The monitor re-reads `ROCKSDB_PATH` literally from
both deployed environment files on every pass. It never sources an environment
file, follows a symlink, or removes an ancestor/descendant of protected data.
Open handles, changed identities, missing protection data, and validation errors
refuse deletion. At most five approved artifacts are removed per pass.
Directory and special-file deletion are disabled; there is no directory opt-in.
Every existing eligible file must be a direct child of the root-owned private
intake directory configured by `retirement_root`, defaulting to
`/Library/PolkaswapStorage/retired`. The intake must deny all group/other access;
every ancestor must be root-owned and not group/world writable. The file must
also be root-owned, not group/world writable, and have exactly one hard link.
These permissions prevent other service users from replacing an approved file
between its final identity check and descriptor-relative unlink.

To retire another artifact, first establish that it is obsolete, unopened, and
not required for rollback. Verify that its replacement and required backup are
retained. Prepare the intake as root-owned mode `0700`; on macOS clear any
inherited ACLs when provisioning it. Move the qualified regular file into this
directory on the same filesystem, set its owner/group to `root:wheel` and mode
`0600`, and remove any inherited ACLs from the file. Do not use hard links.
If copying across filesystems is necessary, first budget the additional copy
through the maintenance preflight and verify the completed copy before removing
the original through a separate approved operation.

After staging and changing ownership, capture the intake file's final absolute
path, device, inode, and SHA-256. Add those values and a future UTC expiry to the
root-owned manifest, then inspect a dry run. Fingerprints from the original
location are insufficient after copying. Never register an active database or
required recovery backup as a cleanup target. A protected path must not be
removed from the protection list just to make cleanup succeed. Missing old
manifest entries do not require an intake to exist; new cleanup targets do.

```sh
sudo /usr/bin/python3 /Library/PolkaswapStorage/host-storage-guard.py run \
  --config /Library/PolkaswapStorage/config.json --dry-run
cat /Library/PolkaswapStorage/status.json
sudo launchctl print system/org.polkaswap.storage-guard
```

## Free-space preflight

`ops/storage-preflight.cjs` enforces a minimum 75 GiB reserve plus a measured
peak additional write budget, including WAL, copies, and write amplification.
It checks the actual destination filesystem and the active/source database
volume. It runs before direct backup, checkpoint, restore, migration,
compaction, and repair entrypoints. A missing or invalid estimate fails closed;
API startup and read-only audits are unaffected.

The current deployed maintenance entrypoints import the root-owned installed
preflight before their other imports. Original files and their SHA-256 hashes
are retained under `/Library/PolkaswapStorage/rollback-20261017` and
`maintenance-patches.json`. Both deployed environment files also retain the
preflight in `NODE_OPTIONS`, preserving their previous Node options. Qualified
maintenance that sources those environments therefore inherits the preflight
across normal releases. Reapply and verify the explicit import when activating
a new release so direct commands remain guarded even without the environment
preload. The root-owned preload itself is not replaced by a normal release.

For a maintenance plan whose measured peak extra allocation is 20 GiB:

```sh
export INDEXER_STORAGE_EXPECTED_WRITE_BYTES=21474836480
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require=/Library/PolkaswapStorage/storage-preflight.cjs"
# Run the intended qualified maintenance command with its documented environment.
```

This check does not authorize the operation or replace the existing offline lock,
backup, identity, integrity, or write-amplification checks. Keep the monitor
running during long maintenance. A generic read-only capacity check is also
available:

```sh
sudo /usr/bin/python3 /Library/PolkaswapStorage/host-storage-guard.py check-space \
  --config /Library/PolkaswapStorage/config.json --required-bytes 21474836480
```

## Log rotation

Pi's original `run-pi-qualified.sh` remains the application launcher. The
root-owned `run-pi-supervised.sh` wraps it and publishes
`pi-supervisor.pid`. Both launchd output streams use `pi-combined.log`.
`/etc/newsyslog.d/org.sora.pi-indexer.conf` retains five 100 MiB archives. Its
USR2 signal makes the supervisor send one TERM to its exact child, wait for
RocksDB to close, and exit. launchd then opens the new log and restarts the
service. Never signal an unrelated process or delete the live RocksDB lock.
The previous `pi.out.log` and `pi.err.log` remain retained incident evidence.

Nginx access/error logs rotate at 100 MiB, with five compressed archives, through
`org.polkaswap.nginx.conf`. USR1 reopens nginx logs without restarting nginx.
The guard's own log retains five 10 MiB archives. The older MOF indexer's existing
rotation policy is preserved.

```sh
sudo newsyslog -nvv -f /etc/newsyslog.d/org.sora.pi-indexer.conf
sudo newsyslog -nvv -f /etc/newsyslog.d/org.polkaswap.nginx.conf
```

After a Pi rotation, require a different supervisor PID, the same database path,
stdout/stderr pointing to the current log rather than `.0`, healthy public
GraphQL, advancing indexed blocks, and a passing browser check.

## Validation and rollback

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests/ops -p 'test_*.py'
node --test tests/ops/storage-preflight.test.cjs
bash -n ops/run-pi-supervised.sh
```

The tests exercise protected/active paths, expiry and file identity, open files,
parent replacement, failure reporting, low space, direct Node/tsx invocation,
and graceful signal/reaping behavior. Simulated low space uses temporary test
fixtures; never fill the production disk to test an alert.

Deployment validation on October 17 passed all 50 focused tests (34 Python and
16 Node) and the indexer build. The broad suite initially reported five timing
failures; rerunning those suites with two workers passed all 57 tests. The host
refused maintenance without a write estimate and with an impossible estimate.
Simulated low-space alerts, repeated-alert suppression, and recovery passed.
Live Pi and nginx rotations passed, and the default scheduled newsyslog command
recognizes all three new policies. All 32 protected paths remained present,
and the running Pi process retained the expected RocksDB lock. The email
delivery test to the configured address was accepted by Gmail.

Fresh verification at 01:44 UTC found the public Pi API healthy with zero block
lag. Browser verification subsequently exposed a separate RPC metadata timeout:
the 1,331,886-byte metadata response took 17 ms directly on the host and 37 ms
through local nginx, but 59–111 seconds over the public connection from the
verification client. The browser times out after about 53 seconds. Basic RPC
health, synchronization, CORS, and WebSocket upgrade checks passed. This public
delivery delay remains unresolved; the final browser check is not a pass.

To disable cleanup while investigating, boot out only
`system/org.polkaswap.storage-guard`. Its manifest, status, and protected data
remain intact. Pi's pre-supervisor plist is retained in the rollback directory.
Restore it only through a controlled stop/restart of the exact Pi service. Restore
maintenance files only when their installed SHA-256 matches the recorded patch;
do not overwrite a newer release or change the persistent database.
