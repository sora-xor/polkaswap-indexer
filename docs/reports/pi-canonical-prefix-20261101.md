# Pi canonical history restoration — 1 November 2026

The production endpoint, `https://pi.soramitsu.io/graphql`, now serves the audited
canonical history through block **28,191,816**. It replaces the retained
abandoned-fork checkpoint without starting a writer. Live indexing is still
unavailable, and recovery entitlements remain uncertified.

The checkpoint hash is
`0x60b63e40ce4de9b9c1408bf7455a6f5ced796825f2437a0ee8496476d80c56d6`,
with timestamp `1792939554`. Native inspection on both MOF2 and Pi found
27,428,271 documents and 2,133,341 retained BLOCK rows; all native indexes passed.
The suffix repaired from the retained snapshot contains 165,073 consecutive
blocks. The retained database has earlier historical gaps and is not a complete
genesis replay.

All 499 database files matched before and after Pi's read-only audit. The native
output is byte-identical to MOF2's independently qualified output. Its SHA-256 is
`786455fba448810322010a84badc80e4f1a122da3b683cbcee397ec09db96c1f`.
The Pi executor receipt is
`650d350b22371d2795f0cb43b08f175d269feb39d625cec2743ce4d2910c35a6`.
The audit executor and native child exited, and executor stderr was empty.

The reviewed activation contract is
`41c72841be3c8fb12cbc5cd2df151998792c1308ead4c469265b94cd70c348d3`.
It bound a fresh common finalized block, 28,194,663, observed on both approved
production RPCs, to the exact new database and release. Activation retained the
existing `org.sora.pi-indexer` service, supervisor, Node 24 runtime and loopback
port 4010. One graceful service signal drained the old reader. The original
database, launcher, environment and rollback artifacts remain retained.

Acceptance covered the seven exact shipped frontend statistics queries over
two ranges on both public and loopback endpoints: **28 successful cases**, with
identical endpoint responses. It also verified canonical BLOCK counts/bounds,
checkpoint identity and the explicit read-only, stopped, unhealthy classification.
Current ranges correctly contain no recent blocks; successful query execution
does not establish current data. The acceptance receipt SHA-256 is
`4627f6f688a0319617e54964d5fbc4d3f6e2376cb68a656484871efc9059599a`;
the completed transition receipt is
`98572efa8a886e9b5d3a176d020bb70c244fb13356478fdd149d8ddad115a981`.

Private operational evidence is retained in the web checkout under
`output/ops/archive-recovery-20261031/pi-prefix-return-20261101/`, including
`activation-return-02-collected/verification.json`. No frontend publication,
Bunny update, RPC replacement or unrelated service restart was part of this API
change. The archive and independent full-history replay continue separately.
