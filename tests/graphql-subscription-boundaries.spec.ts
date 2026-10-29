import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSchema } from '../src/graphql/resolvers.js';
const schema = createSchema();
const field = (name: string): any => schema.getSubscriptionType()!.getFields()[name]!;
afterEach(() => vi.useRealTimers());
describe('GraphQL subscription projection boundaries', () => {
  it('projects absent order book fields as explicit nulls', async () => {
    const context = { repository: { get: async () => ({ data: {} }) } };
    expect(await field('orderBooks').resolve({ id: 'book', mutationType: 'UPDATE' }, {}, context)).toEqual({ id: 'book', mutation_type: 'UPDATE', _entity: { price: null, price_change_day: null, volume_day_u_s_d: null, status: null, last_deals: null } });
  });
  it('turns a document deleted after its watch event into a deletion payload', async () => {
    expect(await field('accounts').resolve({ id: 'alice', mutationType: 'UPDATE' }, {}, { repository: { get: async () => null } })).toEqual({ id: 'alice', mutation_type: 'DELETE', _entity: { id: 'alice' } });
  });
  it.each(['INVALID', 5, null])('rejects an unsupported mutation selector %s before polling', async mutation => {
    const get = vi.fn(), source = field('accounts').subscribe({}, { id: ['alice'], mutation: [mutation] }, { repository: { get } });
    await expect(source.next()).rejects.toThrow(/unsupported value/); expect(get).not.toHaveBeenCalled();
  });
  it.each([[], [''], ['a\u0000b']].map(id => [id]))('rejects an invalid identifier selection %j', async id => {
    const source = field('accounts').subscribe({}, { id }, { repository: { get: vi.fn() } });
    await expect(source.next()).rejects.toThrow(/id/);
  });
  it('polls absence, insertion and deletion without retaining missing records', async () => {
    vi.useFakeTimers(); let document: any = null;
    const get = vi.fn(async () => document), source = field('accounts').subscribe({}, { id: ['alice'], mutation: [] }, { repository: { get } });
    const first = source.next(); await vi.advanceTimersByTimeAsync(0); expect(get).toHaveBeenCalledTimes(1);
    document = { id: 'alice', data: { name: 'Alice' } }; await vi.advanceTimersByTimeAsync(5000);
    expect(await first).toMatchObject({ value: { id: 'alice', mutationType: 'INSERT' } });
    document = null; const next = source.next(); await vi.advanceTimersByTimeAsync(5000);
    expect(await next).toMatchObject({ value: { id: 'alice', mutationType: 'DELETE' } }); await source.return();
  });
  it('rejects out-of-scope watch events without exposing another account', async () => {
    const source = field('accounts').subscribe({}, { id: ['alice'] }, { repository: { watch: async function* () { yield { collection: 'accounts', id: 'bob', mutationType: 'UPDATE' }; } } });
    await expect(source.next()).rejects.toThrow(/outside its requested/);
  });
  it('allows consumers to throw into a live polling iterator and closes it', async () => {
    const source = field('accounts').subscribe({}, { id: ['alice'] }, { repository: { get: async () => ({ id: 'alice', data: {} }) } });
    await source.next(); const failure = new Error('consumer aborted'); await expect(source.throw(failure)).rejects.toBe(failure); expect(await source.next()).toMatchObject({ done: true });
  });
});
