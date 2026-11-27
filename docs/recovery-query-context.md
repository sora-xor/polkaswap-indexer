# Historical storage contexts during recovery

The `canonical-stats-history` worker uses `RecoveryQueryContexts` for historical
storage reads. The ordinary worker and full points replay keep their existing
query path. This adapter does not establish entitlement readiness or certify a
complete replay.

SORA Nexus reused runtime version 134 for different execution metadata. A shared
`ApiPromise.at(hash)` registry cache therefore cannot identify the correct state
from `specVersion` alone. Each context verifies the requested header's hash and
canonical height, then binds its raw state metadata to the policy witness for
**height + 1**. Block/event execution continues to use its separate witness for
**height**. Stored `:code` is not treated as proof of code-substitute execution.

The adapter uses public `ApiPromise.create({ metadata, registry, typesBundle })`
and `at(hash, realRuntimeVersion)` APIs. It retains the exact worker legacy bundle
when `CHAIN_LEGACY_SORA_BLOCK_TYPES` is enabled, and copies real chain properties.
It checks the original metadata bytes, the resulting registry, and every storage
declaration (including map hashers, modifiers and defaults). The non-subscribing
provider facade cannot submit transactions, negotiate other metadata, open a new
connection, or disconnect the owner's transport.

Clients are keyed by witnessed metadata hash and the complete real runtime
version. A state whose parent has a different runtime version receives a separate
fixed-hash client. Public API registry reentry therefore cannot replace its state
registry with its executing parent's registry. The cache retains at most 16
clients per owner API and does not evict clients beneath callers. An unexpected
extra identity fails closed. Failed initialization closes its facade and removes
only its failed cache entry; a later caller must independently reverify evidence.

Captured storage methods acquire a reference-counted proof lease until their
bounded request completes. This supports reused and overlapping contexts without
retaining an unbounded list of block hashes. Storage RPCs require a leased hash;
pages and keys are bounded, storage bytes and sizes are validated, and
`state_queryStorageAt` must return exactly the requested block and keys. Existing
worker admission/timeouts remain active. The adapter also has finite deadlines,
shutdown cancellation, and no runtime subscriptions or keepalive timer.

`tests/recovery-query-context.spec.ts` uses offline pinned runtime-134 metadata,
synthetic canonical headers, real API registries and codecs. It covers version
reuse, transition and overlapping contexts, six-field asset tuple/Option reads,
size/multi/paging, malformed responses, failed initialization, finite deadlines,
cleanup, and the unchanged ordinary-worker selector. Runtime-138 fixture-version
coverage is synthetic; the separately retained four-state archive diagnostic is
required to qualify the actual candidate runtime. A diagnostic of source bytes
must not be presented as a witness for a different frozen release.
