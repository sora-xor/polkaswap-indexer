# Optional RocksDB document compression

`ROCKSDB_DOCUMENT_COMPRESSION` accepts `none` (default) or `brotli`. Select
`brotli` only with a new empty database path. The first metadata transaction
sets `rocksdbFormatVersion=3`, before any document is written. Existing
format-1/2 databases, including an initialized empty format-2 database, cannot
be converted. Nonempty unversioned databases remain forbidden. A format-3
writer requires `brotli` on every resume; omitting it fails before index
preparation or logical writes. Format-2 creation and format-1 upgrades are
unchanged. No existing database is changed by deploying the new reader.

The reader capability is explicit: formats 2 and 3 are supported. Read-only
handles select their codec from stored metadata, independent of writer options.
Older readers and writers reject marker 3. A rollback must keep a compatible
binary or restore a separately verified format-2 artifact; never lower a marker
or copy compressed values into a format-2 store.

## Encoding and bounds

Format-2 values retain their existing five-element native tuple:
`[2, blockHeight, timestamp, restoreFlags, compactData]`. Format-3 databases
allow those ordinary tuples for small/incompressible records and additionally
allow `[3, blockHeight, timestamp, restoreFlags, "brotli-json-v1", jsonBytes,
compressedBuffer]`. A format-2 reader rejects compressed envelopes. Tuple
length, positions, restore bits, fixed codec, Buffer type and byte lengths are
validated before decompression.

Only normalized compact data is serialized as JSON. Header slots remain native
so `undefined`, `null` and exact nonnegative integer positions are preserved.
Existing normalization owns the JSON data, canonicalizes negative zero and
null-prototype records, and rejects unsupported numbers, keys, accessors and
non-JSON values. Compression uses built-in Node Brotli quality 4, only for JSON
of at least 1,024 bytes and only when the compressed payload plus a conservative
64-byte envelope allowance is smaller. There is no new dependency.

Compressed input and declared output are each bounded by the existing 32 MiB
document data limit. Decompression uses `maxOutputLength` equal to the declared
length; both the actual output length and consumed compressed input length must
match exactly. Truncated streams, trailing bytes and concatenated streams fail.
Re-encoding the parsed JSON must reproduce its exact UTF-8 bytes, rejecting
invalid UTF-8, duplicate keys, noncanonical numbers and trailing JSON. Existing
restore-bit checks and complete document normalization then run again, including
depth, node, string, integer and indexed-field limits. Existing aggregate write
call limits, transaction boundaries, cache retained-memory bounds and scan
budgets remain based on decoded data, never compressed byte counts.

All indexes, GraphQL filters, equality checks, count updates, watch events,
valuation hashes and recovery receipts use normalized documents. Compression
bytes are not an input to any logical commitment. JSON preserves lone UTF-16
surrogates through escapes; the existing ordinary MessagePack path can replace
them. Existing conservative string-index buckets continue to handle those
aliases. Chain text is decoded UTF-8; this is not a reason to transform any
historical valuation input.

## Tool compatibility

| Tool/path | Format-3 behavior |
| --- | --- |
| `RocksRepository`, `serve-recovery-hold` | Explicit 2/3 reader; format-3 writes require `brotli`. All reads decode before filtering/index validation. |
| `audit-rocksdb` | Its exclusive repository open requires `brotli` for format 3. Passes the stored format to the decoder and checks missing/stale indexes for both formats. Reports supported versions separately from the default. |
| `rocksdb-artifact-source` | Central 2/3 capability guard, preserving complete-index, migration-state, old-namespace and nonempty-source checks. |
| `backup-rocksdb`, `checkpoint-rocksdb`, `compact-rocksdb` | Use the central guard and existing exclusive/offline native procedures. Copy or compact bytes without changing document encoding. Backup metadata records the actual format. |
| `restore-rocksdb` | Restores only to fresh staging, verifies native checksums/full file hashes, then uses the explicit reader and exhaustive compact-index validation. |
| `verify-rocksdb`, `verify-postgres-rocksdb-logical` | Compare decoded normalized rows and validate all indexes; the exclusive repository open requires `brotli` for an existing format-3 target. |
| `export-points-recovery`, `points-journal` | Use the explicit read-only repository; exported JSON, digest roots, source-file pins and continuity checks are unchanged. |
| `repair-network-volume` | Preserves the initial read-only validation and exclusive writer handoff; format-3 maintenance writes require `brotli`. |
| `migrate-postgres-to-rocksdb` | Explicitly format 2 only; rejects `brotli` before connecting or creating a target. |
| `repair-rocksdb-legacy-checkpoint` | Explicitly format 2 only, retaining its sealed-migration prerequisite. |

Historical private inspectors `operations/inspect-stopped-db.mjs` and
`operations/find-snapshot-future.mjs` are pinned to the immutable legacy release
and format-2 source/replay artifacts. They are intentionally unchanged and must
not be redirected to format 3. The latter directly reads tuple slots; a new
inspector must use the new decoder with the actual database marker. Frozen
release copies remain immutable; use a newly frozen compatible release for
compressed recovery candidates.

## Validation before recovery use

Focused tests cover normalization/header parity, bounded corrupt-stream
rejection, fresh-only format admission, native reopen/query/index parity,
checksum-verified backup/checkpoint/restore, export-reader and logical verifier
compatibility, and exact format-2/3 journal/valuation/receipt equality. The
candidate must additionally pass a finite native replay against the same
canonical block range and policy, with all logical documents, point roots and
indexes equal. Compare total database bytes including `.blob`, SST, WAL and
working files; SST-only measurements undercount large values.

Compression is not a full-history capacity estimate or recovery certification.
Keep existing free-space guards, stopped verified checkpoints and all canonical,
valuation, historical-denomination and policy admission checks. Codec tests alone
do not establish full replay capacity or production readiness.
