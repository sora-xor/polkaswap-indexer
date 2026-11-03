/** Original-parent and reserve guard for the separately admitted Pi initializer. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { PI_STATS_DATABASE } from '../pi-stats-recovery-admission.js';

export type PiParentIdentity = { pid: number; uid: number; realUid: number; pgid: number; birth: string; command: string };
export type PiParentObservation = { parentPid: () => number; identity: (pid: number) => PiParentIdentity;
  availableBytes: () => bigint; now: () => number };
function need(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Pi initializer parent: ${message}`);
}
/** Parse only the exact Darwin ps fields requested by the owned executor. */
export function parsePiParentIdentity(raw: string): PiParentIdentity {
  const match = raw.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
  need(match, 'missing or malformed parent identity');
  return { pid: Number(match[1]), uid: Number(match[2]), realUid: Number(match[3]), pgid: Number(match[4]),
    birth: match[5]!.replace(/\s+/g, ' '), command: match[6]! };
}
/** Bind immutable parent proof bytes; every check rejects orphaning, identity drift and low space. */
export function piParentGuard(raw: Uint8Array, pin: string, observation: PiParentObservation,
  phase: 'initializer' | 'audit' = 'initializer'): () => void {
  need(phase === 'initializer' || phase === 'audit', 'unsupported operation phase');
  const maximumMs = (phase === 'initializer' ? 31 : 91) * 60 * 1000;
  need(raw.byteLength > 0 && raw.byteLength <= 64 * 1024 && /^[a-f0-9]{64}$/.test(pin) &&
    createHash('sha256').update(raw).digest('hex') === pin, 'binding pin/bound differs');
  const binding = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  need(Buffer.from(JSON.stringify(binding)).equals(Buffer.from(raw)) && binding &&
    Object.keys(binding).sort().join(',') ===
      'databasePath,deadlineUnixMs,drainHeadroomBytes,identity,minimumAvailableBytes,nonce,operationRequestSha256,schema' &&
    binding.schema === `sora-nexus-pi-${phase}-parent-v1` && binding.databasePath === PI_STATS_DATABASE &&
    /^[a-f0-9]{64}$/.test(binding.nonce) && /^[a-f0-9]{64}$/.test(binding.operationRequestSha256) &&
    binding.minimumAvailableBytes === 76 * 1024 ** 3 && Number.isSafeInteger(binding.drainHeadroomBytes) &&
    binding.drainHeadroomBytes >= 128 * 1024 ** 2 && binding.drainHeadroomBytes <= 1024 ** 3 &&
    Number.isSafeInteger(binding.deadlineUnixMs) && binding.deadlineUnixMs > observation.now() &&
    binding.deadlineUnixMs <= observation.now() + maximumMs, 'binding scope/deadline/reserve differs');
  const expected = binding.identity as PiParentIdentity;
  need(expected && Object.keys(expected).sort().join(',') === 'birth,command,pgid,pid,realUid,uid' &&
    Number.isSafeInteger(expected.pid) && expected.pid > 1 && expected.uid === 0 && expected.realUid === 0 &&
    Number.isSafeInteger(expected.pgid) && expected.pgid > 0 && typeof expected.birth === 'string' &&
    typeof expected.command === 'string' && expected.command.length > 0, 'invalid root parent');
  return () => {
    need(observation.now() < binding.deadlineUnixMs, 'deadline reached');
    need(observation.parentPid() === expected.pid && isDeepStrictEqual(observation.identity(expected.pid), expected) &&
      observation.parentPid() === expected.pid, 'original parent disappeared or changed');
    need(observation.availableBytes() >= BigInt(binding.minimumAvailableBytes) + BigInt(binding.drainHeadroomBytes),
      'protected filesystem reserve/headroom reached');
  };
}
