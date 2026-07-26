import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MigrationRuntimeConfig } from '../src/db/migrate.js';
import type {
  ProductionDatabaseSessionIdentity,
  ProductionDatabaseTopology,
  ProductionRuntimeDatabasePrivileges,
} from '../src/scripts/production-migrate.js';

const mocks = vi.hoisted(() => {
  type MockClient = {
    config: Record<string, unknown>;
    on: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    connection: {
      stream: {
        destroy: ReturnType<typeof vi.fn>;
      };
    };
  };

  const clients: MockClient[] = [];
  const connectionFailures = new Set<number>();
  const queryFailures = new Set<number>();
  const hangingEnds = new Set<number>();
  let queryRows: Array<Record<string, unknown>> = [];

  const Client = vi.fn(function MockPgClient(config: Record<string, unknown>) {
    const index = clients.length;
    const client = {
      config,
      on: vi.fn(),
      connect: vi.fn(async () => {
        if (connectionFailures.has(index)) {
          throw new Error(`connection leaked credential ${String(config.connectionString)}`);
        }
      }),
      query: vi.fn(async () => {
        if (queryFailures.has(index)) {
          throw new Error(`query leaked credential ${String(config.connectionString)}`);
        }
        return { rows: [queryRows[index]] };
      }),
      end: vi.fn(() =>
        hangingEnds.has(index) ? new Promise<void>(() => undefined) : Promise.resolve()
      ),
      connection: {
        stream: {
          destroy: vi.fn(),
        },
      },
    };
    client.on.mockReturnValue(client);
    clients.push(client);
    return client;
  });

  return {
    Client,
    Pool: vi.fn(),
    clients,
    connectionFailures,
    queryFailures,
    hangingEnds,
    setQueryRows: (rows: Array<Record<string, unknown>>) => {
      queryRows = rows;
    },
  };
});

vi.mock('pg', () => ({
  default: {
    Client: mocks.Client,
    Pool: mocks.Pool,
    escapeIdentifier: (value: string) => `"${value.replace(/"/g, '""')}"`,
  },
}));

const {
  applyProductionRuntimeDatabasePrivileges,
  readProductionDatabaseIdentities,
  readProductionRuntimeDatabasePrivileges,
} = await import('../src/scripts/production-migrate.js');

const topology: ProductionDatabaseTopology = {
  migrationOwnerUrl:
    'postgresql://pi_migration_owner:owner-secret@database.internal/polkaswap?sslmode=verify-full',
  apiUrl:
    'postgresql://pi_api:api-secret@database.internal/polkaswap?sslmode=verify-full',
  workerUrl:
    'postgresql://pi_worker:worker-secret@database.internal/polkaswap?sslmode=verify-full',
};

const config: MigrationRuntimeConfig = {
  databaseUrl: topology.migrationOwnerUrl,
  postgresConnectionTimeoutMs: 250,
  postgresMigrationQueryTimeoutMs: 0,
  postgresMigrationStatementTimeoutMs: 0,
};

const identityRows = (): ProductionDatabaseSessionIdentity[] => [
  {
    currentRole: 'pi_migration_owner',
    sessionRole: 'pi_migration_owner',
    databaseIdentity: 'polkaswap',
    isSuperuser: false,
    canCreateRoles: false,
    canCreateDatabases: false,
    canReplicate: false,
    canBypassRowSecurity: false,
    canCreateDatabaseObjects: true,
    canCreateInPublicSchema: true,
    ownsApplicationObjects: false,
    isMigrationOwnerMember: true,
    canAssumeElevatedRole: false,
  },
  {
    currentRole: 'pi_api',
    sessionRole: 'pi_api',
    databaseIdentity: 'polkaswap',
    isSuperuser: false,
    canCreateRoles: false,
    canCreateDatabases: false,
    canReplicate: false,
    canBypassRowSecurity: false,
    canCreateDatabaseObjects: false,
    canCreateInPublicSchema: false,
    ownsApplicationObjects: false,
    isMigrationOwnerMember: false,
    canAssumeElevatedRole: false,
  },
  {
    currentRole: 'pi_worker',
    sessionRole: 'pi_worker',
    databaseIdentity: 'polkaswap',
    isSuperuser: false,
    canCreateRoles: false,
    canCreateDatabases: false,
    canReplicate: false,
    canBypassRowSecurity: false,
    canCreateDatabaseObjects: false,
    canCreateInPublicSchema: false,
    ownsApplicationObjects: false,
    isMigrationOwnerMember: false,
    canAssumeElevatedRole: false,
  },
];

const runtimePrivilegeRows = (): ProductionRuntimeDatabasePrivileges[] =>
  ['pi_api', 'pi_worker'].map((role, index) => ({
    currentRole: role,
    sessionRole: role,
    databaseIdentity: 'polkaswap',
    canSelectDocuments: true,
    canInsertDocuments: index === 1,
    canUpdateDocuments: index === 1,
    canDeleteDocuments: index === 1,
    canTruncateDocuments: false,
    canReferenceDocuments: false,
    canTriggerDocuments: false,
    canSelectWorkerFence: index === 1,
    canInsertWorkerFence: index === 1,
    canUpdateWorkerFence: index === 1,
    canDeleteWorkerFence: false,
    canTruncateWorkerFence: false,
    canReferenceWorkerFence: false,
    canTriggerWorkerFence: false,
  }));

beforeEach(() => {
  vi.useRealTimers();
  mocks.Client.mockClear();
  mocks.Pool.mockClear();
  mocks.clients.length = 0;
  mocks.connectionFailures.clear();
  mocks.queryFailures.clear();
  mocks.hangingEnds.clear();
  mocks.setQueryRows(identityRows());
});

describe('production PostgreSQL client preflight', () => {
  it('applies the bounded deadline to all identity connections and queries', async () => {
    await expect(readProductionDatabaseIdentities(topology, config)).resolves.toEqual(
      identityRows()
    );

    expect(mocks.Client).toHaveBeenCalledTimes(3);
    for (const [index, client] of mocks.clients.entries()) {
      expect(client.config).toEqual({
        connectionString: [
          topology.migrationOwnerUrl,
          topology.apiUrl,
          topology.workerUrl,
        ][index],
        connectionTimeoutMillis: 250,
        query_timeout: 250,
        statement_timeout: 250,
      });
      expect(client.connect).toHaveBeenCalledOnce();
      expect(client.query).toHaveBeenCalledWith(
        expect.stringContaining('pg_has_role'),
        ['pi_migration_owner']
      );
      expect(client.end).toHaveBeenCalledOnce();
    }
  });

  it.each([
    ['connection', mocks.connectionFailures],
    ['query', mocks.queryFailures],
  ])('converts a one-of-three %s failure to a fixed diagnostic and closes every client', async (
    _label,
    failures
  ) => {
    failures.add(1);

    await expect(readProductionDatabaseIdentities(topology, config)).rejects.toThrow(
      'Production database credential preflight failed: database-session-check-failed'
    );
    expect(mocks.clients).toHaveLength(3);
    expect(mocks.clients.every((client) => client.end.mock.calls.length === 1)).toBe(true);
  });

  it('force-destroys a client whose graceful close exceeds the hard deadline', async () => {
    vi.useFakeTimers();
    mocks.hangingEnds.add(1);

    const pending = readProductionDatabaseIdentities(topology, config);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toEqual(identityRows());
    expect(mocks.clients[1]!.connection.stream.destroy).toHaveBeenCalledOnce();
  });

  it('atomically provisions the exact per-table runtime grants as the migration owner', async () => {
    await expect(
      applyProductionRuntimeDatabasePrivileges(topology, config)
    ).resolves.toBeUndefined();

    const client = mocks.clients[0]!;
    expect(client.query.mock.calls.map(([query]) => query)).toEqual([
      expect.stringContaining('current_user::text'),
      'begin',
      'revoke all privileges on table public.indexer_documents from "pi_api", "pi_worker"',
      'revoke all privileges on table public.polkaswap_indexer_worker_lease_fence from "pi_api", "pi_worker"',
      'grant select on table public.indexer_documents to "pi_api"',
      'grant select, insert, update, delete on table public.indexer_documents to "pi_worker"',
      'grant select, insert, update on table public.polkaswap_indexer_worker_lease_fence to "pi_worker"',
      'commit',
    ]);
    expect(client.end).toHaveBeenCalledOnce();
  });

  it('checks the two runtime sessions with the same bounded client contract', async () => {
    mocks.setQueryRows(runtimePrivilegeRows());

    await expect(
      readProductionRuntimeDatabasePrivileges(topology, config)
    ).resolves.toEqual(runtimePrivilegeRows());
    expect(mocks.Client).toHaveBeenCalledTimes(2);
    expect(mocks.clients.every((client) => client.end.mock.calls.length === 1)).toBe(true);
    expect(mocks.clients[0]!.query).toHaveBeenCalledWith(
      expect.stringContaining('canSelectDocuments')
    );
    expect(mocks.clients[0]!.query).toHaveBeenCalledWith(
      expect.stringContaining('reachable_runtime_roles')
    );
    expect(mocks.clients[0]!.query).toHaveBeenCalledWith(
      expect.stringContaining("pg_has_role(current_user, assumable.oid, 'MEMBER')")
    );
  });

  it('converts a post-migration privilege query failure to a fixed diagnostic', async () => {
    mocks.setQueryRows(runtimePrivilegeRows());
    mocks.queryFailures.add(0);

    await expect(
      readProductionRuntimeDatabasePrivileges(topology, config)
    ).rejects.toThrow(
      'Production database credential preflight failed: database-runtime-privilege-check-failed'
    );
    expect(mocks.clients.every((client) => client.end.mock.calls.length === 1)).toBe(true);
  });
});
