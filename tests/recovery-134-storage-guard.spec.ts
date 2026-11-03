import { readdirSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { Metadata, TypeRegistry } from '@polkadot/types';
import { stringCamelCase } from '@polkadot/util';
import { blake2AsHex } from '@polkadot/util-crypto';
import { describe, expect, it } from 'vitest';

/**
 * The original runtime 134 (executing 28,073,393–28,191,817) and the recovery runtime 134 (executing
 * 28,191,818 until runtime 138 activates) report the same specName/specVersion, so polkadot.js `api.at`
 * reuses one registry for both. That is safe only while every storage item the indexer reads has the
 * same structure in both runtimes; otherwise such reads must decode from pinned witness metadata.
 */
const FIXTURES = new URL('./fixtures/recovery-134/', import.meta.url);
const SOURCE = new URL('../src/', import.meta.url);
const RUNTIMES = {
  original: { file: 'original-134.metadata.scale.gz', hash: '0x0c1d4bf5c3bc5037ad854932443c94faae6c327ecf1f38b3e77d38668cc2b4b8' },
  recovery: { file: 'recovery-134.metadata.scale.gz', hash: '0xe6d4a5514a6c529c541844aad50597a60a798ae966e4f96b38af565cd78e2f9d' },
} as const;

const raw = (runtime: keyof typeof RUNTIMES) => gunzipSync(readFileSync(new URL(RUNTIMES[runtime].file, FIXTURES)));

/** Id- and path-free structure of every storage item, keyed as polkadot.js decorates it. */
function storageShapes(bytes: Uint8Array): Map<string, string> {
  const registry = new TypeRegistry();
  const metadata = new Metadata(registry, bytes);
  registry.setMetadata(metadata);
  const memo = new Map<number, string>();
  const shape = (id: { toNumber(): number } | number, open = new Set<number>()): string => {
    const key = typeof id === 'number' ? id : id.toNumber();
    const known = memo.get(key);
    if (known !== undefined) return known;
    if (open.has(key)) return 'recursive';
    open.add(key);
    const def = registry.lookup.getSiType(key).def;
    const fields = (list: typeof def.asComposite.fields) => list.map((f) => `${f.name.unwrapOr('')}:${shape(f.type, open)}`).join(',');
    const out = def.isComposite ? `{${fields(def.asComposite.fields)}}`
      : def.isVariant ? `<${def.asVariant.variants.map((v) => `${v.index}${v.name}(${fields(v.fields)})`).join('|')}>`
      : def.isSequence ? `[${shape(def.asSequence.type, open)}]`
      : def.isArray ? `[${shape(def.asArray.type, open)};${def.asArray.len}]`
      : def.isTuple ? `(${def.asTuple.map((t) => shape(t, open)).join(',')})`
      : def.isPrimitive ? def.asPrimitive.toString()
      : def.isCompact ? `Compact<${shape(def.asCompact.type, open)}>`
      : def.type;
    open.delete(key);
    memo.set(key, out);
    return out;
  };
  const shapes = new Map<string, string>();
  for (const pallet of metadata.asLatest.pallets) {
    if (pallet.storage.isNone) continue;
    for (const item of pallet.storage.unwrap().items) {
      const type = item.type;
      const signature = type.isPlain ? `value=${shape(type.asPlain)}`
        : `hashers=${type.asMap.hashers.join(',')} key=${shape(type.asMap.key)} value=${shape(type.asMap.value)}`;
      shapes.set(`${stringCamelCase(pallet.name.toString())}.${stringCamelCase(item.name.toString())}`, `${signature} ${item.modifier}`);
    }
  }
  return shapes;
}

/** Every `query.<section>.<method>` read in the indexer source. */
function indexerStorageReads(directory = SOURCE, found = new Set<string>()): Set<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) indexerStorageReads(new URL(`${entry.name}/`, directory), found);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      for (const match of readFileSync(new URL(entry.name, directory), 'utf8').matchAll(/query\.([a-zA-Z0-9]+)\??\.([a-zA-Z0-9]+)/g)) {
        found.add(`${match[1]}.${match[2]}`);
      }
    }
  }
  return found;
}

describe('spec-134 registry reuse across the recovery fork', () => {
  it('uses the pinned witness metadata of both runtimes', () => {
    for (const runtime of ['original', 'recovery'] as const) {
      expect(blake2AsHex(raw(runtime), 256)).toBe(RUNTIMES[runtime].hash);
    }
  });

  it('decodes every storage item the indexer reads identically under both spec-134 runtimes', () => {
    const original = storageShapes(raw('original'));
    const recovery = storageShapes(raw('recovery'));
    const reads = [...indexerStorageReads()].filter((read) => original.has(read) || recovery.has(read));
    expect(reads.length).toBeGreaterThanOrEqual(19);
    const unsafe = reads.filter((read) => original.get(read) !== recovery.get(read));
    expect(unsafe, 'decode these from pinned witness metadata instead of api.at').toEqual([]);
  }, 120_000); // two full registries take several seconds to build on a loaded machine
});
