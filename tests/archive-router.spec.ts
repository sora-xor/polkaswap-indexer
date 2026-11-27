import { describe, expect, it, vi } from 'vitest';
import { ARCHIVE_CHECKPOINT as C, ARCHIVE_GENESIS as G, RECOVERY_FIRST_CHILD as child, ArchiveRouter } from '../src/archive-router.js';
const old = `0x${'1'.repeat(64)}`, abandoned = `0x${'3'.repeat(64)}`;
/** Fake independent upstreams with a shared prefix and conflicting first children. */
async function fixture() {
  const make = (kind: 'live' | 'archive') => vi.fn(async (method: string, params: unknown[]): Promise<unknown> => {
    if (method === 'chain_getBlockHash') {
      const height = Number(params[0]);
      if (height === 0) return G;
      if (height === C.height) return C.hash;
      if (height === 1) return old;
      if (height === C.height + 1) return kind === 'live' ? child : abandoned;
    }
    if (method === 'chain_getHeader') {
      if (params[0] === old) return { number: '0x1' };
      if (params[0] === C.hash) return { number: `0x${C.height.toString(16)}` };
      if (params[0] === abandoned || params[0] === child && kind === 'live') return { number: `0x${(C.height + 1).toString(16)}`, parentHash: C.hash };
      return null;
    }
    return kind;
  });
  const live = make('live'), archive = make('archive');
  const router = new ArchiveRouter(live, archive);
  await router.verify();
  return { router, live, archive };
}
describe('canonical archive routing', () => {
  it('rejects swapped upstreams even though genesis and checkpoint agree', async () => {
    const { live, archive } = await fixture();
    const swapped = new ArchiveRouter(archive, live);
    await expect(swapped.verify()).rejects.toThrow('not the pinned recovery branch');
    await expect(swapped.call('system_health', [])).rejects.toThrow('not verified');
  });
  it('fails closed before admission and after a failed recheck', async () => {
    const { router, live, archive } = await fixture();
    await expect(new ArchiveRouter(live, archive).call('system_health', [])).rejects.toThrow('not verified');
    live.mockResolvedValueOnce('wrong');
    await expect(router.verify()).rejects.toThrow('mismatch');
    await expect(router.call('system_health', [])).rejects.toThrow('not verified');
  });
  it('returns shared historical state and live post-fork state', async () => {
    const { router } = await fixture();
    expect(await router.call('state_getStorage', ['0x00', old])).toBe('archive');
    expect(await router.call('state_queryStorageAt', [['0x00'], child])).toBe('live');
  });
  it('never admits an abandoned child, even when both nodes retain its header', async () => {
    const { router } = await fixture();
    await expect(router.call('state_getStorage', ['0x00', abandoned])).rejects.toThrow('Noncanonical recovery');
  });
  it('uses recovery execution metadata at the checkpoint parent', async () => {
    const { router } = await fixture();
    expect(await router.call('state_getMetadata', [old])).toBe('archive');
    expect(await router.call('state_getMetadata', [C.hash])).toBe('live');
    expect(await router.call('state_getRuntimeVersion', [C.hash])).toBe('live');
    expect(await router.call('state_call', ['Metadata_metadata', '0x', C.hash])).toBe('live');
    expect(await router.call('state_getStorage', ['0x00', C.hash])).toBe('archive');
  });
  it('gets every default/head response from the recovery node', async () => {
    const { router } = await fixture();
    for (const method of ['chain_getFinalizedHead', 'system_health', 'state_getMetadata', 'state_getRuntimeVersion']) {
      expect(await router.call(method, [])).toBe('live');
    }
  });
  it('routes block heights across the exact shared boundary', async () => {
    const { router } = await fixture();
    expect(await router.call('chain_getBlockHash', [C.height])).toBe(C.hash);
    expect(await router.call('chain_getBlockHash', [C.height + 1])).toBe(child);
    expect(await router.call('chain_getBlockHash', ['0x1'])).toBe(old);
  });
  it('rejects writes, range queries and malformed block selectors', async () => {
    const { router } = await fixture();
    for (const method of ['author_submitExtrinsic', 'state_queryStorage', 'system_addReservedPeer']) {
      await expect(router.call(method, [])).rejects.toThrow('Unsupported');
    }
    for (const height of [-1, Number.MAX_SAFE_INTEGER + 1, [], '1']) {
      await expect(router.call('chain_getBlockHash', [height])).rejects.toThrow('block height');
    }
    await expect(router.call('state_getStorage', ['0x00', 'bad'])).rejects.toThrow('block hash');
    await expect(router.call('state_getStorage', ['0x00', old, child])).rejects.toThrow('Unexpected');
  });
  it('rejects a noncanonical historical header and does not cache it', async () => {
    const { router, archive } = await fixture();
    archive.mockResolvedValueOnce({ number: '0x1' }).mockResolvedValueOnce(child);
    await expect(router.call('state_getMetadata', [old])).rejects.toThrow('Noncanonical historical');
    expect(await router.call('state_getMetadata', [old])).toBe('archive');
  });
});
