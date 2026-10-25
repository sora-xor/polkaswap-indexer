import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TypeRegistry } from '@polkadot/types/create';
import legacyTypes from '../src/runtime/sora-legacy-types.json' with { type: 'json' };
import mobileTypes from '../src/runtime/sora-mobile-types.json' with { type: 'json' };
import provenance from '../src/runtime/provenance.json' with { type: 'json' };

describe('locally owned runtime layouts', () => {
  it('preserves fixed SCALE bytes for archive swap amounts and bridge timepoints', () => {
    const registry = new TypeRegistry();
    registry.register(legacyTypes);
    const swap = registry.createType('SwapAmount', { WithDesiredInput: { desiredAmountIn: '18446744073709551616', minAmountOut: '1' } });
    expect(swap.toHex()).toBe('0x000000000000000000010000000000000001000000000000000000000000000000');
    expect(registry.createType('SwapAmount', swap.toU8a()).toJSON()).toEqual({ withDesiredInput: { desiredAmountIn: '0x00000000000000010000000000000000', minAmountOut: 1 } });
    expect(registry.createType('BridgeTimepoint', { height: { Thischain: 123 }, index: 7 }).toHex()).toBe('0x007b00000007000000');
    expect(registry.createType('AssetId', `0x${'ab'.repeat(32)}`).encodedLength).toBe(32);
  });

  it('keeps native runtime-130 aliases and reviewed data digests', () => {
    expect(mobileTypes.versioning[0].types['framenode_runtime::RuntimeCall']).toBe('GenericCall');
    expect(mobileTypes.versioning[0].types['sp_core::crypto::AccountId32']).toBe('GenericAccountId');
    expect(Object.keys(legacyTypes)).toHaveLength(195);
    for (const [name, digest] of [['sora-legacy-types.json', provenance.legacy.sha256], ['sora-mobile-types.json', provenance.mobile.sha256]]) {
      const bytes = readFileSync(new URL(`../src/runtime/${name}`, import.meta.url));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(digest);
    }
  });
});
