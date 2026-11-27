import { mkdtemp, mkdir, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rocksdbBackupIntegrityManifestPath, verifyRocksdbBackupSha256, writeRocksdbBackupSha256Manifest } from '../src/scripts/rocksdb-backup-integrity.js';

let root: string;
const metadata = (receipt = 'shared/00001.sst crc32 123') => `1\n2\n1\n${receipt}\n`;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'backup-receipt-boundary-'));
  await mkdir(join(root, 'meta')); await mkdir(join(root, 'shared'));
  await writeFile(join(root, 'meta/1'), metadata()); await writeFile(join(root, 'shared/00001.sst'), 'protected backup bytes');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function manifest(value: unknown) {
  const path = rocksdbBackupIntegrityManifestPath(root, 1); await mkdir(join(root, 'polkaswap-indexer-sha256'), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}
async function validManifest() { return JSON.parse(await readFile(await writeRocksdbBackupSha256Manifest(root, 1), 'utf8')); }

describe('native backup receipt validation', () => {
  it.each([0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1])('rejects an unsafe backup id %s', id => {
    expect(() => rocksdbBackupIntegrityManifestPath(root, id)).toThrow(/positive safe integer/);
  });
  it.each([
    ['short header', '1\n2', /header/], ['nondecimal timestamp', 'x\n2\n1\nfile crc32 1', /header/],
    ['nondecimal sequence', '1\nx\n1\nfile crc32 1', /header/],
    ['odd application metadata', '1\n2\nmetadata abc\n1\nfile crc32 1', /application metadata/],
    ['missing count', '1\n2\n\n', /file count/], ['nondecimal count', '1\n2\nx\nfile crc32 1', /file count/],
    ['zero count', '1\n2\n0', /file count/], ['excessive count', '1\n2\n1000001', /file count/],
    ['count mismatch', '1\n2\n2\nfile crc32 1', /file count/],
    ['malformed receipt', '1\n2\n1\nfile without-checksum', /file receipt/],
    ['duplicate native metadata', '1\n2\n1\nmeta/1 crc32 1', /Duplicate/],
  ])('rejects %s before hashing data files', async (_name, contents, error) => {
    await writeFile(join(root, 'meta/1'), contents as string); await expect(writeRocksdbBackupSha256Manifest(root, 1)).rejects.toThrow(error as RegExp);
  });
  it.each(['../outside', '/absolute', 'shared//file', 'shared/./file', 'shared/../file', 'shared\\file', 'shared/\0file'])('rejects unsafe native path %j', async path => {
    await writeFile(join(root, 'meta/1'), metadata(`${path} crc32 1`));
    await expect(writeRocksdbBackupSha256Manifest(root, 1)).rejects.toThrow(/Invalid path/);
  });
  it('accepts valid optional application metadata with no trailing newline', async () => {
    await writeFile(join(root, 'meta/1'), '1\n2\nmetadata 00ffAB\n1\nshared/00001.sst crc32 123');
    await writeRocksdbBackupSha256Manifest(root, 1); await expect(verifyRocksdbBackupSha256(root, 1)).resolves.toBeUndefined();
  });
  it.each(['directory', 'symlink', 'oversized'])('rejects %s native metadata', async kind => {
    const path = join(root, 'meta/1'); await rm(path);
    if (kind === 'directory') await mkdir(path);
    else if (kind === 'symlink') await symlink('../shared/00001.sst', path);
    else { await writeFile(path, ''); await truncate(path, 16 * 1024 * 1024 + 1); }
    await expect(writeRocksdbBackupSha256Manifest(root, 1)).rejects.toThrow(/Invalid RocksDB native backup metadata/);
  });
  it.each(['directory', 'symlink'])('rejects a %s in the file receipt', async kind => {
    const path = join(root, 'shared/00001.sst'); await rm(path);
    if (kind === 'directory') await mkdir(path); else await symlink('../meta/1', path);
    await expect(writeRocksdbBackupSha256Manifest(root, 1)).rejects.toThrow(/non-regular file/);
  });
  it('rejects a parent-directory symlink that resolves outside the backup root', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'backup-outside-fixture-'));
    try {
      await writeFile(join(outside, '00001.sst'), 'outside'); await rm(join(root, 'shared'), { recursive: true }); await symlink(outside, join(root, 'shared'));
      await expect(writeRocksdbBackupSha256Manifest(root, 1)).rejects.toThrow(/resolves outside/);
    } finally { await rm(outside, { recursive: true, force: true }); }
  });
  it('rejects a symbolic integrity-manifest directory', async () => {
    await symlink('shared', join(root, 'polkaswap-indexer-sha256'));
    await expect(writeRocksdbBackupSha256Manifest(root, 1)).rejects.toThrow(/not a real directory/);
  });
});

describe('SHA-256 receipt validation', () => {
  it.each([null, [], 'invalid', 1])('rejects non-record manifest %j', async value => {
    await manifest(value); await expect(verifyRocksdbBackupSha256(root, 1)).rejects.toThrow(/Invalid SHA-256 integrity manifest/);
  });
  it('rejects undocumented top-level receipt fields', async () => {
    await manifest({ ...(await validManifest()), extra: true }); await expect(verifyRocksdbBackupSha256(root, 1)).rejects.toThrow(/Unexpected fields/);
  });
  it.each([{ version: 2 }, { algorithm: 'sha1' }, { backupId: 2 }, { files: null }, { files: [] }])('rejects an incompatible manifest header %j', async patch => {
    await manifest({ ...(await validManifest()), ...patch }); await expect(verifyRocksdbBackupSha256(root, 1)).rejects.toThrow(/manifest header/);
  });
  it.each([null, [], 'invalid', {}, { path: 'shared/00001.sst', size: -1, sha256: 'a'.repeat(64) }, { path: 3, size: 0, sha256: 'a'.repeat(64) }, { path: 'shared/00001.sst', size: 1.5, sha256: 'a'.repeat(64) }, { path: 'shared/00001.sst', size: 0, sha256: 'invalid' }])('rejects malformed file receipt %j', async receipt => {
    await manifest({ ...(await validManifest()), files: [receipt] }); await expect(verifyRocksdbBackupSha256(root, 1)).rejects.toThrow(/file receipt/);
  });
  it('rejects duplicate file receipts', async () => {
    const value = await validManifest(); value.files.push(value.files[0]); await manifest(value);
    await expect(verifyRocksdbBackupSha256(root, 1)).rejects.toThrow(/Duplicate file receipt/);
  });
  it('rejects a receipt missing one native file', async () => {
    const value = await validManifest(); value.files.pop(); await manifest(value);
    await expect(verifyRocksdbBackupSha256(root, 1)).rejects.toThrow(/file set does not match/);
  });
  it('rejects invalid JSON without accepting a partial receipt', async () => {
    await validManifest(); await writeFile(rocksdbBackupIntegrityManifestPath(root, 1), '{');
    await expect(verifyRocksdbBackupSha256(root, 1)).rejects.toThrow(/Malformed.*JSON/);
  });
  it.each(['directory', 'symlink', 'oversized'])('rejects a %s integrity manifest', async kind => {
    const path = await writeRocksdbBackupSha256Manifest(root, 1); await rm(path);
    if (kind === 'directory') await mkdir(path); else if (kind === 'symlink') await symlink('../meta/1', path);
    else { await writeFile(path, ''); await truncate(path, 64 * 1024 * 1024 + 1); }
    await expect(verifyRocksdbBackupSha256(root, 1)).rejects.toThrow(/Invalid SHA-256 integrity manifest file/);
  });
  it('reports filesystem failures other than missing receipts without hiding them', async () => {
    await writeFile(join(root, 'polkaswap-indexer-sha256'), 'regular file');
    await expect(verifyRocksdbBackupSha256(root, 1)).rejects.toMatchObject({ code: 'ENOTDIR' });
  });
});
