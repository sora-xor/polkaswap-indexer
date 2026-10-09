import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const pool = { query: vi.fn(), on: vi.fn(), end: vi.fn(), connect: vi.fn() };
  return { pool, Pool: vi.fn(function MockPool() { return pool; }) };
});
vi.mock('pg', () => ({ default: { Pool: mocks.Pool } }));
const { PostgresRepository } = await import('../src/repository/postgres.js');

afterEach(() => vi.clearAllMocks());

describe('reference PostgreSQL bounded tail selection', () => {
  it.each([
    [{ last: 2 }, 8, 2],
    [{ first: 5, last: 2 }, 3, 2],
    [{ first: 100, last: 2, after: '4' }, 8, 2],
    [{ last: 100, offset: 9 }, 9, 1],
  ] as const)('selects the tail before sending bounded documents for %j', async (window, expectedOffset, expectedLimit) => {
    mocks.pool.query.mockResolvedValueOnce({ rows: [{ count: 10 }] });
    mocks.pool.query.mockResolvedValueOnce({ rows: [{ collection: 'assets', id: 'tail', data: { id: 'tail', priceUSD: '1' }, __cursorValue: 'tail', __candidateCount: 1 }] });
    const repository = new PostgresRepository('postgres://local-fixture-only');
    const result = await repository.query('assets', { ...window, orderBy: ['ID_ASC'], maxBytes: 1_024 });
    expect(mocks.pool.query).toHaveBeenCalledTimes(2);
    const [countSql] = mocks.pool.query.mock.calls[0]!;
    const [selectSql, values] = mocks.pool.query.mock.calls[1]!;
    expect(String(countSql)).toContain('count(*)');
    expect(String(selectSql)).toContain('budgeted_ids');
    expect(values).toEqual(['assets', expectedLimit, expectedOffset, 1_024]);
    expect(result.pageStart).toBe(expectedOffset);
    expect(result.totalCount).toBe(10);
    await repository.close();
  });
});
