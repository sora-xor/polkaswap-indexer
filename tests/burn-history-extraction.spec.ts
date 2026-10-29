import {describe, expect, it} from 'vitest';
import {Metadata, TypeRegistry} from '@polkadot/types';
import substrateMetadata from '@polkadot/types-support/metadata/v14/substrate-hex';
import {decodeAuthenticatedBurnRecord, extractBurnHistory} from '../src/scripts/extract-burn-history.js';

const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
describe('authenticated Burn stream decoding', () => {
  it('uses the explicitly supplied registry and rejects changed headers and trailing event bytes', () => {
    const registry = new TypeRegistry(); registry.setMetadata(new Metadata(registry, substrateMetadata));
    const header = registry.createType('Header', {number: 25_043_003, parentHash:h(1), stateRoot:h(2), extrinsicsRoot:h(3), digest:{logs:[]}});
    const record = {hash:header.hash.toHex(),block:{block:{header:header.toJSON(),extrinsics:[]},justifications:null},
      events:'0x00',executingCodeHash:h(4),metadataSha256:'5'.repeat(64)};
    expect(decodeAuthenticatedBurnRecord(record,registry)).toMatchObject({height:25_043_003,parentHash:h(1),receipts:[]});
    expect(() => decodeAuthenticatedBurnRecord({...record,hash:h(8)},registry)).toThrow('header changed');
    expect(() => decodeAuthenticatedBurnRecord({...record,events:'0x0000'},registry)).toThrow('roundtrip');
  });
  it('cannot accept an old JSON success report in place of a fresh pinned verifier', async () => {
    await expect(extractBurnHistory({verifier:'/does/not/exist',verifierSha256:'invalid',manifest:'unused',
      verifiedOutput:'unused',output:'unused'})).rejects.toThrow('SHA-256');
  });
});
