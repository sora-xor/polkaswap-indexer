import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
const { auditLocalRuntime } = await import(new URL('../scripts/audit-local-runtime.mjs', import.meta.url).href) as { auditLocalRuntime: (root: string) => string[] };

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-runtime-audit-'));
  roots.push(root);
  mkdirSync(join(root, 'src/runtime'), { recursive: true });
  for (const file of ['provenance.json', 'sora-legacy-types.json', 'sora-mobile-types.json']) copyFileSync(new URL(`../src/runtime/${file}`, import.meta.url), join(root, 'src/runtime', file));
  writeFileSync(join(root, 'package.json'), '{}');
  return root;
};

describe('runtime dependency audit', () => {
  it('accepts pinned local schemas but rejects dependency, lock and remote URL reintroduction', () => {
    const root = fixture();
    expect(auditLocalRuntime(root)).toEqual([]);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { '@sora-substrate/type-definitions': '1' } }));
    writeFileSync(join(root, 'yarn.lock'), '"@sora-substrate/sdk@npm:1":');
    writeFileSync(join(root, 'src/remote.ts'), "const types = 'https://github.com/sora-xor/sora2-substrate-js-library';");
    expect(auditLocalRuntime(root)).toEqual(expect.arrayContaining([
      'package.json: prohibited dependency',
      'yarn.lock: prohibited dependency',
      'src/remote.ts: prohibited import or remote runtime dependency',
    ]));
  });

  it('rejects changed schema data and a stale installed package', () => {
    const root = fixture();
    writeFileSync(join(root, 'src/runtime/sora-mobile-types.json'), '{}');
    mkdirSync(join(root, 'node_modules/@sora-substrate/sdk'), { recursive: true });
    expect(auditLocalRuntime(root)).toEqual(expect.arrayContaining([
      'sora-mobile-types.json: unreviewed schema change',
      'node_modules: prohibited dependency remains installed',
    ]));
  });
});
