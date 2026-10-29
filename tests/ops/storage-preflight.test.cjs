'use strict';

/** Offline regression tests for the independent pre-import maintenance disk gate. */
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');
const {
  MINIMUM_RESERVE_BYTES,
  maintenanceEntrypoint,
  createStoragePlan,
  nearestExistingDirectory,
  evaluateSpace,
  checkStorage,
} = require('../../ops/storage-preflight.cjs');

const PREFLIGHT = path.resolve(__dirname, '../../ops/storage-preflight.cjs');
const COMMANDS = [
  'backup-rocksdb', 'checkpoint-rocksdb', 'restore-rocksdb', 'migrate-postgres-to-rocksdb',
  'repair-network-volume', 'network-stock-repair', 'compact-rocksdb', 'repair-rocksdb-legacy-checkpoint',
];
const ENV = { INDEXER_STORAGE_EXPECTED_WRITE_BYTES: '1024' };

/** Register cleanup for each real temporary filesystem fixture. */
function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'indexer-storage-preflight-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** Execute a harmless real entrypoint with the production NODE_OPTIONS preload. */
function runEntry(t, name, env = {}, body = 'console.log("ENTRY_RAN")', preload = true) {
  const directory = temporaryDirectory(t);
  const entry = path.join(directory, name);
  fs.writeFileSync(entry, body);
  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith('INDEXER_STORAGE_') || key.startsWith('ROCKSDB_')) delete childEnv[key];
  }
  childEnv.NODE_OPTIONS = preload ? `--require=${JSON.stringify(PREFLIGHT)}` : '';
  return spawnSync(process.execPath, [entry], {
    cwd: directory, env: { ...childEnv, ...env }, encoding: 'utf8', timeout: 15_000,
  });
}

test('only direct .js/.ts maintenance entrypoints match, never API imports or arguments', () => {
  for (const command of COMMANDS) {
    for (const extension of ['js', 'ts']) {
      assert.equal(maintenanceEntrypoint(['node', `/release/src/scripts/${command}.${extension}`]), command);
    }
  }
  for (const entry of ['combined.js', 'index.js', 'benchmark-rocksdb.js', 'audit-rocksdb.js',
    'verify-rocksdb.ts', 'backup-rocksdb.js.map', 'my-backup-rocksdb.js', 'backup-rocksdb.cjs']) {
    assert.equal(maintenanceEntrypoint(['node', entry, 'backup-rocksdb.js']), null);
  }
  assert.equal(maintenanceEntrypoint(['node']), null);
});

test('uses actual CLI destination settings and default paths', () => {
  const cases = [
    ['backup-rocksdb', {}, '/release/data/polkaswap-indexer-rocksdb-backups'],
    ['checkpoint-rocksdb', {}, '/release/data/polkaswap-indexer-rocksdb-checkpoints'],
    ['backup-rocksdb', { ROCKSDB_BACKUP_DIR: '/external/backups' }, '/external/backups'],
    ['checkpoint-rocksdb', { ROCKSDB_CHECKPOINT_PATH: '/external/checkpoint' }, '/external/checkpoint'],
    ['restore-rocksdb', { ROCKSDB_RESTORE_PARENT_PATH: ' /external/restores ' }, '/external/restores'],
    ['migrate-postgres-to-rocksdb', { ROCKSDB_PATH: '/external/staging' }, '/external/staging'],
    ['compact-rocksdb', { ROCKSDB_PATH: 'relative-db' }, '/release/relative-db'],
    ['repair-network-volume', {}, '/release/data/polkaswap-indexer.rocksdb'],
    ['network-stock-repair', {}, '/release/data/polkaswap-indexer.rocksdb'],
  ];
  for (const [command, env, expected] of cases) {
    const plan = createStoragePlan(['node', `${command}.js`], { ...ENV, ...env }, '/release');
    assert.equal(plan.volumes[0].path, expected);
    assert.equal(plan.reserveBytes, 80_530_636_800n);
    assert.equal(plan.expectedWriteBytes, 1024n);
  }
});

test('requires an explicit measured estimate and permits zero only for checkpoints', () => {
  for (const command of COMMANDS) {
    assert.throws(() => createStoragePlan(['node', `${command}.ts`], {}, '/release'), /EXPECTED_WRITE_BYTES is required/);
    if (command !== 'checkpoint-rocksdb') {
      assert.throws(() => createStoragePlan(['node', `${command}.js`], {
        INDEXER_STORAGE_EXPECTED_WRITE_BYTES: '0',
      }, '/release'), /must be positive/);
    }
  }
  assert.equal(createStoragePlan(['node', 'checkpoint-rocksdb.js'], {
    INDEXER_STORAGE_EXPECTED_WRITE_BYTES: '0',
  }, '/release').expectedWriteBytes, 0n);
});

test('rejects malformed, negative and unsafe byte settings without echoing them', () => {
  for (const key of ['INDEXER_STORAGE_EXPECTED_WRITE_BYTES', 'INDEXER_STORAGE_RESERVE_BYTES']) {
    for (const value of ['', '-1', 'NaN', 'Infinity', '1.5', '1e12', '+1', '0x100', '9007199254740992',
      '01', 'SECRET_TOKEN_VALUE', '9'.repeat(1000)]) {
      assert.throws(() => createStoragePlan(['node', 'backup-rocksdb.js'], {
        ...ENV, [key]: value,
      }, '/release'), (error) => error.message === `${key} must be a nonnegative decimal safe integer.`);
    }
  }
  assert.throws(() => createStoragePlan(['node', 'backup-rocksdb.js'], {
    ...ENV, INDEXER_STORAGE_RESERVE_BYTES: String(MINIMUM_RESERVE_BYTES - 1n),
  }, '/release'), /cannot be lower/);
  assert.throws(() => createStoragePlan(['node', 'backup-rocksdb.js'], {
    INDEXER_STORAGE_EXPECTED_WRITE_BYTES: String(Number.MAX_SAFE_INTEGER),
  }, '/release'), /exceeds the safe integer range/);
});

test('ignores maintenance configuration for API startup and dependency imports', () => {
  assert.equal(createStoragePlan(['node', 'combined.js', 'backup-rocksdb.js'], {
    INDEXER_STORAGE_EXPECTED_WRITE_BYTES: 'invalid', INDEXER_STORAGE_RESERVE_BYTES: '-1',
  }, '/release'), null);
});

test('restore checks destination, live database and backup source; legacy repair checks receipt volume', () => {
  const restore = createStoragePlan(['node', 'restore-rocksdb.js'], {
    ...ENV, ROCKSDB_PATH: '/live/database', ROCKSDB_RESTORE_PARENT_PATH: '/staging', ROCKSDB_BACKUP_DIR: '/backup',
  }, '/release');
  assert.deepEqual(restore.volumes, [
    { role: 'target', path: '/staging', expectedWriteBytes: 1024n },
    { role: 'source or active database', path: '/live/database', expectedWriteBytes: 0n },
    { role: 'backup source', path: '/backup', expectedWriteBytes: 0n },
  ]);
  const legacy = createStoragePlan(['node', 'repair-rocksdb-legacy-checkpoint.ts'], {
    ...ENV, ROCKSDB_CHECKPOINT_REPAIR_RECEIPT: '/receipts/repair.json',
  }, '/release');
  assert.equal(legacy.volumes[1].path, '/receipts');
  assert.throws(() => createStoragePlan(['node', 'restore-rocksdb.ts'], ENV, '/release'), /RESTORE_PARENT_PATH/);
  assert.throws(() => createStoragePlan(['node', 'backup-rocksdb.ts'], {
    ...ENV, ROCKSDB_BACKUP_DIR: 'secret\npath',
  }, '/release'), (error) => error.message === 'ROCKSDB_BACKUP_DIR must identify a nonempty filesystem path.');
});

test('compares exact bytes at and below the reserve boundary', () => {
  assert.equal(evaluateSpace(MINIMUM_RESERVE_BYTES + 1n, 1n, MINIMUM_RESERVE_BYTES).sufficient, true);
  assert.equal(evaluateSpace(MINIMUM_RESERVE_BYTES, 1n, MINIMUM_RESERVE_BYTES).sufficient, false);
  assert.throws(() => evaluateSpace(-1n, 0n, MINIMUM_RESERVE_BYTES), /nonnegative/);
  assert.throws(() => evaluateSpace(Number.MAX_SAFE_INTEGER + 1, 0n, MINIMUM_RESERVE_BYTES), /integer bytes/);
});

test('uses nearest existing directory and resolves mounted/symlinked target ancestors', (t) => {
  const directory = temporaryDirectory(t);
  const target = path.join(directory, 'real-target');
  fs.mkdirSync(target);
  const alias = path.join(directory, 'alias');
  fs.symlinkSync(target, alias);
  assert.equal(nearestExistingDirectory(path.join(alias, 'new', 'checkpoint')), fs.realpathSync(target));
  assert.equal(fs.existsSync(path.join(alias, 'new')), false);

  fs.symlinkSync(path.join(directory, 'missing-target'), path.join(directory, 'broken'));
  assert.throws(() => nearestExistingDirectory(path.join(directory, 'broken', 'checkpoint')), /symlinks/);
  fs.writeFileSync(path.join(directory, 'file'), 'not a directory');
  assert.throws(() => nearestExistingDirectory(path.join(directory, 'file')), /not a directory/);
});

test('checks destination capacity and source reserve independently without touching databases', (t) => {
  const directory = temporaryDirectory(t);
  const source = path.join(directory, 'source');
  const target = path.join(directory, 'destination');
  fs.mkdirSync(source);
  fs.mkdirSync(target);
  const sourceReal = fs.realpathSync(source);
  const targetReal = fs.realpathSync(target);
  const calls = [];
  let sourceAvailable = MINIMUM_RESERVE_BYTES - 1n;
  let targetAvailable = MINIMUM_RESERVE_BYTES + 1024n;
  const filesystem = {
    ...fs,
    statfsSync(candidate, options) {
      calls.push(candidate);
      assert.equal(options.bigint, true);
      return { bsize: 1n, bavail: candidate === sourceReal ? sourceAvailable : targetAvailable };
    },
  };
  const input = {
    argv: ['node', 'backup-rocksdb.js'], env: { ...ENV, ROCKSDB_PATH: source, ROCKSDB_BACKUP_DIR: target },
    cwd: directory, filesystem,
  };
  assert.throws(() => checkStorage(input), /Insufficient free space for source or active database/);
  assert.deepEqual(calls, [targetReal, sourceReal]);
  sourceAvailable = MINIMUM_RESERVE_BYTES;
  assert.equal(checkStorage(input).measurements.length, 2);
  targetAvailable -= 1n;
  assert.throws(() => checkStorage(input), /Insufficient free space for target/);
  assert.deepEqual(fs.readdirSync(source), []);
  assert.deepEqual(fs.readdirSync(target), []);
});

test('filesystem access failures and invalid measurements fail closed without leaking OS error paths', (t) => {
  const directory = temporaryDirectory(t);
  const input = { argv: ['node', 'compact-rocksdb.js'], env: { ...ENV, ROCKSDB_PATH: directory }, cwd: directory };
  assert.throws(() => checkStorage({ ...input, filesystem: {
    ...fs, statfsSync() { throw new Error('SECRET_PATH'); },
  } }), (error) => error.message === 'Cannot measure free space on a maintenance filesystem.');
  for (const status of [{ bsize: 4096n, bavail: -1n }, { bsize: 0n, bavail: 100n }, { bsize: 4096, bavail: 100 }]) {
    assert.throws(() => checkStorage({ ...input, filesystem: { ...fs, statfsSync: () => status } }), /measurements are invalid/);
  }
  assert.throws(() => checkStorage({ ...input, filesystem: {
    ...fs, lstatSync() { throw Object.assign(new Error('SECRET_PATH'), { code: 'EACCES' }); },
  } }), (error) => error.message === 'Cannot inspect a maintenance filesystem.');
});

test('real preload refuses missing budget before a direct maintenance program executes', (t) => {
  for (const name of ['backup-rocksdb.js', 'checkpoint-rocksdb.ts', 'network-stock-repair.js']) {
    const result = runEntry(t, name);
    assert.equal(result.status, 78, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^\[indexer-storage-preflight\] blocked: INDEXER_STORAGE_EXPECTED_WRITE_BYTES is required;/);
  }
});

test('real preload refuses insufficient measured free space without creating an artifact', (t) => {
  const result = runEntry(t, 'backup-rocksdb.js', {
    INDEXER_STORAGE_EXPECTED_WRITE_BYTES: String(BigInt(Number.MAX_SAFE_INTEGER) - MINIMUM_RESERVE_BYTES),
  });
  assert.equal(result.status, 78, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Insufficient free space for target; availableBytes=\d+ requiredBytes=9007199254740991/);
  assert.doesNotMatch(result.stderr, /indexer-storage-preflight-[A-Za-z0-9]/);
});

test('direct imports enforce the gate even without NODE_OPTIONS', (t) => {
  const result = runEntry(t, 'repair-network-volume.js', {},
    `import ${JSON.stringify(pathToFileURL(PREFLIGHT).href)}; console.log("ENTRY_RAN");`, false);
  assert.equal(result.status, 78, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /EXPECTED_WRITE_BYTES is required/);
});

test('API and read-only benchmark programs still run with the guard imported and invalid maintenance settings', (t) => {
  for (const entry of ['combined.js', 'index.js', 'benchmark-rocksdb.js']) {
    const result = runEntry(t, entry, {
      INDEXER_STORAGE_EXPECTED_WRITE_BYTES: 'SECRET_INVALID_VALUE', INDEXER_STORAGE_RESERVE_BYTES: '-1',
    }, `require(${JSON.stringify(PREFLIGHT)}); console.log("ENTRY_RAN");`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'ENTRY_RAN\n');
    assert.equal(result.stderr, '');
  }
});

test('a sufficient real filesystem budget allows the direct maintenance sentinel', (t) => {
  const status = fs.statfsSync(os.tmpdir(), { bigint: true });
  if (status.bavail * status.bsize < MINIMUM_RESERVE_BYTES + 1024n) {
    t.skip('This test host lacks the mandatory 75 GiB reserve; injected boundary cases still run.');
    return;
  }
  const result = runEntry(t, 'compact-rocksdb.js', ENV);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'ENTRY_RAN\n');
  assert.equal(result.stderr, '');
});

test('tsx package-script child processes inherit and enforce the guard', (t) => {
  const directory = temporaryDirectory(t);
  const entry = path.join(directory, 'checkpoint-rocksdb.ts');
  fs.writeFileSync(entry, 'console.log("ENTRY_RAN");');
  const env = { ...process.env, NODE_OPTIONS: `--require=${JSON.stringify(PREFLIGHT)}` };
  delete env.INDEXER_STORAGE_EXPECTED_WRITE_BYTES;
  delete env.INDEXER_STORAGE_RESERVE_BYTES;
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../../node_modules/tsx/dist/cli.mjs'), entry], {
    env, encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(result.status, 78, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /EXPECTED_WRITE_BYTES is required/);
});
