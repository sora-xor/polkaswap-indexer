/** Bounded read-only access to the production SORA2 indexer. */
export const GENESIS = '0x7e4e32d0feafd4f9c9414b0be86373f9a1efa904809b683453a9af6856d38ad5';
export type Row = Record<string, unknown>;
export interface Page<T = Row> { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null }; totalCount?: number }
export interface Provenance extends Row { source: string; retrievedAt: string }
export interface Evidence extends Row {
  kind: 'transaction' | 'portfolio' | 'liquidity' | 'history' | 'status';
  status: 'ok' | 'unavailable' | 'not_found'; title: string; summary: string;
  provenance: Provenance; warnings: string[]; data: Row;
}
const HEALTH = `_health { ok repositoryReady network chainId readOnly genesisHash latestIndexedBlock latestIndexedAt workerReady workerLag }`;
const HISTORY_FIELDS = 'id timestamp blockHeight blockHash module method address networkFee execution data calls { nodes { module method data } }';
const PAGE = 'pageInfo { hasNextPage endCursor } totalCount';

/** Render atomic integers exactly; never round token amounts through Number. */
export function atomicDecimal(value: string, decimals = 18): string {
  if (!/^\d+$/.test(value) || !Number.isInteger(decimals) || decimals < 0 || decimals > 38) throw new Error('Invalid atomic amount');
  const normalized = BigInt(value).toString();
  if (!decimals) return normalized;
  const digits = normalized.padStart(decimals + 1, '0');
  const fraction = digits.slice(-decimals).replace(/0+$/, '');
  return `${digits.slice(0, -decimals)}${fraction ? '.' + fraction : ''}`;
}

/** Restrict upstream calls to configured HTTPS or operator-selected loopback URLs. */
export function validateIndexerUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))) throw new Error('Indexer must use HTTPS or loopback HTTP without credentials');
  return url.href;
}

export class IndexerReader {
  readonly url: string;
  constructor(url = process.env.INDEXER_URL ?? 'https://pi.soramitsu.io/graphql', private fetcher: typeof fetch = fetch) { this.url = validateIndexerUrl(url); }
  /** Never accepts model-authored GraphQL, arbitrary URLs or mutations. */
  private async query(query: string, variables: Row): Promise<Row> {
    const response = await this.fetcher(this.url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(12_000), redirect: 'error',
    });
    if (!response.ok) throw new Error('Indexer unavailable');
    const text = await response.text();
    if (text.length > 2_000_000) throw new Error('Indexer response exceeded limit');
    const payload = JSON.parse(text) as { data?: Row; errors?: unknown[] };
    if (payload.errors?.length || !payload.data) throw new Error('Indexer query unsupported or unavailable');
    const health = payload.data._health as Row | undefined;
    if (!health?.ok || !health.repositoryReady || health.network !== 'mainnet' || health.chainId !== 'sora:mainnet' || health.readOnly !== true || (health.genesisHash && health.genesisHash !== GENESIS)) throw new Error('Indexer identity or readiness not verified');
    return payload.data;
  }
  private provenance(health: Row): Provenance {
    return { source: this.url, chain: 'SORA2 mainnet', genesisHash: health.genesisHash ?? null,
      indexedBlock: health.latestIndexedBlock ?? null, indexedAt: health.latestIndexedAt ?? null,
      lagBlocks: health.workerLag ?? null, workerReady: health.workerReady ?? null, retrievedAt: new Date().toISOString() };
  }
  /** Lookup one immutable transaction hash. Missing records are never treated as failures. */
  async transaction(hash: string): Promise<Evidence> {
    const result = await this.query(`query Transaction($hash:String!){${HEALTH} historyElements(first:1,filter:{id:{equalTo:$hash}}){nodes{${HISTORY_FIELDS}}}}`, { hash });
    const record = (result.historyElements as Page).nodes[0];
    const provenance = this.provenance(result._health as Row);
    if (!record) return { kind: 'transaction', status: 'not_found', title: 'Transaction not indexed', summary: 'No matching finalized SORA2 history record was returned. This does not establish whether the transaction was submitted, pending, failed, or on another network.', provenance, warnings: ['The indexer may be behind or have incomplete history.'], data: { hash } };
    const execution = record.execution as Row | null;
    const outcome = execution?.success === true ? 'succeeded' : execution?.success === false ? 'failed' : 'unknown';
    const fee = typeof record.networkFee === 'string' && /^\d+$/.test(record.networkFee) ? { atomic: record.networkFee, decimal: atomicDecimal(record.networkFee), symbol: 'XOR', precision: 18, basis: 'Indexer xorFee.FeeWithdrawn; fixed precision, historical display denomination unverified' } : null;
    const warnings = ['Amounts in transaction data are indexer-reported; fields may derive from call arguments when events are absent. They are not verified recipient balance changes.', 'Execution describes the outer extrinsic. Batch or nested calls may fail even when the outer extrinsic succeeds.', 'Fee decimal is the fixed-precision chain amount. Historical display denomination is unavailable; do not apply the current denomination to this fee.'];
    if (outcome === 'failed') warnings.push('The indexer uses placeholder module error indices. The actual dispatch cause is unavailable from this record.');
    warnings.push('Payload amounts describe requested or indexer-reported values; failed calls do not establish any transfer. Historical USD fields are indexer valuation estimates, not observed chain prices or accounting evidence.');
    if (!(result._health as Row).workerReady || Number((result._health as Row).workerLag ?? 0) > 100) warnings.push('Indexer freshness is degraded.');
    return { kind: 'transaction', status: 'ok', title: `${record.module}.${record.method}`, summary: `Indexed outer extrinsic ${outcome} at block ${record.blockHeight}.`, provenance, warnings,
      data: { ...record, hash: record.id, outcome: `outer extrinsic ${outcome}`, outerExtrinsicOutcome: outcome, nestedCallOutcomes: "unverified", fee, failureCause: null, execution: { success: execution?.success ?? null }, rawExecution: execution } };
  }
  /** Exact-address filtered cursor reads; cursors remain bound to address and order. */
  async history(address: string, first: number, after?: string): Promise<Evidence> {
    const result = await this.query(`query History($address:String!,$first:Int!,$after:Cursor){${HEALTH} historyElements(first:$first,after:$after,orderBy:[TIMESTAMP_DESC],filter:{address:{equalTo:$address}}){nodes{${HISTORY_FIELDS}} ${PAGE}}}`, { address, first, after: after ?? null });
    const page = result.historyElements as Page;
    return { kind: 'history', status: 'ok', title: 'Account activity', summary: `Returned ${page.nodes.length} indexed activity records.`, provenance: this.provenance(result._health as Row),
      warnings: ['History covers indexed signer activity. Incoming transfers and event-only account involvement may be absent.', 'Call amounts can be requested values rather than settled movements; USD fields are unverified indexer valuation estimates. Outer success does not verify nested calls.', 'No cost basis, profit/loss, complete wallet reconciliation or tax calculation is provided. Historical availability depends on indexer coverage and retention.'],
      data: { address, items: page.nodes, pagination: { hasNextPage: page.pageInfo.hasNextPage, nextCursor: page.pageInfo.endCursor }, indexedRecordCount: page.totalCount } };
  }
  async assets(first: number, after?: string): Promise<{ page: Page; provenance: Provenance }> {
    const result = await this.query(`query Assets($first:Int!,$after:Cursor){${HEALTH} assets(first:$first,after:$after,orderBy:[ID_DESC]){nodes{id} ${PAGE}}}`, { first, after: after ?? null });
    return { page: result.assets as Page, provenance: this.provenance(result._health as Row) };
  }
  async pools(first: number, after?: string, baseAssetId?: string): Promise<{ page: Page; provenance: Provenance }> {
    const result = await this.query(`query Pools($first:Int!,$after:Cursor${baseAssetId ? ",$base:String!" : ""}){${HEALTH} poolXYKs(first:$first,after:$after,orderBy:[ID_DESC]${baseAssetId ? ",filter:{baseAssetId:{equalTo:$base}}" : ""}){nodes{id baseAssetId targetAssetId} ${PAGE}}}`, { first, after: after ?? null, ...(baseAssetId ? { base: baseAssetId } : {}) });
    return { page: result.poolXYKs as Page, provenance: this.provenance(result._health as Row) };
  }
}

/** Consistent failure output with no upstream secrets or fabricated values. */
export function unavailable(kind: Evidence['kind']): Evidence {
  return { kind, status: 'unavailable', title: 'Data unavailable', summary: 'The required public data source could not be verified or read. Retry later; no balances or outcomes have been inferred.', provenance: { source: 'SORA2 public indexer / finalized chain', retrievedAt: new Date().toISOString() }, warnings: ['Missing data is not a zero balance or a failed transaction.'], data: {} };
}
