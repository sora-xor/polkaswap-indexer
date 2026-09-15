import { spawn } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import { assertStandaloneStorageMode } from '../src/deployment.js';

describe('deployment storage topology', () => {
  it.each(['api', 'worker'] as const)('rejects a split %s process with embedded RocksDB', (role) => {
    expect(() => assertStandaloneStorageMode({ storageEngine: 'rocksdb' }, role)).toThrow(
      /combined entry point/
    );
  });

  it.each(['api', 'worker'] as const)('allows a split PostgreSQL %s process', (role) => {
    expect(() => assertStandaloneStorageMode({ storageEngine: 'postgres' }, role)).not.toThrow();
  });

  it('gives the launchd process enough descriptors and shutdown time', async () => {
    const plist = await readFile(
      new URL('../ops/org.polkaswap.indexer.plist', import.meta.url),
      'utf8'
    );

    expect(plist).toMatch(
      /<key>SoftResourceLimits<\/key>\s*<dict>\s*<key>NumberOfFiles<\/key>\s*<integer>65536<\/integer>\s*<\/dict>/
    );
    expect(plist).toMatch(/<key>ExitTimeOut<\/key>\s*<integer>240<\/integer>/);
  });

  it('rotates one combined launchd log through a graceful supervised restart', async () => {
    const [plist, runner, newsyslog] = await Promise.all([
      readFile(new URL('../ops/org.polkaswap.indexer.plist', import.meta.url), 'utf8'),
      readFile(new URL('../ops/run-combined.sh', import.meta.url), 'utf8'),
      readFile(new URL('../ops/org.polkaswap.indexer.newsyslog.conf', import.meta.url), 'utf8'),
    ]);
    const logPath = '/Users/administrator/apps/polkaswap-indexer/logs/combined-launchd.log';

    expect(plist.match(new RegExp(logPath.replaceAll('/', '\\/'), 'g'))).toHaveLength(2);
    expect(plist).toMatch(/<key>Umask<\/key>\s*<integer>23<\/integer>/);
    expect(newsyslog).toContain(`${logPath} administrator:staff 640 5 102400 * C`);
    expect(newsyslog).toContain('/Users/administrator/apps/polkaswap-indexer/combined.pid 31');
    expect(runner).toContain("trap 'stop_child TERM' USR2");
    expect(runner).toContain("trap '' TERM INT USR2");
    expect(runner).toContain('trap cleanup_pid_files EXIT');
    expect(runner.indexOf('trap cleanup_pid_files EXIT')).toBeLessThan(
      runner.indexOf('write_pid_file "${PID_FILES[0]}"')
    );
    expect(runner).not.toMatch(/exec .*dist\/src\/combined\.js/);
  });

  it('keeps the supervisor alive through duplicate stop signals until Node drains and removes owned pid files', async () => {
    const base = await mkdtemp(join(tmpdir(), 'polkaswap-runner-'));
    const current = join(base, 'current');
    const runnerPath = join(base, 'run-combined.sh');
    const childPath = join(base, 'child.mjs');
    const childPidPath = join(base, 'child.pid');
    const drainedPath = join(base, 'child.drained');
    await mkdir(current);
    await copyFile(new URL('../ops/run-combined.sh', import.meta.url), runnerPath);
    await writeFile(
      childPath,
      `import { appendFileSync, writeFileSync } from 'node:fs';
writeFileSync(process.env.CHILD_PID_PATH, String(process.pid));
process.on('SIGTERM', () => {
  appendFileSync(process.env.CHILD_DRAINED_PATH, 'TERM\\n');
  setTimeout(() => process.exit(0), 200);
});
setInterval(() => undefined, 1_000);
`
    );
    await writeFile(
      join(base, '.env'),
      [
        `POLKASWAP_INDEXER_NODE_BINARY=${process.execPath}`,
        `POLKASWAP_INDEXER_ENTRYPOINT=${childPath}`,
        `CHILD_PID_PATH=${childPidPath}`,
        `CHILD_DRAINED_PATH=${drainedPath}`,
      ].join('\n') + '\n'
    );
    const runner = spawn('/bin/bash', [runnerPath], {
      env: { ...process.env, POLKASWAP_INDEXER_BASE: base },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output: Buffer[] = [];
    runner.stdout.on('data', (chunk: Buffer) => output.push(chunk));
    runner.stderr.on('data', (chunk: Buffer) => output.push(chunk));
    const waitForFile = async (path: string): Promise<string> => {
      for (let attempt = 0; attempt < 500; attempt += 1) {
        try {
          return await readFile(path, 'utf8');
        } catch {
          await sleep(10);
        }
      }
      throw new Error(`Timed out waiting for ${path}: ${Buffer.concat(output).toString('utf8')}`);
    };

    try {
      expect(await waitForFile(join(base, 'combined.pid'))).toBe(`${runner.pid}\n`);
      expect(await waitForFile(join(base, 'api-4350.pid'))).toBe(`${runner.pid}\n`);
      const childPid = Number(await waitForFile(childPidPath));
      expect(Number.isSafeInteger(childPid)).toBe(true);

      runner.kill('SIGUSR2');
      await waitForFile(drainedPath);
      // A second stop while Node is draining must not kill the supervisor and
      // leave the child detached from launchd's tracked process.
      runner.kill('SIGTERM');
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        runner.once('exit', (code, signal) => resolve({ code, signal }));
      });

      expect(exit).toEqual({ code: 0, signal: null });
      expect(await readFile(drainedPath, 'utf8')).toBe('TERM\n');
      await expect(access(join(base, 'combined.pid'))).rejects.toThrow();
      await expect(access(join(base, 'api-4350.pid'))).rejects.toThrow();
      expect(() => process.kill(childPid, 0)).toThrow();
    } finally {
      if (runner.exitCode === null && runner.signalCode === null) runner.kill('SIGKILL');
      await rm(base, { recursive: true, force: true });
    }
  }, 15_000);
});
