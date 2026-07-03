import { describe, expect, it, vi } from 'vitest';

import { normalizeGraphqlUrl, runProductionSmoke } from '../src/scripts/production-smoke.js';

const validHealth = {
  ok: true,
  service: 'polkaswap-indexer',
  serviceId: 'pi.soramitsu.io',
  schemaVersion: 1,
  ecosystem: 'sora2',
  chainId: 'sora:mainnet',
  network: 'mainnet',
  publicBaseUrl: 'https://pi.soramitsu.io/graphql',
  readOnly: true,
};

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

const fetchWithHealth = (health: Record<string, unknown>) =>
  vi.fn(async () => jsonResponse({ data: { _health: health } }));

describe('Polkaswap production smoke', () => {
  it('normalizes host-only endpoints to the GraphQL path', () => {
    expect(normalizeGraphqlUrl('https://pi.soramitsu.io').toString()).toBe('https://pi.soramitsu.io/graphql');
  });

  it('rejects credentialed endpoints before making requests', async () => {
    const fetchImpl = fetchWithHealth(validHealth);

    await expect(runProductionSmoke('https://user:pass@pi.soramitsu.io/graphql', fetchImpl)).rejects.toThrow(
      'must not contain credentials'
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('passes when the production endpoint returns the PI/SORA2 health contract', async () => {
    const fetchImpl = fetchWithHealth(validHealth);

    await runProductionSmoke('https://pi.soramitsu.io/graphql', fetchImpl);

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('https://pi.soramitsu.io/graphql');
    expect(init?.method).toBe('POST');
    expect(String(init?.body)).toContain('_health');
  });

  it('rejects GraphQL errors even when HTTP status is successful', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ errors: [{ message: 'resolver failed' }] }));

    await expect(runProductionSmoke('https://pi.soramitsu.io/graphql', fetchImpl)).rejects.toThrow(
      /GraphQL endpoint returned errors: .*resolver failed.*Production routing must serve the polkaswap-indexer GraphQL API/
    );
  });

  it('rejects successful responses missing data._health with a routing hint', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: { status: 'ok' } }));

    await expect(runProductionSmoke('https://pi.soramitsu.io/graphql', fetchImpl)).rejects.toThrow(
      /did not return data\._health; received data keys status.*Production routing must serve the polkaswap-indexer GraphQL API/
    );
  });

  it('rejects old production health schemas missing identity fields', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        errors: [
          {
            message: 'Cannot query field "serviceId" on type "Health". Did you mean "service"?',
          },
          {
            message: 'Cannot query field "schemaVersion" on type "Health".',
          },
        ],
      })
    );

    await expect(runProductionSmoke('https://pi.soramitsu.io/graphql', fetchImpl)).rejects.toThrow(
      'PI production GraphQL schema is missing _health identity fields (serviceId, schemaVersion)'
    );
  });

  it('rejects deployed health objects missing identity fields with a deployment hint', async () => {
    const fetchImpl = fetchWithHealth({
      ok: true,
      service: 'polkaswap-indexer',
    });

    await expect(runProductionSmoke('https://pi.soramitsu.io/graphql', fetchImpl)).rejects.toThrow(
      /health serviceId must be pi\.soramitsu\.io; received <missing>.*Deploy the current polkaswap-indexer image to pi\.soramitsu\.io\/graphql/
    );
  });

  it('rejects non-JSON production responses with a body preview', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('<html>not graphql</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })
    );

    await expect(runProductionSmoke('https://pi.soramitsu.io/graphql', fetchImpl)).rejects.toThrow(
      /did not return JSON.*Body preview: <html>not graphql<\/html>.*Production routing must serve the polkaswap-indexer GraphQL API/
    );
  });

  it('rejects invalid JSON production responses with a body preview and routing hint', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('{"data":', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );

    await expect(runProductionSmoke('https://pi.soramitsu.io/graphql', fetchImpl)).rejects.toThrow(
      /returned invalid JSON\. Body preview: \{"data":.*Production routing must serve the polkaswap-indexer GraphQL API/
    );
  });

  it('rejects HTTP failures with a body preview and routing hint', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('deploy in progress', {
          status: 503,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        })
    );

    await expect(runProductionSmoke('https://pi.soramitsu.io/graphql', fetchImpl)).rejects.toThrow(
      /returned HTTP 503\. Body preview: deploy in progress.*Production routing must serve the polkaswap-indexer GraphQL API/
    );
  });

  it('rejects unhealthy repository-backed health responses', async () => {
    const fetchImpl = fetchWithHealth({ ...validHealth, ok: false });

    await expect(runProductionSmoke('https://pi.soramitsu.io/graphql', fetchImpl)).rejects.toThrow(
      'expected ok=true'
    );
  });

  it('rejects TON indexer routing by contract shape', async () => {
    const fetchImpl = fetchWithHealth({
      lastMasterSeqno: 123,
      serviceId: 'ti.soramitsu.io',
      ecosystem: 'ton',
      chainId: 'ton:mainnet',
      network: 'mainnet',
    });

    await expect(runProductionSmoke('https://pi.soramitsu.io/graphql', fetchImpl)).rejects.toThrow(
      'points at a TON indexer contract'
    );
  });

  it('rejects Solswap indexer routing by service identity', async () => {
    const fetchImpl = fetchWithHealth({
      ok: true,
      service: 'solswap-indexer',
      serviceId: 'si.soramitsu.io',
      schemaVersion: 1,
      ecosystem: 'solana',
      chainId: 'solana:mainnet',
      network: 'mainnet',
      publicBaseUrl: 'https://si.soramitsu.io',
      readOnly: true,
    });

    await expect(runProductionSmoke('https://pi.soramitsu.io/graphql', fetchImpl)).rejects.toThrow(
      'points at a Solswap indexer contract'
    );
  });

  it('rejects schema version drift', async () => {
    const fetchImpl = fetchWithHealth({ ...validHealth, schemaVersion: 2 });

    await expect(runProductionSmoke('https://pi.soramitsu.io/graphql', fetchImpl)).rejects.toThrow(
      'health schemaVersion must be 1'
    );
  });

  it('rejects non-read-only production contracts', async () => {
    const fetchImpl = fetchWithHealth({ ...validHealth, readOnly: false });

    await expect(runProductionSmoke('https://pi.soramitsu.io/graphql', fetchImpl)).rejects.toThrow(
      'health readOnly must be true'
    );
  });

  it('rejects publicBaseUrl drift', async () => {
    const fetchImpl = fetchWithHealth({ ...validHealth, publicBaseUrl: 'https://pi.soramitsu.io' });

    await expect(runProductionSmoke('https://pi.soramitsu.io/graphql', fetchImpl)).rejects.toThrow(
      'health publicBaseUrl must be https://pi.soramitsu.io/graphql'
    );
  });
});
