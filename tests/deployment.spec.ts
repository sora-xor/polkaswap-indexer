import { execFile, spawn } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import { assertStandaloneStorageMode } from '../src/deployment.js';

type ObservedProcess = { pid: number; ppid: number; state: string; command: string };

/** kill(pid, 0) also succeeds for zombies and cannot establish fixture identity. */
const observeProcess = async (pid: number): Promise<ObservedProcess | null> => {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile('/bin/ps', ['-ww', '-p', String(pid), '-o', 'pid=,ppid=,stat=,command='],
      { encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 }, (error, output, stderr) => {
        if (error && !(error.code === 1 && output.trim() === '' && stderr.trim() === '')) reject(error);
        else resolve(output);
      });
  });
  if (!stdout.trim()) return null;
  const fields = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(stdout);
  if (!fields || Number(fields[1]) !== pid) throw new Error(`Unrecognized process observation: ${stdout}`);
  return { pid, ppid: Number(fields[2]), state: fields[3], command: fields[4] };
};

const boundedWait = async <T>(operation: Promise<T>, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 60_000);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

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
    const holdingPath = join(base, 'child.holding.json');
    const releasePath = join(base, 'release-drain');
    const completedPath = join(base, 'child.completed.json');
    const exitedPath = join(base, 'child.exited.json');
    await mkdir(current);
    await copyFile(new URL('../ops/run-combined.sh', import.meta.url), runnerPath);
    await writeFile(
      childPath,
      `import { appendFileSync, existsSync, renameSync, writeFileSync } from 'node:fs';
const initialPpid = process.ppid;
let termCount = 0, sequence = 0, completed = false;
const identity = () => ({ pid: process.pid, ppid: process.ppid, initialPpid, termCount });
const marker = (path, value) => {
  writeFileSync(path + '.tmp', JSON.stringify(value));
  renameSync(path + '.tmp', path);
};
process.on('exit', (code) => marker(process.env.CHILD_EXITED_PATH, { ...identity(), completed, code }));
process.on('SIGTERM', () => {
  termCount += 1;
  appendFileSync(process.env.CHILD_DRAINED_PATH, 'TERM\\n');
  if (termCount !== 1) return;
  const timer = setInterval(() => {
    marker(process.env.CHILD_HOLDING_PATH, { ...identity(), sequence: ++sequence });
    if (!existsSync(process.env.CHILD_RELEASE_PATH)) return;
    clearInterval(timer);
    completed = true;
    marker(process.env.CHILD_COMPLETED_PATH, { ...identity(), completed });
    process.exit(0);
  }, 10);
});
setInterval(() => undefined, 1_000);
// Atomically publish readiness after the drain handler and keepalive exist.
// A reader must never observe the empty file between open and write.
marker(process.env.CHILD_PID_PATH, process.pid);
`
    );
    await writeFile(
      join(base, '.env'),
      [
        `POLKASWAP_INDEXER_NODE_BINARY=${process.execPath}`,
        `POLKASWAP_INDEXER_ENTRYPOINT=${childPath}`,
        `CHILD_PID_PATH=${childPidPath}`,
        `CHILD_DRAINED_PATH=${drainedPath}`,
        `CHILD_HOLDING_PATH=${holdingPath}`,
        `CHILD_RELEASE_PATH=${releasePath}`,
        `CHILD_COMPLETED_PATH=${completedPath}`,
        `CHILD_EXITED_PATH=${exitedPath}`,
      ].join('\n') + '\n'
    );
    const runner = spawn('/bin/bash', [runnerPath], {
      env: { ...process.env, POLKASWAP_INDEXER_BASE: base },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Register before any file wait: a busy host must not lose an early exit.
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      runner.once('exit', (code, signal) => resolve({ code, signal }));
      runner.once('error', reject);
    });
    void exited.catch(() => undefined);
    let childPid: number | undefined;
    const output: Buffer[] = [];
    runner.stdout.on('data', (chunk: Buffer) => output.push(chunk));
    runner.stderr.on('data', (chunk: Buffer) => output.push(chunk));
    const waitForFile = async (path: string): Promise<string> => {
      for (let attempt = 0; attempt < 6_000; attempt += 1) {
        try {
          return await readFile(path, 'utf8');
        } catch {
          await sleep(10);
        }
      }
      throw new Error(`Timed out waiting for ${path}: ${Buffer.concat(output).toString('utf8')}`);
    };
    type ChildMarker = { pid: number; ppid: number; initialPpid: number; termCount: number; sequence?: number; completed?: boolean; code?: number };
    const holdingAfter = async (sequence: number): Promise<ChildMarker> => {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const value = JSON.parse(await waitForFile(holdingPath)) as ChildMarker;
        if (Number.isSafeInteger(value.sequence) && value.sequence! > sequence) return value;
        await sleep(10);
      }
      throw new Error('Child did not remain in the explicit drain gate');
    };
    const ownedChildCommand = `${process.execPath} ${childPath}`;
    const ownedRunnerCommand = `/bin/bash ${runnerPath}`;
    const nodeName = basename(process.execPath);
    const exitedChildNames = new Set([ownedChildCommand, nodeName, `(${nodeName})`,
      `[${nodeName}] <defunct>`, `${nodeName} <defunct>`]);
    const killOwned = async (pid: number | undefined, command: string): Promise<void> => {
      if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) return;
      const currentProcess = await observeProcess(pid);
      // Never signal a reused PID or an already-dead zombie.
      if (currentProcess?.command !== command || currentProcess.state.startsWith('Z')) return;
      try { process.kill(pid, 'SIGKILL'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const after = await observeProcess(pid);
        if (!after || after.command !== command || after.state.startsWith('Z')) return;
        await sleep(25);
      }
      throw new Error(`Owned fixture process did not stop: ${pid}`);
    };

    try {
      expect(await waitForFile(join(base, 'combined.pid'))).toBe(`${runner.pid}\n`);
      expect(await waitForFile(join(base, 'api-4350.pid'))).toBe(`${runner.pid}\n`);
      const readyPid = Number(await waitForFile(childPidPath));
      expect(Number.isSafeInteger(readyPid)).toBe(true);
      expect(readyPid).toBeGreaterThan(0);
      childPid = readyPid;
      expect(await observeProcess(childPid)).toMatchObject({ pid: childPid, ppid: runner.pid, command: ownedChildCommand });

      expect(runner.kill('SIGUSR2')).toBe(true);
      await waitForFile(drainedPath);
      const firstHolding = await holdingAfter(0);
      // A second stop while Node is draining must not kill the supervisor and
      // leave the child detached from launchd's tracked process. The explicit
      // gate cannot expire before the duplicate signal on a busy host.
      expect(runner.kill('SIGTERM')).toBe(true);
      const stillHolding = await holdingAfter(firstHolding.sequence!);
      expect(stillHolding).toMatchObject({ pid: childPid, ppid: runner.pid, initialPpid: runner.pid, termCount: 1 });
      const supervisor = await observeProcess(runner.pid!);
      expect(supervisor?.command).toBe(ownedRunnerCommand);
      expect(supervisor?.state.startsWith('Z')).toBe(false);
      expect(runner.exitCode).toBeNull();
      expect(runner.signalCode).toBeNull();
      await expect(access(completedPath)).rejects.toThrow();
      await writeFile(releasePath, 'release\n', { flag: 'wx' });
      const exit = await boundedWait(exited, 'supervisor exit after releasing drain');

      expect(exit).toEqual({ code: 0, signal: null });
      // A marker written later by an orphan must not rescue an early parent
      // exit: check now, require the original parent at completed drain AND
      // the synchronous exit handler, then separately inspect kernel state.
      expect(JSON.parse(await readFile(completedPath, 'utf8'))).toMatchObject({
        pid: childPid, ppid: runner.pid, initialPpid: runner.pid, termCount: 1, completed: true });
      expect(JSON.parse(await readFile(exitedPath, 'utf8'))).toMatchObject({
        pid: childPid, ppid: runner.pid, initialPpid: runner.pid, termCount: 1, completed: true, code: 0 });
      expect(await readFile(drainedPath, 'utf8')).toBe('TERM\n');
      await expect(access(join(base, 'combined.pid'))).rejects.toThrow();
      await expect(access(join(base, 'api-4350.pid'))).rejects.toThrow();
      let remaining = await observeProcess(childPid);
      // The fixture never execs another program. A different live command at
      // this PID after the verified exit is PID reuse, not our child.
      if (remaining && !remaining.state.startsWith('Z') && remaining.command !== ownedChildCommand) remaining = null;
      if (remaining) {
        // No retry is allowed for a live child after the supervisor's exit.
        expect(remaining.state.startsWith('Z'), JSON.stringify(remaining)).toBe(true);
        expect(exitedChildNames.has(remaining.command), JSON.stringify(remaining)).toBe(true);
        const deadline = Date.now() + 60_000;
        while (remaining && Date.now() < deadline) {
          expect(remaining.state.startsWith('Z'), JSON.stringify(remaining)).toBe(true);
          expect(exitedChildNames.has(remaining.command), JSON.stringify(remaining)).toBe(true);
          await sleep(25);
          remaining = await observeProcess(childPid);
          if (remaining && !remaining.state.startsWith('Z') && remaining.command !== ownedChildCommand) remaining = null;
        }
        expect(remaining, 'Completed fixture zombie was not reaped within the bounded observation').toBeNull();
      }
    } finally {
      if (childPid === undefined || !Number.isSafeInteger(childPid) || childPid <= 0) {
        try { childPid = Number(await readFile(childPidPath, 'utf8')); } catch { /* Child may never have started. */ }
      }
      const cleanupErrors: unknown[] = [];
      await killOwned(childPid, ownedChildCommand).catch((error) => cleanupErrors.push(error));
      await killOwned(runner.pid, ownedRunnerCommand).catch((error) => cleanupErrors.push(error));
      await boundedWait(exited.catch(() => ({ code: null, signal: null })), 'fixture supervisor cleanup')
        .catch((error) => cleanupErrors.push(error));
      if (cleanupErrors.length) throw new AggregateError(cleanupErrors, `Fixture cleanup failed; evidence retained at ${base}`);
      await rm(base, { recursive: true, force: true });
    }
  }, 600_000);
});
