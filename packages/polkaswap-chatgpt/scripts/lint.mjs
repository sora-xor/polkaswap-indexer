import { readdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
async function files(dir) { return (await Promise.all((await readdir(dir, { withFileTypes: true })).map(entry => entry.isDirectory() ? files(resolve(dir, entry.name)) : resolve(dir, entry.name)))).flat(); }
for (const file of [...await files(resolve(root, 'src')), ...await files(resolve(root, 'web'))].filter(file => /\.(ts|template.html)$/.test(file))) {
  const text = await readFile(file, 'utf8');
  if (/\beval\s*\(|\bsignAndSend\s*\(|\baddFromMnemonic\s*\(/.test(text)) throw new Error(`Prohibited executable/signing API in ${file}`);
  if (/[ \t]+$/m.test(text)) throw new Error(`Trailing whitespace in ${file}`);
}
execFileSync('git', ['diff', '--check'], { cwd: root, stdio: 'inherit' });
console.log('Read-only API and whitespace checks passed. TypeScript enforces types separately.');
