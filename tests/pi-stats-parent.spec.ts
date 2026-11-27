import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PI_STATS_DATABASE } from '../src/pi-stats-recovery-admission.js';
import { parsePiParentIdentity, piParentGuard, type PiParentObservation } from '../src/scripts/pi-stats-parent.js';
const identity = { pid: 123, uid: 0, realUid: 0, pgid: 122, birth: 'Sat Oct 31 20:15:36 2026',
  command: '/qualified/Python /private/pi-initialize.py --request-sha256 abc' };
const now = 1_793_478_000_000;
function fixture() {
  const binding = { schema: 'sora-nexus-pi-initializer-parent-v1', databasePath: PI_STATS_DATABASE,
    nonce: 'a'.repeat(64), operationRequestSha256: 'b'.repeat(64), identity,
    deadlineUnixMs: now + 30 * 60 * 1000, minimumAvailableBytes: 76 * 1024 ** 3, drainHeadroomBytes: 128 * 1024 ** 2 };
  const observation: PiParentObservation = { parentPid: () => 123, identity: () => ({ ...identity }),
    availableBytes: () => 80n * 1024n ** 3n, now: () => now };
  return { binding, observation };
}
function guard(binding: unknown, observation: PiParentObservation) {
  const raw = Buffer.from(JSON.stringify(binding));
  return piParentGuard(raw, createHash('sha256').update(raw).digest('hex'), observation);
}
describe('Pi initializer parent and reserve', () => {
  it('parses the exact Darwin identity fields and admits the original root parent', () => {
    expect(parsePiParentIdentity('123 0 0 122 Sat Oct 31 20:15:36 2026 '+identity.command)).toEqual(identity);
    const f = fixture(); expect(() => guard(f.binding, f.observation)()).not.toThrow();
  });
  it.each(['', '123 0 0 122 missing', 'unrelated'])('rejects absent or malformed ps %j', raw => {
    expect(() => parsePiParentIdentity(raw)).toThrow();
  });
  it.each(['pid', 'uid', 'realUid', 'pgid', 'birth', 'command'] as const)('rejects changed parent %s', field => {
    const f = fixture(), check = guard(f.binding, f.observation);
    f.observation.identity = () => ({ ...identity, [field]: typeof identity[field] === 'number' ? 999 : 'changed' });
    expect(check).toThrow('parent');
  });
  it('rejects orphaning before and during the identity lookup', () => {
    const f = fixture(), check = guard(f.binding, f.observation);
    f.observation.parentPid = () => 1; expect(check).toThrow('parent');
    let calls = 0; f.observation.parentPid = () => ++calls === 1 ? 123 : 1; expect(check).toThrow('parent');
  });
  it('rejects a low reserve or expired deadline', () => {
    const f = fixture(), check = guard(f.binding, f.observation);
    f.observation.availableBytes = () => BigInt(f.binding.minimumAvailableBytes + f.binding.drainHeadroomBytes - 1);
    expect(check).toThrow('reserve');
    f.observation.now = () => f.binding.deadlineUnixMs; expect(check).toThrow('deadline');
  });
  it.each([
    { minimumAvailableBytes: 75 * 1024 ** 3 }, { drainHeadroomBytes: 0 }, { drainHeadroomBytes: 2 * 1024 ** 3 },
    { deadlineUnixMs: now - 1 }, { deadlineUnixMs: now + 32 * 60 * 1000 }, { nonce: '' },
    { databasePath: '/unreviewed' }, { extra: true },
  ])('rejects repinned unsafe binding %j', change => {
    const f = fixture(); expect(() => guard({ ...f.binding, ...change }, f.observation)).toThrow();
  });
  it('admits the separately scoped 90-minute read-only audit but never as an initializer', () => {
    const f = fixture(); const binding = { ...f.binding, schema: 'sora-nexus-pi-audit-parent-v1', deadlineUnixMs: now + 90 * 60 * 1000 };
    const raw = Buffer.from(JSON.stringify(binding)), pin = createHash('sha256').update(raw).digest('hex');
    expect(() => piParentGuard(raw, pin, f.observation, 'audit')()).not.toThrow();
    expect(() => piParentGuard(raw, pin, f.observation)).toThrow('scope');
    expect(() => piParentGuard(raw, pin, f.observation, 'unreviewed' as 'audit')).toThrow('phase');
  });
  it('rejects changed raw proof bytes and duplicate keys', () => {
    const f = fixture(), raw = Buffer.from(JSON.stringify(f.binding));
    expect(() => piParentGuard(raw, 'a'.repeat(64), f.observation)).toThrow('pin');
    const duplicate = Buffer.from(raw.toString().replace('{', '{"nonce":"shadow",'));
    expect(() => piParentGuard(duplicate, createHash('sha256').update(duplicate).digest('hex'), f.observation)).toThrow('scope');
  });
});
