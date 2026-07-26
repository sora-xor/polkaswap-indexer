import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const client = {
    query: vi.fn(),
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn().mockResolvedValue(client),
    end: vi.fn(),
    on: vi.fn(),
  };
  const Pool = vi.fn(function MockPool() {
    return pool;
  });

  return { Pool, client, pool };
});

vi.mock('pg', () => ({
  default: {
    Pool: mocks.Pool,
  },
}));

const { migrate, POSTGRES_DOCUMENT_CHECK_CONSTRAINTS, POSTGRES_QUERY_INDEX_DEFINITIONS, POSTGRES_SECONDARY_INDEX_DEFINITIONS } = await import(
  '../src/db/migrate.js'
);

const DATABASE_URL = 'postgres://polkaswap:polkaswap@localhost:5432/polkaswap_indexer';

describe('migrate', () => {
  afterEach(() => {
    mocks.Pool.mockClear();
    mocks.pool.connect.mockClear();
    mocks.pool.end.mockClear();
    mocks.pool.on.mockReset();
    mocks.client.release.mockClear();
    mocks.client.query.mockReset();
  });

  it('does not build the costly createdAtTimestamp index during startup migration', async () => {
    mocks.client.query.mockResolvedValue({ rows: [] });

    await migrate(DATABASE_URL);

    const createIndexSql = mocks.client.query.mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => sql.includes('indexer_documents_collection_created_at_timestamp_idx'));

    expect(createIndexSql).toBeUndefined();
  });

  it('constructs the migration pool with dedicated long-running operation timeouts', async () => {
    mocks.client.query.mockResolvedValue({ rows: [] });

    await migrate({
      databaseUrl: DATABASE_URL,
      postgresConnectionTimeoutMs: 7_000,
      postgresMigrationQueryTimeoutMs: 8_000,
      postgresMigrationStatementTimeoutMs: 9_000,
    });

    expect(mocks.Pool).toHaveBeenCalledWith({
      connectionString: DATABASE_URL,
      connectionTimeoutMillis: 7_000,
      query_timeout: 8_000,
      statement_timeout: 9_000,
      options: '-c search_path=pg_catalog,public,pg_temp',
    });
  });

  it('leaves long-running migration queries unlimited by default', async () => {
    mocks.client.query.mockResolvedValue({ rows: [] });

    await migrate(DATABASE_URL);

    expect(mocks.Pool).toHaveBeenCalledWith({
      connectionString: DATABASE_URL,
      connectionTimeoutMillis: 10_000,
      query_timeout: 0,
      statement_timeout: 0,
      options: '-c search_path=pg_catalog,public,pg_temp',
    });
  });

  it('creates the Polkamarkt market snapshot lookup index', async () => {
    mocks.client.query.mockResolvedValue({ rows: [] });

    await migrate(DATABASE_URL);

    const createIndexSql = mocks.client.query.mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => sql.includes('indexer_documents_market_snapshots_market_type_block_idx'));

    expect(createIndexSql).toContain("then (data->>'marketId')::numeric else null end");
    expect(createIndexSql).toContain("(data->>'type')");
    expect(createIndexSql).toContain('block_height');
    expect(createIndexSql).toContain('id collate "C"');
    expect(createIndexSql).toContain("where collection = 'marketSnapshots'");
  });

  it('creates every audited query-plan index and removes broad superseded JSON indexes', async () => {
    mocks.client.query.mockResolvedValue({ rows: [] });

    await migrate(DATABASE_URL);
    const statements = mocks.client.query.mock.calls.map(([sql]) => String(sql));
    for (const definition of POSTGRES_SECONDARY_INDEX_DEFINITIONS) {
      const statement = statements.find((sql) =>
        sql.includes(`create index concurrently "${definition.name}"`)
      );
      expect(statement, definition.name).toContain(definition.definition);
      expect(statement, definition.name).toContain(`where ${definition.predicate}`);
    }

    for (const obsolete of [
      'indexer_documents_collection_type_timestamp_id_idx',
      'indexer_documents_collection_asset_id_idx',
      'indexer_documents_collection_account_id_idx',
      'indexer_documents_collection_module_method_timestamp_id_idx',
      'indexer_documents_collection_status_idx',
    ]) {
      expect(statements).toContain(`drop index if exists public."${obsolete}";`);
      expect(statements.some((sql) => sql.includes(`create index concurrently "${obsolete}" `))).toBe(false);
    }
  });

  it('creates locale-independent keyset indexes without redundant single-column time indexes', async () => {
    mocks.client.query.mockResolvedValue({ rows: [] });

    await migrate(DATABASE_URL);
    const statements = mocks.client.query.mock.calls.map(([sql]) => String(sql));
    expect(statements).toContain(
      'drop index if exists public.indexer_documents_collection_timestamp_idx;'
    );
    expect(statements).toContain(
      'drop index if exists public.indexer_documents_collection_block_idx;'
    );
    expect(statements.some((sql) => sql.includes('collection collate "C", timestamp, id collate "C"'))).toBe(true);
    expect(
      statements.some(
        (sql) =>
          sql.includes('indexer_documents_history_liquidity_swap_address_block_idx') &&
          sql.includes('(data->>\'address\'), block_height, id collate "C"') &&
          sql.includes("data->>'module' = 'liquidityProxy'")
      )
    ).toBe(true);
    expect(
      statements.some(
        (sql) => sql.includes('indexer_documents_collection_liquidity_idx') && sql.includes('else null end') && sql.includes('id collate "C"')
      )
    ).toBe(true);
  });

  it('installs database checks matching the repository document contract', async () => {
    mocks.client.query.mockResolvedValue({ rows: [] });

    await migrate(DATABASE_URL);
    const statements = mocks.client.query.mock.calls.map(([sql]) => String(sql));
    const table =
      statements.find((sql) =>
        sql.includes('create table if not exists public.indexer_documents')
      ) ?? '';
    const workerFenceTable = statements.find((sql) =>
      sql.includes('create table if not exists public.polkaswap_indexer_worker_lease_fence')
    );
    expect(table).toContain('collection text collate "C" not null');
    expect(table).toContain('id text collate "C" not null');
    expect(
      statements.some(
        (sql) => sql.includes("attname in ('collection', 'id')") && sql.includes('collation drift')
      )
    ).toBe(true);
    expect(table).not.toContain('constraint indexer_documents_');
    expect(workerFenceTable).toContain('fencing_token uuid not null');
    expect(statements).toContain(
      'drop index if exists public."indexer_documents_collection_id_c_idx";'
    );
    expect(
      statements.some((sql) =>
        sql.includes(
          'create or replace function public.indexer_json_number_is_exact_v1'
        )
      )
    ).toBe(true);
    for (const { name, expression } of POSTGRES_DOCUMENT_CHECK_CONSTRAINTS) {
      expect(
        statements.some((sql) =>
          sql.includes(`add constraint "${name}" check (${expression}) not valid`)
        ),
        name
      ).toBe(true);
      expect(
        statements.some((sql) =>
          sql.includes(`comment on constraint "${name}" on public.indexer_documents`)
        ),
        name
      ).toBe(true);
      expect(
        statements.some((sql) => sql.includes(`validate constraint "${name}"`)),
        name
      ).toBe(true);
    }
  });

  it('retries validation without rebuilding a correctly manifested unvalidated constraint', async () => {
    const firstConstraint = POSTGRES_DOCUMENT_CHECK_CONSTRAINTS[0]!;
    const secondConstraint = POSTGRES_DOCUMENT_CHECK_CONSTRAINTS[1]!;
    let failedValidation = false;
    mocks.client.query.mockImplementation(async (sql: unknown) => {
      const statement = String(sql);
      if (!failedValidation && statement.includes(`validate constraint "${firstConstraint.name}"`)) {
        failedValidation = true;
        throw new Error('validation interrupted');
      }
      return { rows: [] };
    });

    await expect(migrate(DATABASE_URL)).rejects.toThrow('validation interrupted');
    const firstRunStatements = mocks.client.query.mock.calls.map(([sql]) => String(sql));
    const manifestComments = new Map<string, string>();
    for (const { name } of POSTGRES_DOCUMENT_CHECK_CONSTRAINTS) {
      const comment = firstRunStatements.find((sql) =>
        sql.includes(`comment on constraint "${name}" on public.indexer_documents`)
      );
      const manifest = comment?.match(/ is '([^']+)';$/)?.[1];
      if (manifest) manifestComments.set(name, manifest);
    }
    expect(manifestComments.get(firstConstraint.name)).toMatch(/^polkaswap-indexer:constraint-v1:/);

    const secondRunStart = mocks.client.query.mock.calls.length;
    mocks.client.query.mockImplementation(async (sql: unknown, values?: unknown[]) => {
      if (String(sql).includes('from pg_constraint c')) {
        const name = String(values?.[0] ?? '');
        if (name === firstConstraint.name) {
          return { rows: [{ manifestComment: manifestComments.get(name), isValid: false }] };
        }
        if (name === secondConstraint.name) {
          return { rows: [{ manifestComment: manifestComments.get(name), isValid: true }] };
        }
      }
      return { rows: [] };
    });

    await migrate(DATABASE_URL);
    const secondRunStatements = mocks.client.query.mock.calls
      .slice(secondRunStart)
      .map(([sql]) => String(sql));
    expect(secondRunStatements.some((sql) => sql.includes(`drop constraint "${firstConstraint.name}"`))).toBe(false);
    expect(secondRunStatements.some((sql) => sql.includes(`add constraint "${firstConstraint.name}"`))).toBe(false);
    expect(secondRunStatements.some((sql) => sql.includes(`validate constraint "${firstConstraint.name}"`))).toBe(true);
    expect(secondRunStatements.some((sql) => sql.includes(`validate constraint "${secondConstraint.name}"`))).toBe(false);
  });

  it('replaces a drifted constraint before validating the new manifest', async () => {
    const constraint = POSTGRES_DOCUMENT_CHECK_CONSTRAINTS[0]!;
    mocks.client.query.mockImplementation(async (sql: unknown, values?: unknown[]) => {
      if (String(sql).includes('from pg_constraint c') && values?.[0] === constraint.name) {
        return { rows: [{ manifestComment: 'unexpected-manifest', isValid: true }] };
      }
      return { rows: [] };
    });

    await migrate(DATABASE_URL);
    const statements = mocks.client.query.mock.calls.map(([sql]) => String(sql));
    expect(statements).toContain(
      `alter table public.indexer_documents drop constraint "${constraint.name}";`
    );
    expect(
      statements.some((sql) =>
        sql.includes(`add constraint "${constraint.name}" check (${constraint.expression}) not valid`)
      )
    ).toBe(true);
    expect(statements.some((sql) => sql.includes(`validate constraint "${constraint.name}"`))).toBe(true);
  });
});
