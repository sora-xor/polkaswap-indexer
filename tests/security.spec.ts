import { parse } from 'graphql';
import { describe, expect, it } from 'vitest';

import { analyzeGraphqlDocument } from '../src/graphql/security.js';
import { AbuseLimiter } from '../src/http/abuseLimiter.js';

describe('GraphQL abuse controls', () => {
  const analyze = (query: string, overrides: Partial<Parameters<typeof analyzeGraphqlDocument>[1]> = {}) =>
    analyzeGraphqlDocument(parse(query), {
      maxDepth: 3,
      maxFields: 20,
      maxAliases: 3,
      allowIntrospection: false,
      ...overrides,
    }).map((error) => error.message);

  it('rejects depth hidden behind fragment chains', () => {
    const errors = analyze(`
      query { assets { ...A } }
      fragment A on AssetConnection { nodes { ...B } }
      fragment B on Asset { data { ...C } }
      fragment C on AssetData { id }
    `);
    expect(errors.join(' ')).toContain('depth exceeds');
  });

  it('rejects alias floods, expanded field floods, and introspection', () => {
    expect(analyze('{ a:_health { ok } b:_health { ok } c:_health { ok } d:_health { ok } }').join(' ')).toContain(
      'alias count exceeds'
    );
    const reused = Array.from({ length: 21 }, () => '...Fields').join(' ');
    expect(analyze(`query { ${reused} } fragment Fields on Query { _health { ok } }`).join(' ')).toContain(
      'field count exceeds'
    );
    expect(analyze('{ __type(name:"Query") { name } }').join(' ')).toContain('introspection is disabled');
  });

  it('terminates cyclic fragment analysis and leaves ordinary public queries valid', () => {
    expect(analyze('{ _health { ok } }')).toEqual([]);
    expect(() => analyze('query { ...A } fragment A on Query { ...B } fragment B on Query { ...A }')).not.toThrow();
  });
});

describe('bounded HTTP limiter', () => {
  it('never exceeds its identity cap and does not evict active clients', () => {
    const limiter = new AbuseLimiter({ windowMs: 1_000, max: 2, maxKeys: 2, globalWindowMs: 1_000, globalMax: 100 });
    expect(limiter.check('a', 1).allowed).toBe(true);
    expect(limiter.check('b', 1).allowed).toBe(true);
    expect(limiter.check('c', 1).scope).toBe('capacity');
    expect(limiter.trackedKeyCount).toBe(2);
    expect(limiter.check('a', 2).allowed).toBe(true);
    expect(limiter.trackedKeyCount).toBe(2);
  });

  it('uses a global bucket against rotating identities', () => {
    const limiter = new AbuseLimiter({ windowMs: 1_000, max: 100, maxKeys: 10, globalWindowMs: 1_000, globalMax: 2 });
    expect(limiter.check('a', 1).allowed).toBe(true);
    expect(limiter.check('b', 1).allowed).toBe(true);
    expect(limiter.check('c', 1).scope).toBe('global');
    expect(limiter.trackedKeyCount).toBe(2);
  });
});
