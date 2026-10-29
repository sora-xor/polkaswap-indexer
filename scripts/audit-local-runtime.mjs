import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Check source and resolved dependencies without loading any dependency code. */
export function auditLocalRuntime(root) {
  const errors = [];
  const prohibited = /@sora-substrate\/|sora2-substrate-js-library/i;
  for (const name of ['package.json', 'yarn.lock', 'package-lock.json', 'pnpm-lock.yaml']) {
    const file = resolve(root, name);
    if (existsSync(file) && prohibited.test(readFileSync(file, 'utf8'))) errors.push(`${name}: prohibited dependency`);
  }
  const walk = (directory) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = resolve(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(?:[cm]?[jt]s|json)$/.test(entry.name) && entry.name !== 'provenance.json' && prohibited.test(readFileSync(file, 'utf8'))) {
        errors.push(`${relative(root, file)}: prohibited import or remote runtime dependency`);
      }
    }
  };
  walk(resolve(root, 'src'));
  const provenance = JSON.parse(readFileSync(resolve(root, 'src/runtime/provenance.json'), 'utf8'));
  for (const [key, name] of [['legacy', 'sora-legacy-types.json'], ['mobile', 'sora-mobile-types.json']]) {
    const bytes = readFileSync(resolve(root, 'src/runtime', name));
    JSON.parse(bytes.toString());
    if (createHash('sha256').update(bytes).digest('hex') !== provenance[key].sha256) errors.push(`${name}: unreviewed schema change`);
  }
  const installed = resolve(root, 'node_modules/@sora-substrate');
  if (existsSync(installed) && readdirSync(installed).length) errors.push('node_modules: prohibited dependency remains installed');
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = auditLocalRuntime(resolve(fileURLToPath(new URL('..', import.meta.url))));
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else console.log('Local runtime audit passed: pinned schemas; no upstream SORA package or runtime URL.');
}
