import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactRoot = path.join(root, 'artifacts', 'ui-qa');
const playwright = process.env.POLKASWAP_PLAYWRIGHT_MODULE ? await import(pathToFileURL(path.resolve(process.env.POLKASWAP_PLAYWRIGHT_MODULE)).href) : await import('playwright');
const html = await readFile(path.join(root, 'dist', 'widget.html'), 'utf8');
const hash = `0x${'a'.repeat(64)}`;
const address = `0x${'b'.repeat(64)}`;
const fixtures = {
  transaction: { kind: 'transaction', status: 'ok', title: 'QA fixture · Transaction evidence', summary: 'Synthetic rendering data only. The outer extrinsic succeeded; child-call outcomes require separate evidence.', provenance: { source: 'QA fixture — no live chain data', indexedBlock: 9123456, indexedAt: '2026-10-01T08:00:00.000Z', retrievedAt: '2026-10-01T08:00:05.000Z', lagBlocks: 3 }, warnings: ['QA fixture, not an actual transaction.', 'Outer success does not establish that every nested call succeeded.'], data: { hash, module: 'utility', method: 'batch', blockHeight: 9123456, timestamp: '2026-10-01T08:00:00.000Z', outcome: 'outer extrinsic succeeded', fee: { atomic: '7000000000000000', decimal: '0.007000000000000000', symbol: 'XOR' }, execution: { success: true }, data: { assetId: `0x${'0'.repeat(63)}1` }, calls: { nodes: [{ id: 'child-failure-fixture', module: 'poolXYK', method: 'depositLiquidity', execution: { success: false, error: 'Synthetic child failure' } }] } } },
  portfolio: { kind: 'portfolio', status: 'ok', title: 'QA fixture · Public wallet balances', summary: 'Synthetic balances for exact-number and layout checks.', provenance: { source: 'QA fixture — no live chain data', retrievedAt: '2026-10-01T08:00:05.000Z' }, warnings: ['QA fixture only.'], data: { address, chainFinalizedBlock: 9123459, assets: [{ symbol: 'XOR', assetId: `0x${'0'.repeat(63)}1`, free: '9007199254740993.000000000000000001', reserved: '1.000000000000000001', frozen: '0' }, { symbol: 'PSWAP', assetId: `0x${'0'.repeat(63)}2`, free: '1123.456789123456789', reserved: '0', frozen: '200.000000000000000000' }], pagination: { nextCursor: 'balance_cursor' } } },
  liquidity: { kind: 'liquidity', status: 'ok', title: 'QA fixture · Liquidity positions', summary: 'Synthetic pool positions. Reserve amounts are proportional estimates.', provenance: { source: 'QA fixture — no live chain data', retrievedAt: '2026-10-01T08:00:05.000Z' }, warnings: ['Current position only; no historical P&L or tax report.'], data: { address, positions: [{ poolId: `0x${'c'.repeat(64)}`, baseAsset: 'XOR', targetAsset: 'PSWAP', poolTokensAtomic: '12345678912345678912345', poolTokenSupplyAtomic: '123456789123456789123450000', sharePercent: '0.01', proportionalBaseAmount: '1.123456789123456789', proportionalTargetAmount: '125.098765432109876543' }] } },
  history: { kind: 'history', status: 'ok', title: 'QA fixture · Account history', summary: 'Synthetic activity used to verify pagination and source disclosures.', provenance: { source: 'QA fixture — no live chain data', retrievedAt: '2026-10-01T08:00:05.000Z', historyWindow: 'Coverage is determined by the indexer.' }, warnings: ['Account-liquidity snapshots are retained for 48 hours; events have separate coverage.'], data: { address, items: [{ id: hash, module: 'poolXYK', method: 'depositLiquidity', blockHeight: 9123456, timestamp: '2026-10-01T08:00:00.000Z', networkFee: '7000000000000000', execution: { success: true }, data: {} }], pagination: { nextCursor: 'history_cursor' } } },
  unavailable: { kind: 'portfolio', status: 'unavailable', title: 'QA fixture · Source unavailable', summary: 'The source is temporarily unavailable.', provenance: { source: 'QA fixture — no live chain data', retrievedAt: '2026-10-01T08:00:05.000Z' }, warnings: ['No balances were returned.'], data: {} },
};

const hostSource = `import {AppBridge,PostMessageTransport} from '@modelcontextprotocol/ext-apps/app-bridge';
const fixtures=${JSON.stringify(fixtures)};
const frame=document.getElementById('app');
const bridge=new AppBridge(null,{name:'Polkaswap QA host',version:'1.0.0'},{serverTools:{}},{hostContext:{theme:'light',displayMode:'inline'}});
window.qa={calls:[],ready:false,push:async(value)=>{await bridge.sendToolInput({arguments:{}});await bridge.sendToolResult({content:[],structuredContent:value});},theme:(value)=>bridge.setHostContext({theme:value})};
bridge.oncalltool=async(params)=>{window.qa.calls.push({name:params.name,arguments:params.arguments});const kind={explain_transaction:'transaction',get_portfolio:'portfolio',get_liquidity_positions:'liquidity',get_account_history:'history'}[params.name];return {content:[],structuredContent:fixtures[kind]};};
bridge.oninitialized=async()=>{window.qa.ready=true;await window.qa.push(fixtures.transaction);};
await bridge.connect(new PostMessageTransport(frame.contentWindow,frame.contentWindow));frame.src='/widget';`;
const bundle = await build({ stdin: { contents: hostSource, resolveDir: root, sourcefile: 'qa-host.ts' }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', minify: true });
const hostHtml = `<!doctype html><html><head><title>Polkaswap QA host</title><style>body{margin:0;background:#f7f3f4}iframe{display:block;border:0;width:100%;height:1800px}</style></head><body><iframe id="app" title="Polkaswap evidence QA fixture"></iframe><script type="module">${bundle.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
await mkdir(artifactRoot, { recursive: true });
// Browser interception supplies fixtures locally; no HTTP listener or outbound
// request is needed. The reserved .invalid domain cannot be a production source.
const url = 'http://polkaswap-widget.invalid';
const browser = await playwright.chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 760, height: 920 } });
await context.route(`${url}/**`, (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: new URL(route.request().url()).pathname === '/host' ? hostHtml : html }));
const page = await context.newPage();
const errors = [];
const requests = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('request', (request) => requests.push(request.url()));
const checks = [];
const check = (name) => { checks.push(name); console.log(`Passed: ${name}`); };
const assertNoOverflow = async (scope) => assert.equal(await scope.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Widget must not overflow horizontally');
try {
  await page.goto(`${url}/widget`);
  await page.getByRole('heading', { name: 'Understand what happened.' }).waitFor();
  await page.getByLabel('SORA2 transaction hash').fill(hash);
  await page.getByRole('button', { name: 'Read evidence', exact: true }).click();
  await page.getByText('Open this widget through the Polkaswap ChatGPT plugin to read live chain data.').waitFor();
  assert.equal(await page.locator('.amount').count(), 0);
  assert.equal(await page.evaluate(() => localStorage.length), 0);
  check('Standalone preview is truthful and performs no live requests or persistence');

  await page.goto(`${url}/host`);
  await page.waitForFunction(() => window.qa?.ready);
  const frame = page.frameLocator('#app');
  await frame.getByRole('heading', { name: fixtures.transaction.title }).waitFor();
  await frame.getByText('0.007 XOR', { exact: true }).waitFor();
  await assertNoOverflow(page.frames()[1]);
  check('Standard AppBridge initialization and tool-result rendering');
  await frame.locator('summary').filter({ hasText: 'Source & freshness' }).click();
  await frame.getByText('QA fixture — no live chain data', { exact: true }).waitFor();
  check('Provenance and exact network fee visible');
  await frame.locator('.workspace').screenshot({ path: path.join(artifactRoot, 'transaction-desktop-fixture.png'), animations: 'disabled' });
  await frame.getByText('Execution & call evidence', { exact: true }).click();
  await frame.getByText('child-failure-fixture', { exact: false }).waitFor();
  check('GraphQL calls.nodes retains nested child failure evidence');

  await frame.getByText('Inspect another hash or wallet', { exact: true }).click();
  await frame.getByLabel('SORA2 transaction hash').fill('not-a-hash');
  await frame.getByRole('button', { name: 'Read evidence', exact: true }).click();
  await frame.getByText('Enter a complete 0x-prefixed, 64-digit transaction hash.').waitFor();
  assert.equal(await page.evaluate(() => window.qa.calls.length), 0);
  await frame.getByLabel('SORA2 transaction hash').fill(hash);
  await frame.getByRole('button', { name: 'Read evidence', exact: true }).click();
  await page.waitForFunction(() => window.qa.calls.length === 1);
  assert.deepEqual(await page.evaluate(() => window.qa.calls[0]), { name: 'explain_transaction', arguments: { hash } });
  check('User lookup uses standard bridge; invalid input stays local');

  await page.evaluate((value) => window.qa.push(value), fixtures.portfolio);
  await frame.getByText('9007199254740993.000000000000000001', { exact: true }).waitFor();
  await assertNoOverflow(page.frames()[1]);
  await frame.getByRole('button', { name: 'Load next page →' }).click();
  await page.waitForFunction(() => window.qa.calls.length === 2);
  assert.deepEqual(await page.evaluate(() => window.qa.calls[1]), { name: 'get_portfolio', arguments: { address, after: 'balance_cursor' } });
  check('Balances preserve decimal precision and pass next-page cursor');

  await page.setViewportSize({ width: 360, height: 900 });
  await assertNoOverflow(page.frames()[1]);
  await page.evaluate(() => window.qa.theme('dark'));
  await frame.locator('html[data-theme="dark"]').waitFor();
  await frame.locator('.workspace').screenshot({ path: path.join(artifactRoot, 'portfolio-mobile-dark-fixture.png'), animations: 'disabled' });
  check('360px mobile layout and live dark host theme');

  await page.evaluate((value) => window.qa.push(value), fixtures.liquidity);
  await frame.getByText('12345678912345678912345 atomic shares', { exact: true }).waitFor();
  await frame.getByText('Proportional reserve estimate:', { exact: false }).waitFor();
  await assertNoOverflow(page.frames()[1]);
  await frame.locator('.workspace').screenshot({ path: path.join(artifactRoot, 'liquidity-mobile-dark-fixture.png'), animations: 'disabled' });
  check('Liquidity shares exact and reserves explicitly estimated');

  await page.evaluate((value) => window.qa.push(value), fixtures.history);
  await frame.getByRole('button', { name: 'Load next page →' }).click();
  await page.waitForFunction(() => window.qa.calls.length === 3);
  assert.deepEqual(await page.evaluate(() => window.qa.calls[2]), { name: 'get_account_history', arguments: { address, after: 'history_cursor' } });
  check('History pagination and bounded history disclosure');

  for (const [kind, property, cursor, callNumber, toolName] of [['portfolio', 'assets', 'empty_balance_cursor', 4, 'get_portfolio'], ['liquidity', 'positions', 'empty_liquidity_cursor', 5, 'get_liquidity_positions'], ['history', 'items', 'empty_history_cursor', 6, 'get_account_history']]) {
    const fixture = { ...fixtures[kind], data: { address, [property]: [], pagination: { nextCursor: cursor } } };
    await page.evaluate((value) => window.qa.push(value), fixture);
    assert.equal(await frame.locator('.amount').count(), 0);
    await frame.getByRole('button', { name: 'Load next page →' }).click();
    await page.waitForFunction((count) => window.qa.calls.length === count, callNumber);
    assert.deepEqual(await page.evaluate(() => window.qa.calls.at(-1)), { name: toolName, arguments: { address, after: cursor } });
  }
  check('Sparse empty balance, liquidity, and history pages retain pagination');
  await page.evaluate((value) => window.qa.push(value), { ...fixtures.history, data: { ...fixtures.history.data, pagination: { hasNextPage: false, nextCursor: 'final_end_cursor' } } });
  await frame.getByText('End of the returned history page.', { exact: true }).waitFor();
  assert.equal(await frame.locator('[data-next-page]').count(), 0);
  check('Terminal pageInfo suppresses endCursor navigation');

  for (const baseAssetId of ['all', `0x${'d'.repeat(64)}`]) {
    const previousCount = await page.evaluate(() => window.qa.calls.length);
    const cursor = `liquidity_cursor_${baseAssetId}`;
    const fixture = { ...fixtures.liquidity, data: { ...fixtures.liquidity.data, baseAssetId, pagination: { hasNextPage: true, nextCursor: cursor } } };
    await page.evaluate((value) => window.qa.push(value), fixture);
    await frame.getByRole('button', { name: 'Load next page →' }).click();
    await page.waitForFunction((count) => window.qa.calls.length === count, previousCount + 1);
    assert.deepEqual(await page.evaluate(() => window.qa.calls.at(-1)), { name: 'get_liquidity_positions', arguments: { address, after: cursor, baseAssetId } });
  }
  check('Liquidity pagination preserves all-base and explicit-base filters through AppBridge');

  await page.evaluate((value) => window.qa.push(value), fixtures.unavailable);
  await frame.getByText('Source currently unavailable', { exact: true }).waitFor();
  assert.equal(await frame.locator('.amount').count(), 0);
  await page.evaluate((value) => window.qa.push(value), { ...fixtures.transaction, status: 'not_found', title: 'QA fixture · Transaction not indexed', summary: 'A missing record does not establish transaction failure.', data: { hash } });
  await frame.getByText('No matching record returned', { exact: true }).waitFor();
  assert.equal(await frame.locator('.status.failure').count(), 0);
  check('Missing transaction is not presented as a failed execution');
  const hostile = { ...fixtures.transaction, title: '<img src=x onerror="window.__injected=true">', summary: '<script>window.__injected=true</script>', warnings: ['<svg onload="window.__injected=true">'], data: { ...fixtures.transaction.data, execution: { error: '<img onerror="window.__injected=true">' } } };
  await page.evaluate((value) => window.qa.push(value), hostile);
  await frame.getByRole('heading', { name: hostile.title, exact: true }).waitFor();
  assert.equal(await frame.locator('img').count(), 0);
  assert.equal(await page.frames()[1].evaluate(() => window.__injected), undefined);
  await assertNoOverflow(page.frames()[1]);
  check('Unavailable state invents no balances; arbitrary evidence stays inert text');

  const legacy = await context.newPage();
  await legacy.setViewportSize({ width: 360, height: 900 });
  legacy.on('pageerror', (error) => errors.push(error.message));
  await legacy.addInitScript((fixture) => { window.openai = { theme: 'light', toolOutput: fixture, callTool: async () => ({ structuredContent: fixture }) }; }, fixtures.portfolio);
  await legacy.goto(`${url}/widget`);
  await legacy.getByRole('heading', { name: fixtures.portfolio.title }).waitFor();
  await legacy.evaluate((fixture) => window.dispatchEvent(new CustomEvent('openai:set_globals', { detail: { globals: { toolOutput: fixture, theme: 'dark' } } })), fixtures.history);
  await legacy.getByRole('heading', { name: fixtures.history.title }).waitFor();
  await legacy.locator('html[data-theme="dark"]').waitFor();
  await assertNoOverflow(legacy);
  await legacy.close();
  check('Legacy window.openai initial output and documented globals update');
  assert.deepEqual(errors, []);
  assert.equal(requests.some((request) => !request.startsWith(url)), false);
  check('No browser errors or external network requests');
  const report = { status: 'passed', fixtures: 'Synthetic QA only; screenshots are not chain evidence.', checks, screenshots: ['transaction-desktop-fixture.png', 'portfolio-mobile-dark-fixture.png', 'liquidity-mobile-dark-fixture.png'] };
  await writeFile(path.join(artifactRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error('UI QA page errors:', JSON.stringify(errors));
  throw error;
} finally {
  await browser.close();
}
