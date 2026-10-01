import { App } from '@modelcontextprotocol/ext-apps';
import { escapeHtml, formatTime, object, parseEvidence, renderEvidence, valueText, type Evidence } from './view.js';

interface OpenAICompatibility {
  toolOutput?: unknown;
  theme?: string;
  callTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  notifyIntrinsicHeight?: (height: number) => void;
}
declare global { interface Window { openai?: OpenAICompatibility; } }

const resultNode = document.getElementById('result')!;
const lookupNode = document.getElementById('lookup')!;
const freshnessNode = document.getElementById('freshness')!;
const app = new App({ name: 'Polkaswap Evidence', version: '1.0.0' }, {}, { autoResize: true });
let connected = false;
let current: Evidence | null = null;
let currentMode = 'transaction';
let lastAddress = '';
let currentRequest = 0;
let busy = false;

function setTheme(theme: unknown): void {
  document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
}

function receive(value: unknown): boolean {
  const parsed = parseEvidence(value);
  if (!parsed) return false;
  current = parsed;
  const address = valueText(parsed.data.address ?? parsed.data.account, '');
  if (address) lastAddress = address;
  resultNode.innerHTML = renderEvidence(parsed);
  const retrieval = parsed.provenance.retrievedAt;
  freshnessNode.textContent = retrieval ? `Retrieved ${formatTime(retrieval)}` : 'Retrieval time not reported';
  if (parsed.kind !== 'status') currentMode = parsed.kind === 'transaction' ? 'transaction' : parsed.kind;
  renderLookup(false);
  resizeCompatibility();
  return true;
}

function receiveToolResult(value: unknown): boolean {
  return receive(object(value).structuredContent ?? value);
}

function resizeCompatibility(): void {
  if (!connected) window.openai?.notifyIntrinsicHeight?.(document.documentElement.scrollHeight);
}

function renderLookup(open: boolean): void {
  const walletMode = currentMode !== 'transaction';
  const form = `<form class="lookup-form" id="lookup-form"><div class="lookup-modes" role="tablist" aria-label="Lookup type"><button type="button" class="mode" id="transaction-tab" role="tab" aria-selected="${!walletMode}" aria-controls="lookup-panel" data-mode="transaction">Transaction</button><button type="button" class="mode" id="wallet-tab" role="tab" aria-selected="${walletMode}" aria-controls="lookup-panel" data-mode="portfolio">Public wallet</button></div><div id="lookup-panel" role="tabpanel" aria-labelledby="${walletMode ? 'wallet-tab' : 'transaction-tab'}">${walletMode ? `<label class="label" for="wallet-view">Wallet view</label><select id="wallet-view" aria-label="Wallet view"><option value="portfolio"${currentMode === 'portfolio' ? ' selected' : ''}>Balances</option><option value="liquidity"${currentMode === 'liquidity' ? ' selected' : ''}>Liquidity positions</option><option value="history"${currentMode === 'history' ? ' selected' : ''}>Indexed history</option></select>` : ''}<label class="label" for="lookup-value">${walletMode ? 'Public SORA2 address' : 'SORA2 transaction hash'}</label><div class="input-row"><input id="lookup-value" name="lookup-value" spellcheck="false" autocomplete="off" autocapitalize="none" required maxlength="100" placeholder="${walletMode ? 'Public address (SS58 or 0x…)' : '0x… transaction hash'}" value="${walletMode ? escapeHtml(lastAddress) : ''}"><button class="primary" type="submit"${busy ? ' disabled' : ''}>${busy ? 'Reading…' : 'Read evidence'}</button></div><p class="help">${walletMode ? 'The public address is sent to the Polkaswap server to read chain records.' : 'The hash is sent to the Polkaswap server to find the indexed transaction.'} No signing or wallet connection.</p><p id="form-error" class="form-error" role="status" hidden></p></div></form>`;
  lookupNode.innerHTML = current ? `<details${open ? ' open' : ''}><summary>Inspect another hash or wallet</summary><div class="detail-content">${form}</div></details>` : form;
}

function showFormError(message: string): void {
  const node = document.getElementById('form-error');
  if (node) { node.textContent = message; node.hidden = false; }
}

const tools: Record<string, string> = { transaction: 'explain_transaction', portfolio: 'get_portfolio', liquidity: 'get_liquidity_positions', history: 'get_account_history' };

async function callTool(mode: string, value: string, cursor?: unknown, baseAssetId?: unknown): Promise<void> {
  if (busy) return;
  if (mode === 'transaction' && !/^0x[0-9a-fA-F]{64}$/.test(value)) { showFormError('Enter a complete 0x-prefixed, 64-digit transaction hash.'); return; }
  if (mode !== 'transaction' && !/^(0x[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{46,50})$/.test(value)) { showFormError('Enter a public SORA2 address. Never enter a seed phrase or private key.'); return; }
  if (!connected && !window.openai?.callTool) { showFormError('Open this widget through the Polkaswap ChatGPT plugin to read live chain data.'); return; }
  const sequence = ++currentRequest;
  const baseAssetFilter = mode === 'liquidity' && typeof baseAssetId === 'string' && (baseAssetId === 'all' || /^0x[0-9a-fA-F]{64}$/.test(baseAssetId)) ? { baseAssetId } : {};
  const args: Record<string, unknown> = mode === 'transaction' ? { hash: value } : { address: value, ...(cursor ? { after: cursor } : {}), ...baseAssetFilter };
  if (mode !== 'transaction') lastAddress = value;
  busy = true;
  renderLookup(true);
  try {
    const output = connected ? await app.callServerTool({ name: tools[mode]!, arguments: args }) : await window.openai!.callTool!(tools[mode]!, args);
    if (sequence === currentRequest && !receiveToolResult(output)) showFormError('The source did not return a supported evidence result. Ask ChatGPT to inspect the tool response.');
  } catch {
    if (sequence === currentRequest) showFormError('The data request could not be completed. Try again or ask ChatGPT to check source availability.');
  } finally {
    busy = false;
    const button = lookupNode.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (button) { button.disabled = false; button.textContent = 'Read evidence'; }
    resizeCompatibility();
  }
}

lookupNode.addEventListener('click', (event) => {
  const target = (event.target as Element).closest<HTMLButtonElement>('[data-mode]');
  if (!target || busy) return;
  currentMode = target.dataset.mode!;
  renderLookup(true);
  lookupNode.querySelector<HTMLInputElement>('input')?.focus();
});
lookupNode.addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key) || !(event.target as Element).matches('[role="tab"]')) return;
  event.preventDefault();
  currentMode = currentMode === 'transaction' ? 'portfolio' : 'transaction';
  renderLookup(true);
  lookupNode.querySelector<HTMLButtonElement>(`[data-mode="${currentMode}"]`)?.focus();
});
lookupNode.addEventListener('change', (event) => {
  const target = event.target as HTMLSelectElement;
  if (target.id === 'wallet-view') currentMode = target.value;
});
lookupNode.addEventListener('submit', (event) => {
  event.preventDefault();
  const value = lookupNode.querySelector<HTMLInputElement>('#lookup-value')?.value.trim() ?? '';
  void callTool(currentMode, value);
});
resultNode.addEventListener('click', (event) => {
  const target = (event.target as Element).closest<HTMLButtonElement>('button');
  if (!target || !current) return;
  if (target.hasAttribute('data-copy-hash') && navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(valueText(current.data.hash, '')).then(() => { target.textContent = 'Copied'; }).catch(() => { target.textContent = 'Copy unavailable'; });
  }
  if (target.hasAttribute('data-next-page')) {
    const cursor = object(current.data.pagination).nextCursor;
    if (lastAddress) void callTool(current.kind, lastAddress, cursor, current.data.baseAssetId);
    else { renderLookup(true); showFormError('Enter the public address again to load the next history page.'); }
  }
});
document.addEventListener('toggle', resizeCompatibility, true);

app.ontoolresult = (result) => { receiveToolResult(result); };
app.onhostcontextchanged = (context) => { if (context.theme) setTheme(context.theme); };

// Legacy globals are read only through the documented host API and event.
// No arbitrary postMessage listener, browser network calls, or local persistence.
window.addEventListener('openai:set_globals', ((event: CustomEvent<{ globals?: OpenAICompatibility }>) => {
  const globals = event.detail?.globals;
  if (!globals) return;
  if (globals.theme) setTheme(globals.theme);
  if (globals.toolOutput !== undefined) receiveToolResult(globals.toolOutput);
}) as EventListener);

renderLookup(true);
setTheme(window.openai?.theme ?? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
if (window.openai?.toolOutput !== undefined) receiveToolResult(window.openai.toolOutput);

// Standalone previews retain a truthful welcome state. Fixtures are injected
// only by the QA harness through a mocked host, never by production defaults.
if (window.parent !== window) {
  void app.connect().then(() => {
    connected = true;
    const context = app.getHostContext();
    if (context?.theme) setTheme(context.theme);
  }).catch(() => { connected = false; resizeCompatibility(); });
}
