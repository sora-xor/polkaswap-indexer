export type EvidenceKind = 'transaction' | 'portfolio' | 'liquidity' | 'history' | 'status';
export interface Evidence {
  kind: EvidenceKind;
  status: 'ok' | 'unavailable' | 'not_found';
  title: string;
  summary: string;
  provenance: Record<string, unknown>;
  warnings: string[];
  data: Record<string, unknown>;
}

type RecordValue = Record<string, unknown>;
const kinds = new Set(['transaction', 'portfolio', 'liquidity', 'history', 'status']);
const statuses = new Set(['ok', 'unavailable', 'not_found']);
export const object = (value: unknown): RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
export const valueText = (value: unknown, fallback = 'Not reported'): string => value === null || value === undefined || value === '' ? fallback : typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean' ? String(value) : JSON.stringify(value).slice(0, 4000);
export const escapeHtml = (value: unknown): string => valueText(value, '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
const text = (value: unknown, fallback = 'Not reported') => escapeHtml(valueText(value, fallback));
const array = (value: unknown): RecordValue[] => Array.isArray(value) ? value.slice(0, 100).map(object) : [];
const compactId = (value: unknown) => { const id = valueText(value, 'Unknown asset'); return id.length > 23 ? `${id.slice(0, 10)}…${id.slice(-8)}` : id; };
const displayDecimal = (value: unknown) => valueText(value).replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');

export function parseEvidence(value: unknown): Evidence | null {
  const candidate = object(value);
  if (!kinds.has(valueText(candidate.kind)) || !statuses.has(valueText(candidate.status))) return null;
  return { kind: candidate.kind as EvidenceKind, status: candidate.status as Evidence['status'], title: valueText(candidate.title, 'Chain evidence'), summary: valueText(candidate.summary, ''), provenance: object(candidate.provenance), warnings: Array.isArray(candidate.warnings) ? candidate.warnings.slice(0, 30).map((warning) => valueText(warning, '')) : [], data: object(candidate.data) };
}

export function formatTime(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'Not reported';
  const date = new Date(typeof value === 'number' ? value : String(value));
  return Number.isNaN(date.getTime()) ? valueText(value) : date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

function fact(label: string, value: unknown, large = false): string {
  return `<div class="fact"><dt>${text(label)}</dt><dd${large ? ' class="large"' : ''}>${text(value)}</dd></div>`;
}

function disclosure(label: string, content: string, open = false): string {
  return `<details${open ? ' open' : ''}><summary>${text(label)}</summary><div class="detail-content">${content}</div></details>`;
}

function rawEvidence(value: unknown): string {
  const serialized = JSON.stringify(value, null, 2) ?? '{}';
  return `<pre>${escapeHtml(serialized.slice(0, 40000))}${serialized.length > 40000 ? '\n… Display truncated; complete evidence remains in the tool result.' : ''}</pre>`;
}

function transaction(data: RecordValue): string {
  const execution = object(data.execution);
  const fee = object(data.fee);
  const outcome = valueText(data.outcome, 'Outcome not reported');
  const lower = outcome.toLowerCase();
  const state = /success|succeeded/.test(lower) ? 'success' : /fail|error/.test(lower) ? 'failure' : 'warning';
  const feeValue = fee.decimal === null || fee.decimal === undefined ? 'Not reported' : `${displayDecimal(fee.decimal)} ${valueText(fee.symbol, '')}`.trim();
  const method = [valueText(data.module, ''), valueText(data.method, '')].filter(Boolean).join('.');
  const calls = array(object(data.calls).nodes ?? data.calls);
  return `<div class="status ${state}">${text(outcome)}</div>
    <div class="hash-line"><div><div class="label">Transaction hash</div><div class="mono">${text(data.hash)}</div></div>${data.hash ? '<button class="quiet" data-copy-hash type="button">Copy hash</button>' : ''}</div>
    <dl class="facts">${fact('Finalized block', data.blockHeight)}${fact('Network fee (reported)', feeValue, true)}${fact('Time', formatTime(data.timestamp))}${method ? fact('Call', method) : ''}${execution.error ? fact('Reported failure', execution.error) : ''}</dl>
    ${fee.atomic !== undefined && fee.atomic !== null ? `<p class="help">Network fee in chain units: <span class="mono">${text(fee.atomic)}</span>. Amounts are shown as reported; swap fees are separate from the network fee.</p>` : ''}
    ${disclosure('Execution & call evidence', rawEvidence({ fee, execution: data.execution, rawExecution: data.rawExecution, data: data.data, calls }))}`;
}

function portfolio(data: RecordValue): string {
  const assets = array(data.assets);
  if (!assets.length) return `<div class="empty"><strong>No balance rows returned</strong>This result does not establish that the wallet has no assets. Check the source coverage and warnings.</div>${nextPage(data)}`;
  const total = Array.isArray(data.assets) ? data.assets.length : assets.length;
  return `<div class="section-heading"><h2>Reported balances</h2><span class="count">${text(total)} ${total === 1 ? 'asset' : 'assets'}</span></div><table class="rows"><thead><tr><th scope="col">Asset</th><th scope="col" class="number">Free balance</th></tr></thead><tbody>${assets.map((asset) => `<tr><td><div class="asset"><span class="asset-mark" aria-hidden="true">${text(valueText(asset.symbol, '?').slice(0, 3))}</span><div><div class="asset-name">${text(asset.symbol, 'Unknown symbol')}</div><div class="asset-id mono" title="${text(asset.assetId, '')}">${text(compactId(asset.assetId))}</div></div></div></td><td class="number"><div class="amount">${text(asset.free)}</div><div class="balance-meta"><span>Reserved ${text(asset.reserved)}</span><span>Frozen ${text(asset.frozen)}</span></div></td></tr>`).join('')}</tbody></table><p class="help">Free, reserved, and frozen are chain balance categories. Frozen is a restriction on spending, not an additional balance.</p>${total > assets.length ? '<p class="help">The widget displays the first 100 rows. Refer to the tool result for the remaining rows.</p>' : ''}${data.chainFinalizedBlock !== undefined ? `<p class="help">Read at finalized chain block ${text(data.chainFinalizedBlock)}.</p>` : ''}${nextPage(data)}`;
}

function liquidity(data: RecordValue): string {
  const positions = array(data.positions);
  if (!positions.length) return `<div class="empty"><strong>No liquidity positions returned</strong>Check the source coverage and warnings before drawing conclusions about the wallet.</div>${nextPage(data)}`;
  return `<div class="section-heading"><h2>Liquidity positions</h2><span class="count">${text(positions.length)} returned</span></div>${positions.map((position) => {
    const base = object(position.baseAsset);
    const target = object(position.targetAsset);
    const baseSymbol = valueText(base.symbol ?? position.baseSymbol, '');
    const targetSymbol = valueText(target.symbol ?? position.targetSymbol, '');
    const baseId = valueText(base.assetId ?? position.baseAssetId ?? position.baseAsset, 'Base asset');
    const targetId = valueText(target.assetId ?? position.targetAssetId ?? position.targetAsset, 'Target asset');
    const baseLabel = baseSymbol || compactId(baseId);
    const targetLabel = targetSymbol || compactId(targetId);
    const proportionalBase = position.proportionalBaseAmount ?? position.baseAmount;
    const proportionalTarget = position.proportionalTargetAmount ?? position.targetAmount;
    const shares = position.poolTokenBalance ?? (position.poolTokensAtomic === undefined ? undefined : `${valueText(position.poolTokensAtomic)} atomic shares`);
    return `<div class="position"><div class="position-header"><div class="pair"><span title="${text(baseId)}">${text(baseLabel)}</span> <span class="subtle">/</span> <span title="${text(targetId)}">${text(targetLabel)}</span></div><div class="position-amount"><div class="label">Pool token balance</div><div class="amount">${text(shares)}</div></div></div>${position.sharePercent !== undefined && position.sharePercent !== null ? `<p class="help">Reported share ${text(position.sharePercent)}%</p>` : ''}${proportionalBase !== undefined || proportionalTarget !== undefined ? `<div class="position-meta"><span>Proportional reserve estimate: ${text(proportionalBase)} ${text(baseLabel)} · ${text(proportionalTarget)} ${text(targetLabel)}</span></div><p class="help">Based on reported pool reserves and token supply. This is not a withdrawal quote.</p>` : ''}<div class="mono">Pool ${text(position.poolId)}</div></div>`;
  }).join('')}<p class="help">Pool token balances describe the reported position. No return, profit, or tax calculation is implied.</p>${nextPage(data)}`;
}

function history(data: RecordValue): string {
  const items = array(data.items);
  if (!items.length) return `<div class="empty"><strong>No indexed activity returned</strong>This may reflect the history window or indexing coverage. It does not prove the wallet has no transaction history.</div>${nextPage(data)}`;
  return `<div class="section-heading"><h2>Indexed activity</h2><span class="count">${text(items.length)} on this page</span></div>${items.map((item) => { const name = [valueText(item.module, ''), valueText(item.method, '')].filter(Boolean).join('.'); return `<div class="history-item"><span class="history-dot" aria-hidden="true"></span><div class="history-main"><div class="history-title">${text(name, 'Indexed transaction')}</div><div class="history-meta"><span>Block ${text(item.blockHeight)}</span><span>${text(formatTime(item.timestamp))}</span>${item.networkFee !== undefined && item.networkFee !== null ? `<span>Fee (chain units) ${text(item.networkFee)}</span>` : ''}</div><div class="history-id mono">${text(item.id)}</div></div></div>`; }).join('')}${nextPage(data) || '<p class="help">End of the returned history page.</p>'}<p class="help">Indexed events are historical evidence. This page is not a complete cost-basis, profit, or tax report.</p>`;
}

function nextPage(data: RecordValue): string {
  const pagination = object(data.pagination);
  return pagination.hasNextPage !== false && pagination.nextCursor ? '<button type="button" class="quiet" data-next-page>Load next page →</button>' : '';
}

const provenanceLabels: Record<string, string> = { source: 'Data source', indexer: 'Indexer', chain: 'Chain', indexedBlock: 'Indexed block', indexedAt: 'Index time', retrievedAt: 'Retrieved', chainRetrievedAt: 'Chain read time', lagBlocks: 'Indexer lag (blocks)', finalizedBlock: 'Finalized block', chainFinalizedBlock: 'Chain block', historyWindow: 'History coverage', snapshotWindow: 'Snapshot coverage', unitInterpretation: 'Unit interpretation', limitations: 'Data limits' };

export function renderEvidence(result: Evidence): string {
  const dataView = result.status !== 'ok' ? `<div class="empty"><strong>${result.status === 'not_found' ? 'No matching record returned' : 'Source currently unavailable'}</strong>No missing data has been replaced with estimated amounts.</div>` : result.kind === 'transaction' ? transaction(result.data) : result.kind === 'portfolio' ? portfolio(result.data) : result.kind === 'liquidity' ? liquidity(result.data) : result.kind === 'history' ? history(result.data) : rawEvidence(result.data);
  const provenance = Object.entries(result.provenance).filter(([, value]) => value !== undefined && value !== null).map(([key, value]) => `<dt>${text(provenanceLabels[key] ?? key)}</dt><dd>${text(/At$/.test(key) ? formatTime(value) : value)}</dd>`).join('');
  const category = { transaction: 'Transaction evidence', portfolio: 'Public wallet', liquidity: 'Liquidity evidence', history: 'Account history', status: 'Data source status' }[result.kind];
  return `<div class="eyebrow">${category}</div><h1>${text(result.title)}</h1><p class="summary">${text(result.summary)}</p>${dataView}${result.warnings.length ? `<aside class="notice" aria-label="Data limits"><ul>${result.warnings.map((warning) => `<li>${text(warning)}</li>`).join('')}</ul></aside>` : ''}${disclosure('Source & freshness', `<dl class="provenance">${provenance || '<dt>Source</dt><dd>Not reported</dd>'}</dl>`)}`;
}
