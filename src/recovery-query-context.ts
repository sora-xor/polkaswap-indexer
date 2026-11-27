import { createHash } from 'node:crypto';
import { setMaxListeners } from 'node:events';
import { ApiPromise } from '@polkadot/api';
import type { ApiDecoration } from '@polkadot/api/types';
import { Metadata, TypeRegistry } from '@polkadot/types';
import type { Header, RuntimeVersion } from '@polkadot/types/interfaces';
import type { OverrideBundleType } from '@polkadot/types/types';
import type { ProviderInterface, ProviderInterfaceEmitCb, ProviderInterfaceEmitted } from '@polkadot/rpc-provider/types';
import { stringCamelCase } from '@polkadot/util';
import { blake2AsHex } from '@polkadot/util-crypto';
import { validateBurnRecoveryPolicy, type BurnRecoveryPolicy } from './burn-recovery.js';
import { recoveryMetadataWitness } from './recovery-metadata.js';
import { isNonzeroCanonicalSubstrateHash } from './soraIdentity.js';

/** The owner supplies its existing bounded provider; this adapter never owns its connection. */
export type RecoveryQueryRpc = <T = unknown>(method: string, params: unknown[]) => Promise<T>;
type Execute = <T>(request: () => Promise<T>, label: string) => Promise<T>;
type Proof = { hash: string; height: number; parentHash: string; header: unknown; version: RuntimeVersion;
  parentVersion: RuntimeVersion; metadata: `0x${string}`; metadataHash: string; executionCodeHash: string };
type Client = { api: ApiPromise; provider: PinnedReadProvider; fixedHash: string | null; storage: StorageEvidence };
export type StorageEvidence = { storageEntries: number; storageDeclarationsSha256: string };
export type RecoveryQueryContext = Pick<ApiDecoration<'promise'>, 'query' | 'registry' | 'runtimeVersion'> & {
  evidence: StorageEvidence & { block: number; hash: string; metadataHash: string; executionCodeHash: string;
    specVersion: number; fixedTransitionContext: boolean };
};
const RAW_LIMIT = 16 * 1024 * 1024;
const ASYNC_STORAGE_METHODS = ['hash', 'size', 'entries', 'entriesPaged', 'keys', 'keysPaged', 'multi'] as const;
const STORAGE_METHODS = ['state_getStorage', 'state_getStorageHash', 'state_getStorageSize', 'state_getKeysPaged', 'state_queryStorageAt'];
const INIT_METHODS = ['chain_getBlockHash', 'state_getRuntimeVersion', 'system_chain', 'system_properties', 'rpc_methods'];
const HEX = /^0x(?:[0-9a-f]{2})*$/;

/** Reject oversized/malformed wire values before creating a registry or retaining a response. */
function boundedJson(value: unknown): void {
  const json = JSON.stringify(value);
  if (json === undefined || Buffer.byteLength(json) > RAW_LIMIT) throw new Error('Recovery query RPC response exceeds bound');
}

/** Canonical full runtime identity, including versions other than the reused spec number. */
function runtimeVersion(value: unknown): RuntimeVersion {
  const v = value as Record<string, unknown>;
  if (!v || !['sora', 'sora-substrate'].includes(String(v.specName)) || typeof v.implName !== 'string' ||
      !Array.isArray(v.apis) || v.apis.length > 256 ||
      ['specVersion', 'implVersion', 'authoringVersion', 'transactionVersion', 'stateVersion'].some((key) =>
        !Number.isSafeInteger(v[key]) || Number(v[key]) < 0 || Number(v[key]) > 0xffffffff) ||
      v.apis.some((api) => !Array.isArray(api) || api.length !== 2 || !/^0x[0-9a-f]{16}$/.test(String(api[0])) ||
        !Number.isSafeInteger(api[1]) || api[1] < 0 || api[1] > 0xffffffff)) {
    throw new Error('Invalid recovery state runtime version');
  }
  return new TypeRegistry().createType('RuntimeVersion', value);
}

/** Compare every decorated storage declaration, including map hashers, optionality and defaults. */
export function validateRecoveryStorageContext(api: ApiPromise, at: ApiDecoration<'promise'>, raw: `0x${string}`): StorageEvidence {
  const expected = new Metadata(api.registry, raw);
  if (api.runtimeMetadata.toHex() !== raw || at.registry !== api.registry ||
      at.registry.metadata.toHex() !== expected.asLatest.toHex() ||
      at.runtimeVersion.toHex() !== api.runtimeVersion.toHex()) throw new Error('Recovery query registry differs from pinned state');
  const rows: string[][] = [];
  for (const pallet of expected.asLatest.pallets) {
    if (pallet.storage.isNone) continue;
    const storage = pallet.storage.unwrap();
    for (const item of storage.items) {
      const section = stringCamelCase(pallet.name.toString());
      const method = stringCamelCase(item.name.toString());
      const query = at.query[section]?.[method];
      if (typeof query !== 'function' || query.creator.meta.toHex() !== item.toHex() ||
          (item.type.isMap && typeof query.entriesPaged !== 'function')) {
        throw new Error(`Recovery storage declaration differs: ${section}.${method}`);
      }
      rows.push([section, method, storage.prefix.toString(), item.toHex()]);
    }
  }
  if (!rows.length) throw new Error('Recovery metadata has no storage declarations');
  return { storageEntries: rows.length,
    storageDeclarationsSha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex') };
}

/** Read-only, non-subscribing view of the owner's provider, initialized from a witnessed state. */
class PinnedReadProvider implements ProviderInterface {
  readonly hasSubscriptions = false;
  readonly isClonable = false;
  private closed = false;
  private readonly active = new Map<string, { proof: Proof; leases: number }>();
  constructor(private readonly manager: RecoveryQueryContexts, private readonly seed: Proof,
    private readonly chain: unknown, private readonly properties: unknown) {}
  get isConnected(): boolean { return !this.closed; }
  clone(): ProviderInterface { throw new Error('Recovery query provider cannot be cloned'); }
  async connect(): Promise<void> { if (this.closed) throw new Error('Recovery query provider is closed'); }
  async disconnect(): Promise<void> { this.closed = true; this.active.clear(); }
  on(_type: ProviderInterfaceEmitted, _callback: ProviderInterfaceEmitCb): () => void { return () => undefined; }
  async subscribe(): Promise<number> { throw new Error('Recovery query subscriptions are forbidden'); }
  async unsubscribe(): Promise<boolean> { throw new Error('Recovery query subscriptions are forbidden'); }

  /** Keep each captured proof alive through all internal registry lookups and paged storage RPCs. */
  async withProof<T>(proof: Proof, request: () => Promise<T>): Promise<T> {
    if (this.closed) throw new Error('Recovery query provider is closed');
    if (proof.metadataHash !== this.seed.metadataHash || proof.version.toHex() !== this.seed.version.toHex()) {
      throw new Error('Recovery query proof does not match isolated registry');
    }
    const known = this.active.get(proof.hash);
    if (!known && this.active.size >= 128) throw new Error('Recovery query active-state bound exceeded');
    const lease = known ?? { proof, leases: 0 };
    lease.leases++;
    this.active.set(proof.hash, lease);
    try { return await this.manager.bound(request(), 'historical storage query'); }
    finally { if (--lease.leases === 0) this.active.delete(proof.hash); }
  }

  async send<T>(method: string, params: unknown[]): Promise<T> {
    if (this.closed || this.manager.closed) throw new Error('Recovery query provider is closed');
    const result = await this.read(method, params);
    boundedJson(result);
    return result as T;
  }

  /** Only immutable initialization facts and explicitly leased hash-bound storage reads are exposed. */
  private async read(method: string, params: unknown[]): Promise<unknown> {
    if (method === 'chain_getBlockHash' && params.length === 1 && (params[0] === 0 || params[0] === '0x00000000')) return this.manager.genesisHash;
    if (method === 'state_getRuntimeVersion' && params.length === 0) return this.seed.version.toJSON();
    if (method === 'system_chain' && params.length === 0) return this.chain;
    if (method === 'system_properties' && params.length === 0) return this.properties;
    if (method === 'rpc_methods' && params.length === 0) return { version: 1, methods: [...INIT_METHODS, ...STORAGE_METHODS, 'chain_getHeader'] };
    if (method === 'chain_getHeader' && params.length === 1) {
      const proof = this.active.get(String(params[0]))?.proof;
      if (proof) return proof.header;
    }
    if (method === 'state_getRuntimeVersion' && params.length === 1) {
      // Public API registry reentry asks for the executing parent's actual version. Never invent it.
      const candidates = [...this.active.values()].map((v) => v.proof).filter((p) => p.parentHash === params[0]);
      if (candidates.length && candidates.every((p) => p.parentVersion.toHex() === this.seed.version.toHex())) {
        return candidates[0].parentVersion.toJSON();
      }
    }
    if (!STORAGE_METHODS.includes(method)) throw new Error(`Recovery query RPC is not allowed: ${method}`);
    const hash = params.at(-1);
    if (typeof hash !== 'string' || !this.active.has(hash)) throw new Error('Recovery storage RPC lacks an active exact-state proof');
    const validKey = (key: unknown) => typeof key === 'string' && HEX.test(key) && key.length <= 8194;
    if (method === 'state_getKeysPaged') {
      if (params.length !== 4 || !validKey(params[0]) || !Number.isSafeInteger(params[1]) ||
          Number(params[1]) < 1 || Number(params[1]) > 1000 || (params[2] !== null && !validKey(params[2]))) {
        throw new Error('Recovery storage pagination exceeds bound');
      }
    } else if (method === 'state_queryStorageAt') {
      if (params.length !== 2 || !Array.isArray(params[0]) || params[0].length > 1000 || !params[0].every(validKey)) {
        throw new Error('Recovery storage multi-read exceeds bound');
      }
    } else if (params.length !== 2 || !validKey(params[0])) throw new Error('Invalid recovery storage read');
    const result = await this.manager.raw(method, params);
    const validValue = (value: unknown) => value === null || (typeof value === 'string' && HEX.test(value));
    if (method === 'state_queryStorageAt') {
      const sets = result as Array<{ block?: unknown; changes?: unknown }>;
      const keys = params[0] as string[];
      if (!Array.isArray(sets) || sets.length !== 1 || sets[0]?.block !== hash || !Array.isArray(sets[0].changes) ||
          sets[0].changes.length !== keys.length || new Set(keys).size !== keys.length) {
        throw new Error('Recovery storage change-set identity differs');
      }
      const returned = new Set<string>();
      for (const change of sets[0].changes) {
        if (!Array.isArray(change) || change.length !== 2 || !keys.includes(change[0]) ||
            returned.has(change[0]) || !validValue(change[1])) throw new Error('Invalid recovery storage change-set values');
        returned.add(change[0]);
      }
    } else if (method === 'state_getKeysPaged') {
      if (!Array.isArray(result) || result.length > Number(params[1]) ||
          result.some((key, index) => !validKey(key) || !key.startsWith(String(params[0])) ||
            key <= String(index ? result[index - 1] : (params[2] ?? params[0])))) {
        throw new Error('Invalid recovery storage keys page');
      }
    } else if (method === 'state_getStorage') {
      if (!validValue(result)) throw new Error('Invalid recovery storage bytes');
    } else if (method === 'state_getStorageHash') {
      if (result !== null && (typeof result !== 'string' || !/^0x[0-9a-f]{64}$/.test(result))) {
        throw new Error('Invalid recovery storage hash');
      }
    } else if (result !== null && (!Number.isSafeInteger(result) || Number(result) < 0 || Number(result) > RAW_LIMIT)) {
      throw new Error('Invalid recovery storage size');
    }
    return result;
  }
}

/**
 * Isolated public ApiPromise clients keyed by exact witnessed metadata and full real runtime version.
 * No eviction: old/in-flight contexts remain usable until worker shutdown. A version-transition state
 * owns a fixed-hash client so the API's parent-version registry fallback can never repoint it.
 */
export class RecoveryQueryContexts {
  private readonly clients = new Map<string, Promise<Client>>();
  private readonly providers = new Set<PinnedReadProvider>();
  private readonly abort = new AbortController();
  private readonly identityRegistry = new TypeRegistry();
  private identity: Promise<{ chain: unknown; properties: unknown }> | null = null;
  readonly genesisHash: string;
  constructor(private readonly options: { policy: BurnRecoveryPolicy; rpc: RecoveryQueryRpc;
    execute: Execute; typesBundle?: OverrideBundleType; timeoutMs?: number; maximumClients?: number;
    readMetadata?: (stateHash: string, expectedMetadataHash: string) => Promise<unknown> }) {
    validateBurnRecoveryPolicy(options.policy);
    // Each bounded query/read has a cancellation listener; concurrency is enforced by the owner.
    setMaxListeners(512, this.abort.signal);
    this.genesisHash = options.policy.genesisHash;
    if (!Number.isInteger(this.timeout) || this.timeout < 1 || this.timeout > 120_000 ||
        !Number.isInteger(this.maximumClients) || this.maximumClients < 1 || this.maximumClients > 32) {
      throw new Error('Invalid recovery query resource bounds');
    }
  }
  get closed(): boolean { return this.abort.signal.aborted; }
  private get timeout(): number { return this.options.timeoutMs ?? 30_000; }
  private get maximumClients(): number { return this.options.maximumClients ?? 16; }

  /** Add a cancellation/deadline boundary without taking ownership of the shared transport. */
  async bound<T>(request: Promise<T>, label: string): Promise<T> {
    if (this.closed) { void request.catch(() => undefined); throw new Error('Recovery queries cancelled'); }
    return new Promise<T>((resolve, reject) => {
      const finish = (error: unknown, value?: T) => {
        clearTimeout(timer); this.abort.signal.removeEventListener('abort', cancel);
        if (error) reject(error); else resolve(value as T);
      };
      const cancel = () => finish(new Error('Recovery queries cancelled'));
      const timer = setTimeout(() => finish(new Error(`${label} exceeded recovery query deadline`)), this.timeout);
      timer.unref?.();
      this.abort.signal.addEventListener('abort', cancel, { once: true });
      void request.then((value) => finish(null, value), (error: unknown) => finish(error));
    });
  }

  /** Every owner-provider call uses the worker's existing admission and RPC timeout budget. */
  async raw<T = unknown>(method: string, params: unknown[]): Promise<T> {
    if (this.closed) throw new Error('Recovery queries cancelled');
    if (![...INIT_METHODS, ...STORAGE_METHODS, 'chain_getHeader', 'state_getMetadata'].includes(method)) {
      throw new Error(`Recovery raw RPC is not allowed: ${method}`);
    }
    const result = await this.bound(this.options.execute(() => this.options.rpc<T>(method, params),
      `recovery query ${method}`), method);
    boundedJson(result);
    return result;
  }

  private async chainIdentity(): Promise<{ chain: unknown; properties: unknown }> {
    if (!this.identity) {
      const deadline = Date.now() + this.timeout;
      const pending = (async () => {
        const genesis = await this.raw('chain_getBlockHash', [0]);
        this.checkDeadline(deadline);
        if (genesis !== this.genesisHash) throw new Error('Recovery query genesis mismatch');
        const chain = await this.raw('system_chain', []);
        this.checkDeadline(deadline);
        const properties = await this.raw('system_properties', []);
        this.checkDeadline(deadline);
        if (typeof chain !== 'string' || chain.length > 128 || !properties || typeof properties !== 'object') {
          throw new Error('Invalid recovery chain properties');
        }
        return { chain, properties };
      })();
      this.identity = pending;
      void pending.catch(() => { if (this.identity === pending) this.identity = null; });
    }
    return this.identity;
  }

  /** Do not begin another evidence read after the enclosing finite capture deadline. */
  private checkDeadline(deadline: number): void {
    if (this.closed) throw new Error('Recovery queries cancelled');
    if (Date.now() >= deadline) throw new Error('Recovery state capture exceeded deadline');
  }

  private async proof(hash: string, deadline: number): Promise<Proof> {
    const read: RecoveryQueryRpc = async <T>(method: string, params: unknown[]) => {
      this.checkDeadline(deadline);
      const value = await this.raw<T>(method, params);
      this.checkDeadline(deadline);
      return value;
    };
    if (!isNonzeroCanonicalSubstrateHash(hash)) throw new Error('Invalid recovery state hash');
    const rawHeader = await read('chain_getHeader', [hash]);
    const header = this.identityRegistry.createType<Header>('Header', rawHeader);
    const height = header.number.toNumber();
    if (!Number.isSafeInteger(height) || height < 1 || header.hash.toHex() !== hash ||
        !isNonzeroCanonicalSubstrateHash(header.parentHash.toHex()) ||
        await read('chain_getBlockHash', [height]) !== hash) throw new Error('Recovery state is not the requested canonical header');
    const witness = recoveryMetadataWitness(this.options.policy, height + 1);
    this.checkDeadline(deadline);
    const metadata = this.options.readMetadata
      ? await this.bound(this.options.readMetadata(hash, witness.metadataHash), 'state_getMetadata')
      : await read('state_getMetadata', [hash]);
    this.checkDeadline(deadline);
    if (typeof metadata !== 'string' || !HEX.test(metadata) || metadata.length > RAW_LIMIT ||
        blake2AsHex(metadata, 256) !== witness.metadataHash) throw new Error('Recovery state metadata witness mismatch');
    const version = runtimeVersion(await read('state_getRuntimeVersion', [hash]));
    const parentHash = header.parentHash.toHex();
    const parentVersion = runtimeVersion(await read('state_getRuntimeVersion', [parentHash]));
    return { hash, height, parentHash, header: rawHeader, version, parentVersion,
      metadata: metadata as `0x${string}`, metadataHash: witness.metadataHash, executionCodeHash: witness.executionCodeHash };
  }

  private async createClient(proof: Proof, fixedHash: string | null): Promise<Client> {
    const { chain, properties } = await this.chainIdentity();
    const provider = new PinnedReadProvider(this, proof, chain, properties);
    this.providers.add(provider);
    const creation = Promise.resolve().then(() => ApiPromise.create({ provider, registry: new TypeRegistry(), noInitWarn: true, throwOnConnect: true,
      metadata: { [`${this.genesisHash}-${proof.version.specVersion}`]: proof.metadata },
      ...(this.options.typesBundle ? { typesBundle: this.options.typesBundle } : {}) }));
    let api: ApiPromise | undefined;
    try {
      api = await this.bound(creation, 'isolated recovery API initialization');
      const at = await provider.withProof(proof, () => api!.at(proof.hash, proof.version));
      const storage = validateRecoveryStorageContext(api, at, proof.metadata);
      if (api.runtimeVersion.toHex() !== proof.version.toHex() || api.genesisHash.toHex() !== this.genesisHash ||
          JSON.stringify(api.registry.getChainProperties()?.toJSON()) !== JSON.stringify(this.identityRegistry.createType('ChainProperties', properties).toJSON())) {
        throw new Error('Recovery query initialized with different chain/runtime properties');
      }
      return { api, provider, fixedHash, storage };
    } catch (error) {
      await provider.disconnect();
      this.providers.delete(provider);
      void creation.then((late) => late.disconnect(), () => undefined).catch(() => undefined);
      throw error;
    }
  }

  /** Capture a state only after independently checking header, canonical height and next-execution witness. */
  async at(hash: string): Promise<RecoveryQueryContext> {
    return this.bound(this.capture(hash), 'recovery state capture');
  }

  private async capture(hash: string): Promise<RecoveryQueryContext> {
    const deadline = Date.now() + this.timeout;
    const proof = await this.proof(hash, deadline);
    const fixedHash = proof.version.toHex() === proof.parentVersion.toHex() ? null : hash;
    const key = `${proof.metadataHash}:${proof.version.toHex()}:${fixedHash ?? 'stable'}`;
    let pending = this.clients.get(key);
    if (!pending) {
      if (this.clients.size >= this.maximumClients) throw new Error('Recovery query client cache bound exceeded');
      pending = this.createClient(proof, fixedHash);
      this.clients.set(key, pending);
      const captured = pending;
      void pending.catch(() => { if (this.clients.get(key) === captured) this.clients.delete(key); });
    }
    const client = await pending;
    this.checkDeadline(deadline);
    if (client.fixedHash && client.fixedHash !== hash) throw new Error('Recovery transition context cannot be repointed');
    return client.provider.withProof(proof, async () => {
      const at = await client.api.at(hash, proof.version);
      if (at.registry !== client.api.registry || at.runtimeVersion.toHex() !== proof.version.toHex()) {
        throw new Error('Recovery query reused the wrong registry');
      }
      return { query: this.wrapQuery(at.query, client.provider, proof), registry: at.registry, runtimeVersion: at.runtimeVersion,
        evidence: { ...client.storage, block: proof.height, hash, metadataHash: proof.metadataHash,
          executionCodeHash: proof.executionCodeHash, specVersion: proof.version.specVersion.toNumber(),
          fixedTransitionContext: fixedHash !== null } };
    });
  }

  /** Preserve normal storage codecs/key helpers; only async reads acquire the captured proof lease. */
  private wrapQuery(query: ApiDecoration<'promise'>['query'], provider: PinnedReadProvider, proof: Proof): ApiDecoration<'promise'>['query'] {
    const wrapped = Object.create(null) as ApiDecoration<'promise'>['query'];
    for (const [section, methods] of Object.entries(query)) {
      wrapped[section] = Object.create(null) as typeof methods;
      for (const [name, method] of Object.entries(methods)) {
        const call = ((...args: unknown[]) => provider.withProof(proof, () => Reflect.apply(method, undefined, args))) as typeof method;
        Object.assign(call, method);
        for (const member of ASYNC_STORAGE_METHODS) {
          const read = method[member];
          if (typeof read === 'function') Object.assign(call, {
            [member]: (...args: unknown[]) => provider.withProof(proof, () => Reflect.apply(read, undefined, args)),
          });
        }
        wrapped[section][name] = call;
      }
    }
    return wrapped;
  }

  /** Cancel all adapter operations and disconnect only its non-owning facades. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.abort.abort();
    await Promise.all([...this.providers].map((provider) => provider.disconnect()));
    for (const pending of this.clients.values()) void pending.then((client) => client.api.disconnect(), () => undefined).catch(() => undefined);
    this.clients.clear(); this.providers.clear();
  }
}
