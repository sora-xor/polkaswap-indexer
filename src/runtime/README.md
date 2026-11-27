# Locally owned SORA runtime schemas

These JSON files are inert SCALE layout data. Runtime code neither imports an
external SORA JavaScript package nor downloads a schema from its repository.

- `sora-legacy-types.json` preserves the 195 legacy type definitions needed by
  archive decoding. Definitions were read as literal syntax from the already
  installed Apache-2.0 SORA type-definitions 1.46.3 and ORML 1.1.4 packages. A
  strict TypeScript AST reader accepted only objects, arrays, strings, numbers,
  booleans, and null; it never imported or executed those packages. Module merge
  precedence and the existing final overrides were preserved. Executable code,
  RPC wrappers, and package installation logic were excluded.
- `sora-mobile-types.json` contains the native aliases already reviewed in the
  SORA Android production runtime-130 manifest. Portable runtime metadata
  supplies the remaining types. This is not a replacement for every historical
  mobile runtime schema; the worker's separate legacy map handles archives.
- `provenance.json` records exact schema digests, source file digests, and the
  source revision associated with the mobile manifest. `LICENSE` retains the
  Apache-2.0 notice for the extracted schema data. SORA contributors and Laminar
  Developers retain copyright in their respective source definitions.

Maintain these files locally against reviewed chain runtime definitions. Schema
changes must update the provenance digest and corresponding SCALE codec tests.
`yarn audit:local-runtime` rejects package/lock/source reintroduction and schema
changes without updated digests; CI runs it after installation.

The API serves the mobile JSON at `/runtime/sora-mobile-types.json`; GET and HEAD
are supported under the normal request rate limits, with no external fetch.
The GraphQL `mobileConfig` uses the canonical Pi HTTPS URL. A deployment must
forward this route through the same reverse proxy as the GraphQL API. The JSON
imports are emitted into `dist/src/runtime` by TypeScript. The build then restores
the exact source JSON bytes alongside their provenance and license, so normal
and container artifacts can be checked against the same reviewed digests.
