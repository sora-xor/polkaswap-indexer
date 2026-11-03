# Pi private statistics initialization

The Pi operator path is separate from the MOF2 ordinary-copy initializer. It
accepts only the retained, byte-verified APFS COW candidate at
`/Users/administrator/apps/pi-indexer-recovery-20261009/restores/pi-stats-history-private-20261101`.
The active canonical-prefix database remains read-only and is retained for
rollback. This initializer starts no API, chain worker, subscription or RPC
client and does not certify recovery entitlements.

`pi-stats-recovery-admission.ts` validates the exact Pi COW/source-native/READY
proofs and the genuine MOF2 normalized-before proof. The latter retains its
original MOF2 path and scan claims: no Pi normalized pre-scan or stopped source
service is invented. Every target file must still match the qualified 499-file
source map and have an independent inode before a writable handle is obtained.
The actual marker/checkpoint/identity/BLOCK and classification-absence checks
precede the three shared seed rows. The original MOF2 qualification and CLI
path guards are unchanged.

`initialize-pi-stats-recovery.ts` requires the exact fixed input paths, Darwin
UID501/GID20, a pinned root-parent binding, the explicit
`--apply-private-pi-stats-copy` argument, a finite deadline, and the protected
76 GiB filesystem reserve plus drain headroom. Parent loss, signal, deadline or
low space activates the repository's cooperative close path. The separately
reviewed host executor must also admit measured COW rewrite/compaction capacity,
hold the source POSIX LOCK, transfer candidate LOCK ownership to the actual
native writer, and prove all children/handles close. The existence of these
source files is not an execution approval.

After initialization, an actual Pi native read-only audit must prove every
original normalized document and collection count unchanged, verify precisely
the three seeded rows against the initializer receipt (including the generated
reconciliation UUID), and validate every current native index. Complete file
hashes before/after that audit must match. Keep inherited-before and actual-Pi
post-audit provenance distinct in the final receipt. Worker replay and public
activation require their own reviewed packages and acceptance evidence.

The operational design and frozen evidence are retained privately under
`private-indexer-backups/recovery-20261031/operations/pi-stats-initializer-design-20261101`
and `pi-stats-initializer-20261101`; no policy mappings or credentials belong in
public logs or this documentation.
