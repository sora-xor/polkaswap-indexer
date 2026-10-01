import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

// Verify runtime dependencies outside this repository and its ancestor modules.
const isolated = await mkdtemp(path.join(tmpdir(), 'polkaswap-production-'));
let server;
const marker = randomBytes(20).toString('hex');
try {
  for (const name of ['package.json', 'yarn.lock', '.yarnrc.yml', 'dist', 'public', 'plugin']) await cp(name, path.join(isolated, name), { recursive: true });
  const yarnJs = process.env.POLKASWAP_YARN_JS;
  const install = spawnSync(yarnJs ? process.execPath : 'corepack', [...(yarnJs ? [yarnJs] : ['yarn']), 'workspaces', 'focus', '--all', '--production'], { cwd: isolated, encoding: 'utf8', timeout: 180_000, env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', YARN_ENABLE_IMMUTABLE_INSTALLS: 'true' } });
  assert.equal(install.status, 0, install.stderr || install.error?.message || install.stdout);
  await writeFile(path.join(isolated, 'runtime-check.mjs'), `
import assert from 'node:assert/strict';
import '@modelcontextprotocol/sdk/server/streamableHttp.js';
import '@modelcontextprotocol/ext-apps/server';
import '@polkadot/api';
import '@sora-substrate/type-definitions';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const client = new Client({name:'isolated-production-check',version:'0.1.0'});
try {
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:4381/mcp')));
  assert.equal((await client.listTools()).tools.length, 4);
  assert((await client.readResource({uri:'ui://polkaswap-evidence/v1.html'})).contents[0].text.includes('Polkaswap'));
} finally { await client.close(); }
`);
  let output = '';
  server = spawn(process.execPath, ['dist/src/server.js'], { cwd: isolated, env: { ...process.env, HOST: '127.0.0.1', PORT: '4381', RELEASE_COMMIT: marker }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', data => { output += data; });
  server.stderr.on('data', data => { output += data; });
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (server.exitCode !== null) throw new Error(`Production server exited: ${output}`);
    try { const response = await fetch('http://127.0.0.1:4381/health'); const health = await response.json(); ready = response.ok && health.readOnly === true && health.service === 'polkaswap-evidence' && health.commit === marker; } catch { /* Await only this isolated process. */ }
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert(ready, `Production server did not become ready: ${output}`);
  const contract = spawnSync(process.execPath, ['runtime-check.mjs'], { cwd: isolated, encoding: 'utf8', timeout: 30_000 });
  assert.equal(contract.status, 0, contract.stderr || contract.error?.message || contract.stdout);
  assert.equal(server.exitCode, null, `Production candidate exited during verification: ${output}`);
  console.log('Clean production-only install, runtime imports, health, MCP tools and UI resource passed.');
} finally {
  if (server && server.exitCode === null) { server.kill('SIGTERM'); await new Promise(resolve => server.once('exit', resolve)); }
  await rm(isolated, { recursive: true, force: true });
}
