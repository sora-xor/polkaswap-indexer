import { afterEach, describe, expect, it, vi } from 'vitest';
import { readConfig } from '../src/config.js';
afterEach(() => vi.unstubAllEnvs());
describe('runtime configuration boundary admission', () => {
  it('defaults storage pages to 256 entries and accepts the archive limit', () => {
    vi.stubEnv('CHAIN_DERIVED_STORAGE_ENTRIES_PAGE_SIZE', undefined);
    expect(readConfig().derivedStorageEntriesPageSize).toBe(256);
    vi.stubEnv('CHAIN_DERIVED_STORAGE_ENTRIES_PAGE_SIZE', '1000');
    expect(readConfig().derivedStorageEntriesPageSize).toBe(1000);
    vi.stubEnv('CHAIN_DERIVED_STORAGE_ENTRIES_PAGE_SIZE', '1');
    expect(readConfig().derivedStorageEntriesPageSize).toBe(1);
  });
  it.each(['0', '-1', '1.5', '1001', 'NaN', 'Infinity', '  '])('rejects invalid storage page size %s', value => {
    vi.stubEnv('CHAIN_DERIVED_STORAGE_ENTRIES_PAGE_SIZE', value);
    expect(readConfig).toThrow(/CHAIN_DERIVED_STORAGE_ENTRIES_PAGE_SIZE/);
  });

  it.each([
    ['ROCKSDB_COMPACTION_MIN_FREE_GB', '   ', /must not be empty/],
    ['DATABASE_URL', 'postgres://localhost/db?sslmode=verify-full&sslnegotiation=invalid', /sslnegotiation/],
    ['HOST', 'a'.repeat(254), /hostname/], ['HOST', 'a'.repeat(64) + '.example', /hostname/],
    ['HOST', 'a..example', /hostname/], ['HOST', 'bad_name.example', /hostname/],
    ['HOST', '-bad.example', /hostname/], ['HOST', 'bad-.example', /hostname/],
    ['SORA_WS_ENDPOINT', 'wss://ws.sora2.soramitsu.co.jp#fragment', /fragment/],
  ])('rejects %s=%s', (name, value, expected) => {
    if (name === 'DATABASE_URL') vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv(name as string, value as string); expect(readConfig).toThrow(expected as RegExp);
  });
  it.each(['direct', 'postgres'])('accepts the explicitly supported PostgreSQL TLS negotiation %s', mode => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DATABASE_URL', `postgres://localhost/db?sslmode=verify-full&sslnegotiation=${mode}`);
    expect(readConfig().databaseUrl).toContain(`sslnegotiation=${mode}`);
  });
  it.each(['CHAIN_BACKFILL_PREFETCH_CONCURRENCY', 'CHAIN_FINALIZED_CATCHUP_PREFETCH_CONCURRENCY'])('requires RPC capacity for every %s prefetch', name => {
    vi.stubEnv(name, '30'); vi.stubEnv('CHAIN_RPC_MAX_IN_FLIGHT', '64'); expect(readConfig).toThrow(/3 times/);
    vi.stubEnv('CHAIN_RPC_MAX_IN_FLIGHT', '90'); expect(readConfig().chainRpcMaxInFlight).toBe(90);
  });
});
