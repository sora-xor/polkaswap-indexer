import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { decodeAddress, encodeAddress } from '@polkadot/util-crypto';
import { z } from 'zod';
import { ChainReader, XOR_ID, type PoolMetadata } from './chain.js';
import { IndexerReader, unavailable, type Evidence, type Row } from './indexer.js';
import { ConcurrencyLimit } from './limits.js';

export const UI_URI = 'ui://polkaswap-evidence/v1.html';
export const HASH_SCHEMA = z.string().regex(/^0x[0-9a-fA-F]{64}$/).describe('SORA2 transaction hash: 0x followed by 64 hexadecimal characters');
export function canonicalAddress(address: string): string { return encodeAddress(decodeAddress(address), 69); }
export const ADDRESS_SCHEMA = z.string().min(40).max(70).refine(value => { try { return decodeAddress(value).length === 32; } catch { return false; } }, 'Provide a valid public SS58 account address').describe('Public SORA2 account address; never a private key, seed or wallet password');
const PAGINATION = { first: z.number().int().min(1).max(50).default(25), after: z.string().min(1).max(2048).optional().describe('Opaque nextCursor from the same tool and public address') };
const OUTPUT = { kind: z.enum(['transaction', 'portfolio', 'liquidity', 'history', 'status']), status: z.enum(['ok', 'unavailable', 'not_found']), title: z.string(), summary: z.string(), provenance: z.record(z.unknown()), warnings: z.array(z.string()), data: z.record(z.unknown()) };
const ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: true };
const iso = (value: unknown): unknown => typeof value === 'number' && Number.isFinite(value) ? new Date(value * 1000).toISOString() : value;
function normalize(result: Evidence): Evidence {
  const data = { ...result.data };
  if (typeof data.timestamp === 'number') { data.timestampUnix = data.timestamp; data.timestamp = iso(data.timestamp); }
  if (Array.isArray(data.items)) data.items = data.items.map(item => { const row = item as Row; return { ...row, timestampUnix: row.timestamp, timestamp: iso(row.timestamp) }; });
  const provenance = { ...result.provenance };
  if (typeof provenance.indexedAt === 'number') { provenance.indexedTimestampUnix = provenance.indexedAt; provenance.indexedAt = iso(provenance.indexedAt); }
  return { ...result, data, provenance };
}

export interface Readers { indexer: IndexerReader; chain: ChainReader }
/** All operations have fixed read-only implementations and work without a widget. */
export function createMcpServer(widget: string, readers: Readers, publicBaseUrl: string, limit = new ConcurrencyLimit()): McpServer {
  const server = new McpServer({ name: 'polkaswap-evidence', version: '0.1.0' }, { instructions: 'Read-only SORA2 evidence. Use only a public address or transaction hash supplied by the user. Report sources, finalized/indexed block and freshness. Missing data never means zero or failure. Preserve raw amounts, precision and denomination. Never interpret placeholder error codes, calculate tax/P&L, recommend trades, request wallet secrets or execute transfers.' });
  registerAppResource(server, 'polkaswap-evidence', UI_URI, {}, async () => ({ contents: [{ uri: UI_URI, mimeType: RESOURCE_MIME_TYPE, text: widget, _meta: { ui: { domain: new URL(publicBaseUrl).origin, prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } }, 'openai/widgetDescription': 'Polkaswap read-only transaction, public-wallet and liquidity evidence with source and freshness.' } }] }));
  const run = async (kind: Evidence['kind'], job: () => Promise<Evidence>) => {
    let result: Evidence;
    try { result = normalize(await limit.run(job)); } catch { result = unavailable(kind); }
    return { structuredContent: result, content: [{ type: 'text' as const, text: `${result.summary}\n${result.warnings.join('\n')}` }], ...(result.status === 'unavailable' ? { isError: true } : {}) };
  };
  const metadata = { securitySchemes: [{ type: 'noauth' }], ui: { resourceUri: UI_URI }, 'openai/toolInvocation/invoking': 'Reading public SORA2 evidence', 'openai/toolInvocation/invoked': 'Public evidence ready' };
  registerAppTool(server, 'explain_transaction', { title: 'Explain a SORA2 transaction', description: 'Use this when the user supplies a SORA2 transaction hash and wants its indexed outcome, historical fee and call evidence. Fee atoms and fixed-precision amount are reported separately; historical display denomination and actual failure cause may be unavailable. No execution or advice.', inputSchema: { hash: HASH_SCHEMA }, outputSchema: OUTPUT, annotations: ANNOTATIONS, _meta: metadata }, async ({ hash }) => run('transaction', () => readers.indexer.transaction(hash.toLowerCase())));
  registerAppTool(server, 'get_account_history', { title: 'Read public account activity', description: 'Use this when the user asks for indexed historical signer activity for a supplied public SORA2 address. Paginated newest first. Incoming/event-only activity may be absent. Fees are raw atomic XOR; history is not complete accounting or P&L.', inputSchema: { address: ADDRESS_SCHEMA, ...PAGINATION }, outputSchema: OUTPUT, annotations: ANNOTATIONS, _meta: metadata }, async ({ address, first, after }) => run('history', () => readers.indexer.history(canonicalAddress(address), first, after)));
  registerAppTool(server, 'get_portfolio', { title: 'Read public wallet holdings', description: 'Use this when the user supplies a public SORA2 address and asks for current token holdings. Reads native XOR on the first page and account-scoped token-storage pages at one finalized block. Follow nextCursor for more token entries; it expires after restart or pruned chain state. Atomic and precision-based amounts are preserved. LP shares, vaults and other account-specific storage are separate; no valuations or investment advice.', inputSchema: { address: ADDRESS_SCHEMA, ...PAGINATION }, outputSchema: OUTPUT, annotations: ANNOTATIONS, _meta: metadata }, async ({ address, first, after }) => run('portfolio', async () => {
    const account = canonicalAddress(address);
    const chain = await readers.chain.walletPortfolio(account, first, after);
    const assets = chain.data.map(asset => ({ ...asset, ...asset.amounts }));
    return { kind: 'portfolio', status: 'ok', title: 'Public wallet holdings', summary: `Returned ${assets.length} balance rows after checking ${chain.pagination.nativeIncluded ? "native XOR and " : ""}${chain.pagination.scannedTokenEntries} account token-storage entries at finalized block ${chain.provenance.blockHeight}.`,
      provenance: { source: chain.provenance.source, retrievedAt: chain.provenance.fetchedAt, chain: 'SORA2 mainnet', genesisHash: chain.provenance.genesisHash, chainEndpoint: chain.provenance.endpoint, chainFinalizedBlock: chain.provenance.blockHeight, chainBlockHash: chain.provenance.blockHash, chainTimestamp: iso(chain.provenance.timestamp), currentDenomination: chain.provenance.denominator, unitInterpretation: chain.provenance.unitInterpretation }, warnings: chain.warnings, data: { address: account, assets, unresolvedAssets: chain.unresolvedAssets, chainFinalizedBlock: chain.provenance.blockHeight, pagination: chain.pagination } };
  }));
  registerAppTool(server, 'get_liquidity_positions', { title: 'Read public liquidity positions', description: 'Use this when the user asks for current Pool XYK provider shares for a supplied public SORA2 address. Reads one indexed pool-registry page at a finalized chain block. Defaults to XOR-base pools; use baseAssetId=all or a supplied base asset ID for other pools. Reserve shares are rounded-down estimates excluding fees and chameleon reserves, not withdrawal quotes. Follow nextCursor. Does not calculate historical P&L or recommend pools.', inputSchema: { address: ADDRESS_SCHEMA, baseAssetId: z.union([HASH_SCHEMA, z.literal('all')]).default(XOR_ID).describe('Base asset filter; defaults to native XOR. Use all for every indexed base asset, or a supplied asset ID.'), ...PAGINATION }, outputSchema: OUTPUT, annotations: ANNOTATIONS, _meta: metadata }, async ({ address, baseAssetId, first, after }) => run('liquidity', async () => {
    const account = canonicalAddress(address);
    const { page, provenance } = await readers.indexer.pools(first, after, baseAssetId === 'all' ? undefined : baseAssetId.toLowerCase());
    const chain = await readers.chain.liquidity(account, page.nodes as unknown as PoolMetadata[]);
    const positions = chain.data.map(position => ({ ...position, poolTokenBalance: `${position.poolTokensAtomic} atomic shares`, baseAsset: position.baseAssetId, targetAsset: position.targetAssetId, baseAmount: position.proportionalBaseAmount, targetAmount: position.proportionalTargetAmount }));
    return { kind: 'liquidity', status: 'ok', title: 'Public liquidity positions', summary: `Returned ${positions.length} nonzero positions from ${page.nodes.length} checked pools at finalized block ${chain.provenance.blockHeight}.`, provenance: { ...provenance, chainSource: chain.provenance.source, chainEndpoint: chain.provenance.endpoint, chainFinalizedBlock: chain.provenance.blockHeight, chainBlockHash: chain.provenance.blockHash, chainTimestamp: iso(chain.provenance.timestamp), currentDenomination: chain.provenance.denominator, unitInterpretation: chain.provenance.unitInterpretation, chainRetrievedAt: chain.provenance.fetchedAt }, warnings: [...chain.warnings, ...(baseAssetId !== 'all' ? ['This query covers only the selected base asset. Other base assets require a separate query or baseAssetId=all.'] : []), ...(page.pageInfo.hasNextPage ? ['More pools remain; follow nextCursor to inspect them.'] : [])], data: { address: account, positions, baseAssetId, checkedPoolCount: page.nodes.length, pagination: { hasNextPage: page.pageInfo.hasNextPage, nextCursor: page.pageInfo.endCursor } } };
  }));
  return server;
}
