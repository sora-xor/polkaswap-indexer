import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const built = await build({ entryPoints: [path.join(root, 'web/widget.ts')], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', minify: true, legalComments: 'inline' });
const [template, logo] = await Promise.all([readFile(path.join(root, 'web/widget.template.html'), 'utf8'), readFile(path.join(root, 'plugin/assets/logo.svg'), 'utf8')]);
const script = built.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = template.replace('__POLKASWAP_LOGO__', () => logo.trim()).replace('__WIDGET_SCRIPT__', () => script);
await mkdir(path.join(root, 'dist'), { recursive: true });
await Promise.all([writeFile(path.join(root, 'web/widget.html'), html), writeFile(path.join(root, 'dist/widget.html'), html)]);
console.log(`Built Polkaswap widget (${Buffer.byteLength(script)} script bytes; all assets embedded).`);
