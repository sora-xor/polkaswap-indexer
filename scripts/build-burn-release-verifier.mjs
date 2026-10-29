#!/usr/bin/env node
// Offline, create-new executable evidence. No package installation or RPC.
import {build, version as esbuildVersion} from 'esbuild';
import {createHash} from 'node:crypto';
import {builtinModules} from 'node:module';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--output') throw new Error('Use --output NEW_DIRECTORY');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(args[1]);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const bundled = await build({
  absWorkingDir: root, entryPoints: ['src/scripts/verify-burn-release.ts'],
  bundle: true, platform: 'node', target: 'node24', format: 'esm',
  write: false, metafile: true, legalComments: 'inline',
  banner: {js: "import {createRequire as __burnCreateRequire} from 'node:module'; const require = __burnCreateRequire(import.meta.url);"},
});
const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
for (const result of Object.values(bundled.metafile.outputs)) {
  if (result.imports.some(item => item.external && !builtins.has(item.path))) {
    throw new Error('Burn verifier retains an unbound external dependency');
  }
}
if (bundled.outputFiles.length !== 1) throw new Error('Burn verifier must be one self-contained JavaScript artifact');
const artifact = bundled.outputFiles[0].contents;
const inputs = [];
for (const path of Object.keys(bundled.metafile.inputs).sort()) {
  const bytes = await readFile(resolve(root, path));
  inputs.push({file: path, sha256: sha(bytes), bytes: bytes.length});
}
for (const path of ['package.json', 'yarn.lock', 'scripts/build-burn-release-verifier.mjs']) {
  const bytes = await readFile(resolve(root, path));
  inputs.push({file: path, sha256: sha(bytes), bytes: bytes.length});
}
const provenance = {schema: 'sora-nexus-bundled-burn-verifier-v1',
  artifact: {file: 'burn-recovery-verifier.mjs', sha256: sha(artifact), bytes: artifact.length},
  bundler: {name: 'esbuild', version: esbuildVersion}, nodeVersion: process.version,
  inputs, networkUsed: false, productionReady: false};
await mkdir(output);
await writeFile(resolve(output, provenance.artifact.file), artifact, {flag: 'wx'});
await writeFile(resolve(output, 'source-provenance.json'), JSON.stringify(provenance, null, 2) + '\n', {flag: 'wx'});
process.stdout.write(JSON.stringify(provenance.artifact) + '\n');
