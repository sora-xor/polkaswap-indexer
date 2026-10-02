import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const endpoint = process.env.MCP_URL ?? 'http://127.0.0.1:4380/mcp';
const client = new Client({ name: 'polkaswap-release-verification', version: '0.1.0' });
const transport = new StreamableHTTPClientTransport(new URL(endpoint));
const signedAddress = 'cnWUWKLZmNjQXGzYAF7YuRSiW1pKTRTzu4fmcYmWQX6UMGQUZ';
const lpAddress = 'cnRVJqUuUQ5PLZudtxrSC65VAFgektdgMMJV2KgsGGL58o1mt';
const hash = '0xc1af40ceabafbc33b059c3e1dd2b3cd06e02c09d2962c7256340298f55970e57';
try {
  await client.connect(transport);
  const list = await client.listTools();
  assert.deepEqual(list.tools.map(tool => tool.name).sort(), ['explain_transaction', 'get_account_history', 'get_liquidity_positions', 'get_portfolio']);
  for (const tool of list.tools) {
    assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: true });
    assert.deepEqual(tool._meta?.securitySchemes, [{ type: 'noauth' }]);
  }
  const resource = await client.readResource({ uri: 'ui://polkaswap-evidence/v1.html' });
  assert(resource.contents[0].text.includes('Polkaswap'));
  const results = {};
  for (const [name, args] of [
    ['explain_transaction', { hash }],
    ['get_account_history', { address: signedAddress, first: 2 }],
    ['get_portfolio', { address: lpAddress, first: 25 }],
    ['get_liquidity_positions', { address: lpAddress, first: 25 }],
  ]) {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
    assert(!result.isError, `${name} returned an error`);
    assert.equal(result.structuredContent.status, 'ok');
    results[name] = result.structuredContent;
  }
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/live-debug.json', JSON.stringify(results, null, 2));
  assert.equal(results.explain_transaction.data.fee.atomic, '100018412589707326');
  assert.equal(results.explain_transaction.data.fee.decimal, '0.100018412589707326');
  assert(results.get_portfolio.data.assets.every(asset => typeof asset.atomic.free === 'string'));
  const lpPages = [results.get_liquidity_positions];
  while (!lpPages.some(page => page.data.positions.some(position => position.poolTokensAtomic === '5')) && lpPages.at(-1).data.pagination.hasNextPage && lpPages.length < 10) {
    const previous = lpPages.at(-1);
    const second = await client.callTool({ name: 'get_liquidity_positions', arguments: { address: lpAddress, baseAssetId: previous.data.baseAssetId, first: 50, after: previous.data.pagination.nextCursor } }, undefined, { timeout: 60_000 });
    assert(!second.isError); assert.equal(second.structuredContent.status, 'ok');
    assert.notEqual(second.structuredContent.data.pagination.nextCursor, previous.data.pagination.nextCursor);
    lpPages.push(second.structuredContent);
  }
  results.liquidityPages = lpPages;
  assert(lpPages.some(page => page.data.positions.some(position => position.poolTokensAtomic === '5')), 'Known live LP fixture was not returned while following pool registry pages');
  const all = await client.callTool({ name: 'get_liquidity_positions', arguments: { address: lpAddress, baseAssetId: 'all', first: 1 } }, undefined, { timeout: 60_000 });
  assert(!all.isError); assert.equal(all.structuredContent.status, 'ok');
  assert.equal(all.structuredContent.data.baseAssetId, 'all');
  assert.equal(all.structuredContent.data.pagination.hasNextPage, true);
  const allNext = await client.callTool({ name: 'get_liquidity_positions', arguments: { address: lpAddress, baseAssetId: 'all', first: 1, after: all.structuredContent.data.pagination.nextCursor } }, undefined, { timeout: 60_000 });
  assert(!allNext.isError); assert.equal(allNext.structuredContent.status, 'ok');
  assert.notEqual(allNext.structuredContent.data.pagination.nextCursor, all.structuredContent.data.pagination.nextCursor);
  results.allBasePages = [all.structuredContent, allNext.structuredContent];
  const next = results.get_account_history.data.pagination.nextCursor;
  if (next && results.get_account_history.data.pagination.hasNextPage) {
    const second = await client.callTool({ name: 'get_account_history', arguments: { address: signedAddress, first: 2, after: next } });
    assert(!second.isError); assert.notEqual(second.structuredContent.data.items[0]?.id, results.get_account_history.data.items[0]?.id);
    results.historySecondPage = second.structuredContent;
  }
  for (const [name, args] of [['explain_transaction', { hash: 'bad' }], ['get_portfolio', { address: 'private seed words' }], ['get_account_history', { address: signedAddress, first: 99999 }]]) {
    const bad = await client.callTool({ name, arguments: args }); assert.equal(bad.isError, true);
  }
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/live-smoke.json', JSON.stringify({ endpoint, retrievedAt: new Date().toISOString(), tools: list.tools, results }, null, 2));
  console.log(`Verified MCP initialization, all four live read-only tools, UI resource, exact fee, LP fixture, pagination and invalid inputs at ${endpoint}.`);
} finally { await client.close(); }
