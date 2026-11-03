import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, link, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readStatsQualificationFile, verifyStatsCandidateFiles, initializeStatsRecovery } from '../src/scripts/initialize-stats-recovery.js';

describe('private stats initializer file boundary', () => {
  async function setup() {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'stats-clone-test-')));
    const source = join(root, 'source'), candidate = join(root, 'candidate');
    await mkdir(source); await mkdir(candidate);
    const bytes = Buffer.from('retained bytes');
    await writeFile(join(source, '001.sst'), bytes); await writeFile(join(candidate, '001.sst'), bytes);
    return { root, source, candidate, files: { '001.sst': { size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') } } };
  }
  it('verifies a separate exact copy and bounded evidence bytes without opening a native database', async () => {
    const f = await setup();
    try {
      await verifyStatsCandidateFiles(f.candidate, f.source, f.files, () => undefined);
      expect((await readStatsQualificationFile(join(f.candidate, '001.sst'))).toString()).toBe('retained bytes');
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
  it.each(['hardlink', 'symlink', 'extra', 'changed', 'stopped'] as const)('rejects %s candidates before any native open', async (kind) => {
    const f = await setup(), target = join(f.candidate, '001.sst');
    try {
      if (kind === 'hardlink' || kind === 'symlink') {
        await rm(target);
        if (kind === 'hardlink') await link(join(f.source, '001.sst'), target);
        else await symlink(join(f.source, '001.sst'), target);
      }
      if (kind === 'extra') await writeFile(join(f.candidate, 'unexpected'), 'x');
      if (kind === 'changed') await writeFile(target, 'different data');
      await expect(verifyStatsCandidateFiles(f.candidate, f.source, f.files, () => {
        if (kind === 'stopped') throw new Error('stopped');
      })).rejects.toThrow();
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
  it('refuses an implicit initializer invocation', async () => {
    await expect(initializeStatsRecovery([])).rejects.toThrow('explicit');
  });
});
