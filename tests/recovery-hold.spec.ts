import { describe, expect, it, vi } from 'vitest';

import { createRecoveryHoldStatus, PRE_FORK_HISTORY_HOLD_CHECKPOINT as PREFIX } from '../src/recovery-hold.js';
import { evaluateWorkerReadiness } from '../src/readiness.js';
import { SORA_MAINNET_GENESIS_HASH } from '../src/soraIdentity.js';
import type { IndexerDocument } from '../src/repository/types.js';

const state = {
  genesisHash: SORA_MAINNET_GENESIS_HASH, lastIndexedBlock: 28192678,
  blockHash: `0x${'ab'.repeat(32)}`, blockTimestamp: 1792944948,
};
const document: IndexerDocument = {
  collection: 'updatesStreams', id: 'chainState', blockHeight: state.lastIndexedBlock,
  timestamp: state.blockTimestamp,
  data: { id: 'chainState', block: state.lastIndexedBlock, data: JSON.stringify(state) },
};

describe('retained-fork read-only recovery hold', () => {
  it('cannot report ready even after finality advances beyond the retained height', async () => {
    const get = vi.fn().mockResolvedValue(document);
    for (const finalized of [28191816, 28192678, 28193000]) {
      const provider = await createRecoveryHoldStatus({ get }, state, finalized, 1793452000);
      const readiness = evaluateWorkerReadiness(provider, { maxLagBlocks: 10000, maxStalenessSeconds: 3600 }, 1793452000);
      expect(readiness.ready).toBe(false);
      expect(provider.getStatus()).toMatchObject({ lifecycle: 'stopped', startupComplete: false, lastSuccessfulIndexTimestamp: null });
      const returned = provider.getStatus(); returned.lifecycle = 'running';
      expect(provider.getStatus().lifecycle).toBe('stopped');
    }
    expect(get).toHaveBeenCalledTimes(3);
  });

  it.each([
    { ...document, blockHeight: 1 },
    { ...document, data: { ...document.data, block: 1 } },
    { ...document, data: { ...document.data, data: JSON.stringify({ ...state, blockHash: `0x${'cd'.repeat(32)}` }) } },
    null,
  ])('refuses a changed or missing retained checkpoint', async (actual) => {
    await expect(createRecoveryHoldStatus({ get: vi.fn().mockResolvedValue(actual) }, state, 28191816))
      .rejects.toThrow('checkpoint changed');
  });

  it('rejects invalid identity or finalized height before opening repository data', async () => {
    const get = vi.fn();
    await expect(createRecoveryHoldStatus({ get }, { ...state, genesisHash: '0x00' }, 28191816)).rejects.toThrow('Invalid');
    await expect(createRecoveryHoldStatus({ get }, state, -1)).rejects.toThrow('Invalid');
    expect(get).not.toHaveBeenCalled();
  });

  it('labels the exact verified pre-fork prefix without claiming readiness or entitlements', async () => {
    const prefix = { ...state, lastIndexedBlock: PREFIX.block, blockHash: PREFIX.hash, blockTimestamp: PREFIX.timestamp };
    const get = vi.fn().mockResolvedValue({ ...document, blockHeight: PREFIX.block,
      data: { ...document.data, block: PREFIX.block, data: JSON.stringify(prefix) } });
    const provider = await createRecoveryHoldStatus({ get }, prefix, PREFIX.block, 1793452000, 'pre-fork-prefix');
    expect(provider.getStatus().lastError).toContain('legacy history through block 28191816');
    expect(provider.getStatus().lastError).toContain('Entitlements are not certified');
    expect(provider.getStatus().lastError).not.toContain('abandoned-fork');
    expect(evaluateWorkerReadiness(provider, { maxLagBlocks: 10000, maxStalenessSeconds: 3600 }, 1793452000).ready).toBe(false);
  });

  it('cannot relabel an abandoned or unfinalized checkpoint as a pre-fork prefix', async () => {
    const get = vi.fn();
    const prefix = { ...state, lastIndexedBlock: PREFIX.block, blockHash: PREFIX.hash, blockTimestamp: PREFIX.timestamp };
    for (const invalid of [state, { ...prefix, blockHash: state.blockHash }, { ...prefix, blockTimestamp: PREFIX.timestamp + 1 }]) {
      await expect(createRecoveryHoldStatus({ get }, invalid, PREFIX.block, 1793452000, 'pre-fork-prefix')).rejects.toThrow('prefix endpoint');
    }
    await expect(createRecoveryHoldStatus({ get }, prefix, PREFIX.block - 1, 1793452000, 'pre-fork-prefix')).rejects.toThrow('prefix endpoint');
    await expect(createRecoveryHoldStatus({ get }, prefix, PREFIX.block, 1793452000, 'current')).rejects.toThrow('data status');
    expect(get).not.toHaveBeenCalled();
  });
});
