import { describe, expect, it, vi } from 'vitest';

import {
  productionMigrationCliErrorMessage,
  readProductionDatabaseTopology,
  runProductionMigration,
} from '../src/scripts/production-migrate.js';

import type { MigrationRuntimeConfig } from '../src/db/migrate.js';
import type {
  ProductionDatabaseSessionIdentity,
  ProductionDatabaseTopology,
  ProductionRuntimeDatabasePrivileges,
} from '../src/scripts/production-migrate.js';

const OWNER_URL = 'postgresql://pi_migration_owner:owner-secret@database.internal:5432/polkaswap?sslmode=verify-full';
const API_URL = 'postgresql://pi_api:api-secret@database.internal:5432/polkaswap?sslmode=verify-full';
const WORKER_URL = 'postgresql://pi_worker:worker-secret@database.internal:5432/polkaswap?sslmode=verify-full';

const validEnvironment = (
  overrides: NodeJS.ProcessEnv = {}
): NodeJS.ProcessEnv => ({
  DATABASE_URL: OWNER_URL,
  POLKASWAP_API_DATABASE_URL: API_URL,
  POLKASWAP_WORKER_DATABASE_URL: WORKER_URL,
  ...overrides,
});

const migrationConfig = (databaseUrl = OWNER_URL): MigrationRuntimeConfig => ({
  databaseUrl,
  postgresConnectionTimeoutMs: 8_000,
  postgresMigrationQueryTimeoutMs: 0,
  postgresMigrationStatementTimeoutMs: 0,
});

const productionDatabaseTopology = (): ProductionDatabaseTopology => ({
  migrationOwnerUrl: OWNER_URL,
  apiUrl: API_URL,
  workerUrl: WORKER_URL,
});

const productionDatabaseSessionIdentities = (): ProductionDatabaseSessionIdentity[] => [
  {
    currentRole: 'pi_migration_owner',
    sessionRole: 'pi_migration_owner',
    databaseIdentity: 'polkaswap',
    searchPath: 'pg_catalog,public,pg_temp',
    isSuperuser: false,
    canCreateRoles: false,
    canCreateDatabases: false,
    canReplicate: false,
    canBypassRowSecurity: false,
    canCreateDatabaseObjects: true,
    canCreateInPublicSchema: true,
    ownsApplicationObjects: true,
    isMigrationOwnerMember: true,
    canAssumeElevatedRole: false,
    isDatabaseOwnerMember: true,
    hasUnexpectedRoleMembership: false,
  },
  {
    currentRole: 'pi_api',
    sessionRole: 'pi_api',
    databaseIdentity: 'polkaswap',
    searchPath: 'pg_catalog,public,pg_temp',
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
    isDatabaseOwnerMember: false,
    hasUnexpectedRoleMembership: false,
  },
  {
    currentRole: 'pi_worker',
    sessionRole: 'pi_worker',
    databaseIdentity: 'polkaswap',
    searchPath: 'pg_catalog,public,pg_temp',
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
    isDatabaseOwnerMember: false,
    hasUnexpectedRoleMembership: false,
  },
];

const productionRuntimeDatabasePrivileges =
  (): ProductionRuntimeDatabasePrivileges[] => [
    {
      currentRole: 'pi_api',
      sessionRole: 'pi_api',
      databaseIdentity: 'polkaswap',
      searchPath: 'pg_catalog,public,pg_temp',
      hasOtherRoleMembership: false,
      canSelectDocuments: true,
      canInsertDocuments: false,
      canUpdateDocuments: false,
      canDeleteDocuments: false,
      canTruncateDocuments: false,
      canReferenceDocuments: false,
      canTriggerDocuments: false,
      canInsertAnyDocumentColumn: false,
      canUpdateAnyDocumentColumn: false,
      canReferenceAnyDocumentColumn: false,
      hasDocumentTableGrantOptions: false,
      hasDocumentColumnGrantOptions: false,
      canSelectWorkerFence: false,
      canInsertWorkerFence: false,
      canUpdateWorkerFence: false,
      canDeleteWorkerFence: false,
      canTruncateWorkerFence: false,
      canReferenceWorkerFence: false,
      canTriggerWorkerFence: false,
      canSelectAnyWorkerFenceColumn: false,
      canInsertAnyWorkerFenceColumn: false,
      canUpdateAnyWorkerFenceColumn: false,
      canReferenceAnyWorkerFenceColumn: false,
      hasWorkerFenceTableGrantOptions: false,
      hasWorkerFenceColumnGrantOptions: false,
    },
    {
      currentRole: 'pi_worker',
      sessionRole: 'pi_worker',
      databaseIdentity: 'polkaswap',
      searchPath: 'pg_catalog,public,pg_temp',
      hasOtherRoleMembership: false,
      canSelectDocuments: true,
      canInsertDocuments: true,
      canUpdateDocuments: true,
      canDeleteDocuments: true,
      canTruncateDocuments: false,
      canReferenceDocuments: false,
      canTriggerDocuments: false,
      canInsertAnyDocumentColumn: true,
      canUpdateAnyDocumentColumn: true,
      canReferenceAnyDocumentColumn: false,
      hasDocumentTableGrantOptions: false,
      hasDocumentColumnGrantOptions: false,
      canSelectWorkerFence: true,
      canInsertWorkerFence: true,
      canUpdateWorkerFence: true,
      canDeleteWorkerFence: false,
      canTruncateWorkerFence: false,
      canReferenceWorkerFence: false,
      canTriggerWorkerFence: false,
      canSelectAnyWorkerFenceColumn: true,
      canInsertAnyWorkerFenceColumn: true,
      canUpdateAnyWorkerFenceColumn: true,
      canReferenceAnyWorkerFenceColumn: false,
      hasWorkerFenceTableGrantOptions: false,
      hasWorkerFenceColumnGrantOptions: false,
    },
  ];

describe('production PostgreSQL migration credential preflight', () => {
  it('accepts distinct roles on one canonical database target', () => {
    expect(readProductionDatabaseTopology(validEnvironment())).toEqual(
      productionDatabaseTopology()
    );
  });

  it.each([
    ['global TLS disable', 'NODE_TLS_REJECT_UNAUTHORIZED', '0'],
    ['Node preload', 'NODE_OPTIONS', '--require=/tmp/unreviewed.js'],
    ['shadow search path', 'PGOPTIONS', '-c search_path=attacker,public'],
    ['TLS mode override', 'PGSSLMODE', 'disable'],
    ['password fallback', 'PGPASSWORD', 'migration-secret-must-not-log'],
  ])('rejects the %s process override before config or DDL', async (_label, name, value) => {
    const readMigrationConfig = vi.fn(() => migrationConfig());
    const readDatabaseIdentities = vi.fn(async () => productionDatabaseSessionIdentities());
    const applyRuntimeDatabasePrivileges = vi.fn(async () => undefined);
    const readRuntimeDatabasePrivileges = vi.fn(
      async () => productionRuntimeDatabasePrivileges()
    );
    const migrate = vi.fn(async () => undefined);

    const operation = runProductionMigration(validEnvironment({ [name]: value }), {
      readMigrationConfig,
      readDatabaseIdentities,
      applyRuntimeDatabasePrivileges,
      readRuntimeDatabasePrivileges,
      migrate,
    });
    await expect(operation).rejects.toThrow(
      'Production database credential preflight failed: process-environment-override'
    );
    await operation.catch((error: unknown) => {
      expect(String(error)).not.toContain(value);
    });
    expect(readMigrationConfig).not.toHaveBeenCalled();
    expect(readDatabaseIdentities).not.toHaveBeenCalled();
    expect(applyRuntimeDatabasePrivileges).not.toHaveBeenCalled();
    expect(readRuntimeDatabasePrivileges).not.toHaveBeenCalled();
    expect(migrate).not.toHaveBeenCalled();
  });

  it('normalizes protocol aliases, host case, default ports, and escaped database names', () => {
    expect(() =>
      readProductionDatabaseTopology({
        DATABASE_URL:
          'postgres://owner:one@DATABASE.INTERNAL/polkaswap%5Findexer?sslmode=verify-full',
        POLKASWAP_API_DATABASE_URL:
          'postgresql://api:two@database.internal:5432/polkaswap_indexer?sslmode=verify-full',
        POLKASWAP_WORKER_DATABASE_URL:
          'postgres://worker:three@database.internal/polkaswap_indexer?sslmode=verify-full',
      })
    ).not.toThrow();
  });

  it('runs DDL exactly once only after the topology passes', async () => {
    const config = migrationConfig();
    const readMigrationConfig = vi.fn(() => config);
    const readDatabaseIdentities = vi.fn(async () => productionDatabaseSessionIdentities());
    const readRuntimeDatabasePrivileges = vi.fn(
      async () => productionRuntimeDatabasePrivileges()
    );
    const applyRuntimeDatabasePrivileges = vi.fn(async () => undefined);
    const migrate = vi.fn(async () => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await runProductionMigration(validEnvironment(), {
      readMigrationConfig,
      readDatabaseIdentities,
      applyRuntimeDatabasePrivileges,
      readRuntimeDatabasePrivileges,
      migrate,
    });

    expect(readMigrationConfig).toHaveBeenCalledTimes(1);
    expect(readDatabaseIdentities).toHaveBeenCalledTimes(2);
    expect(readDatabaseIdentities).toHaveBeenCalledWith(productionDatabaseTopology(), config);
    expect(migrate).toHaveBeenCalledTimes(1);
    expect(migrate).toHaveBeenCalledWith(config);
    expect(applyRuntimeDatabasePrivileges).toHaveBeenCalledWith(
      productionDatabaseTopology(),
      config
    );
    expect(readRuntimeDatabasePrivileges).toHaveBeenCalledTimes(1);
    expect(readRuntimeDatabasePrivileges).toHaveBeenCalledWith(
      productionDatabaseTopology(),
      config
    );
    expect(readDatabaseIdentities.mock.invocationCallOrder[0]).toBeLessThan(
      migrate.mock.invocationCallOrder[0]!
    );
    expect(migrate.mock.invocationCallOrder[0]).toBeLessThan(
      applyRuntimeDatabasePrivileges.mock.invocationCallOrder[0]!
    );
    expect(applyRuntimeDatabasePrivileges.mock.invocationCallOrder[0]).toBeLessThan(
      readDatabaseIdentities.mock.invocationCallOrder[1]!
    );
    expect(readDatabaseIdentities.mock.invocationCallOrder[1]).toBeLessThan(
      readRuntimeDatabasePrivileges.mock.invocationCallOrder[0]!
    );
    expect(info).toHaveBeenNthCalledWith(
      1,
      'Verified distinct least-privilege production PostgreSQL sessions before schema migration'
    );
    expect(info).toHaveBeenNthCalledWith(
      2,
      'Verified production PostgreSQL sessions and exact table/column privileges after schema migration'
    );
    info.mockRestore();
  });

  it('rejects identical URLs before reading migration config or executing DDL', async () => {
    const readMigrationConfig = vi.fn(() => migrationConfig());
    const readDatabaseIdentities = vi.fn(async () => productionDatabaseSessionIdentities());
    const readRuntimeDatabasePrivileges = vi.fn(
      async () => productionRuntimeDatabasePrivileges()
    );
    const applyRuntimeDatabasePrivileges = vi.fn(async () => undefined);
    const migrate = vi.fn(async () => undefined);
    const shared =
      'postgresql://shared:do-not-log@secret-db.internal/polkaswap?sslmode=verify-full';

    await expect(
      runProductionMigration(
        {
          DATABASE_URL: shared,
          POLKASWAP_API_DATABASE_URL: shared,
          POLKASWAP_WORKER_DATABASE_URL: shared,
        },
        {
          readMigrationConfig,
          readDatabaseIdentities,
          applyRuntimeDatabasePrivileges,
          readRuntimeDatabasePrivileges,
          migrate,
        }
      )
    ).rejects.toThrow('Production database credential preflight failed: database-url-reuse');

    expect(readMigrationConfig).not.toHaveBeenCalled();
    expect(readDatabaseIdentities).not.toHaveBeenCalled();
    expect(applyRuntimeDatabasePrivileges).not.toHaveBeenCalled();
    expect(readRuntimeDatabasePrivileges).not.toHaveBeenCalled();
    expect(migrate).not.toHaveBeenCalled();
  });

  it('rejects one reused role even when passwords and URL spellings differ', () => {
    expect(() =>
      readProductionDatabaseTopology(
        validEnvironment({
          POLKASWAP_API_DATABASE_URL:
            'postgresql://same_role:first-password@database.internal/polkaswap?sslmode=verify-full',
          POLKASWAP_WORKER_DATABASE_URL:
            'postgres://same%5Frole:second-password@DATABASE.INTERNAL:5432/polkaswap?sslmode=verify-full',
        })
      )
    ).toThrow('Production database credential preflight failed: database-role-reuse');
  });

  it.each([
    [
      'host',
      {
        POLKASWAP_WORKER_DATABASE_URL:
          'postgresql://pi_worker:x@other.internal/polkaswap?sslmode=verify-full',
      },
    ],
    [
      'port',
      {
        POLKASWAP_WORKER_DATABASE_URL:
          'postgresql://pi_worker:x@database.internal:6432/polkaswap?sslmode=verify-full',
      },
    ],
    [
      'database',
      {
        POLKASWAP_WORKER_DATABASE_URL:
          'postgresql://pi_worker:x@database.internal/polkaswap_shadow?sslmode=verify-full',
      },
    ],
  ])('rejects a mismatched %s target before migration', (_label, overrides) => {
    expect(() => readProductionDatabaseTopology(validEnvironment(overrides))).toThrow(
      'Production database credential preflight failed: database-target-mismatch'
    );
  });

  it.each([
    ['migration-owner', 'DATABASE_URL'],
    ['api', 'POLKASWAP_API_DATABASE_URL'],
    ['worker', 'POLKASWAP_WORKER_DATABASE_URL'],
  ])('rejects a missing %s URL with a fixed diagnostic', (role, name) => {
    const environment = validEnvironment();
    delete environment[name];
    expect(() => readProductionDatabaseTopology(environment)).toThrow(
      `Production database credential preflight failed: ${role}-url-missing`
    );
  });

  it.each([
    ['migration-owner', 'DATABASE_URL', 'mysql://owner:secret@database.internal/polkaswap'],
    ['api', 'POLKASWAP_API_DATABASE_URL', 'not-a-url'],
    ['worker', 'POLKASWAP_WORKER_DATABASE_URL', ' postgres://worker:x@database.internal/polkaswap'],
    ['api', 'POLKASWAP_API_DATABASE_URL', 'postgresql://:x@database.internal/polkaswap'],
    ['worker', 'POLKASWAP_WORKER_DATABASE_URL', 'postgresql://worker:x@database.internal/'],
    ['migration-owner', 'DATABASE_URL', 'postgresql://owner:x@database.internal/polkaswap#fragment'],
  ])('rejects an invalid %s credential without reflecting it', (role, name, value) => {
    const action = (): void => {
      readProductionDatabaseTopology(validEnvironment({ [name]: value }));
    };
    expect(action).toThrow(`Production database credential preflight failed: ${role}-url-invalid`);
    try {
      action();
    } catch (error) {
      expect(String(error)).not.toContain(value);
      expect(String(error)).not.toContain('secret');
      expect(String(error)).not.toContain('database.internal');
    }
  });

  it.each([
    [
      'host',
      'postgresql://api:x@database.internal/polkaswap?host=attacker.internal&sslmode=verify-full',
    ],
    [
      'user',
      'postgresql://api:x@database.internal/polkaswap?user=owner&sslmode=verify-full',
    ],
    [
      'database',
      'postgresql://api:x@database.internal/polkaswap?dbname=shadow&sslmode=verify-full',
    ],
  ])('rejects a query-string %s target override', (_label, apiUrl) => {
    expect(() =>
      readProductionDatabaseTopology(
        validEnvironment({ POLKASWAP_API_DATABASE_URL: apiUrl })
      )
    ).toThrow('Production database credential preflight failed: api-url-target-override');
  });

  it.each([
    ['query timeout', 'query_timeout=0'],
    ['statement timeout', 'statement_timeout=0'],
    ['startup options', 'options=-c%20statement_timeout%3D0'],
    ['application name', 'application_name=credential-leaking-name'],
    ['connection timeout', 'connect_timeout=0'],
  ])('rejects unsupported %s URL controls before constructing a client', (_label, query) => {
    expect(() =>
      readProductionDatabaseTopology(
        validEnvironment({
          POLKASWAP_API_DATABASE_URL:
            `postgresql://pi_api:x@database.internal/polkaswap?${query}&sslmode=verify-full`,
        })
      )
    ).toThrow(
      'Production database credential preflight failed: api-url-parameter-unsupported'
    );
  });

  it.each([
    [
      'duplicate parameter',
      'sslnegotiation=direct&sslnegotiation=postgres&sslmode=verify-full',
    ],
    ['mixed-case parameter', 'SSLMODE=verify-full&sslmode=verify-full'],
    ['invalid SSL negotiation', 'sslnegotiation=tunnel&sslmode=verify-full'],
  ])('rejects an ambiguous or invalid %s', (_label, query) => {
    expect(() =>
      readProductionDatabaseTopology(
        validEnvironment({
          POLKASWAP_API_DATABASE_URL:
            `postgresql://pi_api:x@database.internal/polkaswap?${query}`,
        })
      )
    ).toThrow('Production database credential preflight failed: api-url-parameter-invalid');
  });

  it.each([
    ['missing mode', ''],
    ['plaintext mode', '?sslmode=disable'],
    ['downgrade mode', '?sslmode=prefer'],
    ['hostname-unverified mode', '?sslmode=require'],
    ['CA-only mode', '?sslmode=verify-ca'],
    ['verification disabled', '?sslmode=no-verify'],
  ])('rejects %s instead of sending production credentials', (_label, suffix) => {
    expect(() =>
      readProductionDatabaseTopology(
        validEnvironment({
          POLKASWAP_API_DATABASE_URL:
            `postgresql://pi_api:x@database.internal/polkaswap${suffix}`,
        })
      )
    ).toThrow(
      `Production database credential preflight failed: api-url-tls-${
        suffix ? 'invalid' : 'required'
      }`
    );
  });

  it('accepts only the audited PostgreSQL TLS URL controls', () => {
    expect(() =>
      readProductionDatabaseTopology(
        validEnvironment({
          DATABASE_URL:
            'postgresql://pi_migration_owner:x@database.internal/polkaswap?sslmode=verify-full&sslnegotiation=direct',
          POLKASWAP_API_DATABASE_URL:
            'postgresql://pi_api:x@database.internal/polkaswap?sslmode=verify-full&sslnegotiation=direct',
          POLKASWAP_WORKER_DATABASE_URL:
            'postgresql://pi_worker:x@database.internal/polkaswap?sslmode=verify-full&sslnegotiation=direct',
        })
      )
    ).not.toThrow();
  });

  it('rejects configuration drift before executing DDL', async () => {
    const readDatabaseIdentities = vi.fn(async () => productionDatabaseSessionIdentities());
    const readRuntimeDatabasePrivileges = vi.fn(
      async () => productionRuntimeDatabasePrivileges()
    );
    const applyRuntimeDatabasePrivileges = vi.fn(async () => undefined);
    const migrate = vi.fn(async () => undefined);

    await expect(
      runProductionMigration(validEnvironment(), {
        readMigrationConfig: () =>
          migrationConfig(
            'postgresql://different_owner:x@database.internal:5432/polkaswap?sslmode=verify-full'
          ),
        readDatabaseIdentities,
        applyRuntimeDatabasePrivileges,
        readRuntimeDatabasePrivileges,
        migrate,
      })
    ).rejects.toThrow(
      'Production database credential preflight failed: migration-owner-config-mismatch'
    );
    expect(readDatabaseIdentities).not.toHaveBeenCalled();
    expect(applyRuntimeDatabasePrivileges).not.toHaveBeenCalled();
    expect(readRuntimeDatabasePrivileges).not.toHaveBeenCalled();
    expect(migrate).not.toHaveBeenCalled();
  });

  it.each([
    [
      'current role',
      (identities: ProductionDatabaseSessionIdentity[]) => {
        identities[1]!.currentRole = 'pi_migration_owner';
      },
    ],
    [
      'session role',
      (identities: ProductionDatabaseSessionIdentity[]) => {
        identities[1]!.sessionRole = 'unexpected_pi_api';
      },
    ],
  ])('rejects an unexpected live API %s before executing DDL', async (_label, mutate) => {
    const identities = productionDatabaseSessionIdentities();
    mutate(identities);
    const migrate = vi.fn(async () => undefined);

    await expect(
      runProductionMigration(validEnvironment(), {
        readMigrationConfig: () => migrationConfig(),
        readDatabaseIdentities: async () => identities,
        applyRuntimeDatabasePrivileges: async () => undefined,
        readRuntimeDatabasePrivileges: async () => productionRuntimeDatabasePrivileges(),
        migrate,
      })
    ).rejects.toThrow(
      'Production database credential preflight failed: database-session-role-mismatch'
    );
    expect(migrate).not.toHaveBeenCalled();
  });

  it('rejects an unexpected live database before executing DDL', async () => {
    const identities = productionDatabaseSessionIdentities();
    identities[2]!.databaseIdentity = 'polkaswap_shadow';
    const migrate = vi.fn(async () => undefined);

    await expect(
      runProductionMigration(validEnvironment(), {
        readMigrationConfig: () => migrationConfig(),
        readDatabaseIdentities: async () => identities,
        applyRuntimeDatabasePrivileges: async () => undefined,
        readRuntimeDatabasePrivileges: async () => productionRuntimeDatabasePrivileges(),
        migrate,
      })
    ).rejects.toThrow(
      'Production database credential preflight failed: database-session-target-mismatch'
    );
    expect(migrate).not.toHaveBeenCalled();
  });

  it('rejects a reused live session role before executing DDL', async () => {
    const identities = productionDatabaseSessionIdentities();
    identities[1]!.sessionRole = 'pi_migration_owner';
    const migrate = vi.fn(async () => undefined);

    await expect(
      runProductionMigration(validEnvironment(), {
        readMigrationConfig: () => migrationConfig(),
        readDatabaseIdentities: async () => identities,
        applyRuntimeDatabasePrivileges: async () => undefined,
        readRuntimeDatabasePrivileges: async () => productionRuntimeDatabasePrivileges(),
        migrate,
      })
    ).rejects.toThrow(
      'Production database credential preflight failed: database-session-role-reuse'
    );
    expect(migrate).not.toHaveBeenCalled();
  });

  it('rejects incomplete live identity results before executing DDL', async () => {
    const migrate = vi.fn(async () => undefined);

    await expect(
      runProductionMigration(validEnvironment(), {
        readMigrationConfig: () => migrationConfig(),
        readDatabaseIdentities: async () => productionDatabaseSessionIdentities().slice(0, 2),
        applyRuntimeDatabasePrivileges: async () => undefined,
        readRuntimeDatabasePrivileges: async () => productionRuntimeDatabasePrivileges(),
        migrate,
      })
    ).rejects.toThrow(
      'Production database credential preflight failed: database-session-check-failed'
    );
    expect(migrate).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a superuser migration owner',
      (identities: ProductionDatabaseSessionIdentity[]) => {
        identities[0]!.isSuperuser = true;
      },
    ],
    [
      'a migration owner without public-schema DDL',
      (identities: ProductionDatabaseSessionIdentity[]) => {
        identities[0]!.canCreateInPublicSchema = false;
      },
    ],
    [
      'a migration owner with an unrelated role membership',
      (identities: ProductionDatabaseSessionIdentity[]) => {
        identities[0]!.hasUnexpectedRoleMembership = true;
      },
    ],
  ])('rejects %s before executing DDL', async (_label, mutate) => {
    const identities = productionDatabaseSessionIdentities();
    mutate(identities);
    const readRuntimeDatabasePrivileges = vi.fn(
      async () => productionRuntimeDatabasePrivileges()
    );
    const migrate = vi.fn(async () => undefined);

    await expect(
      runProductionMigration(validEnvironment(), {
        readMigrationConfig: () => migrationConfig(),
        readDatabaseIdentities: async () => identities,
        applyRuntimeDatabasePrivileges: async () => undefined,
        readRuntimeDatabasePrivileges,
        migrate,
      })
    ).rejects.toThrow(
      'Production database credential preflight failed: database-migration-owner-privileges-invalid'
    );
    expect(migrate).not.toHaveBeenCalled();
    expect(readRuntimeDatabasePrivileges).not.toHaveBeenCalled();
  });

  it.each([
    [
      'superuser',
      (identity: ProductionDatabaseSessionIdentity) => {
        identity.isSuperuser = true;
      },
    ],
    [
      'database creator',
      (identity: ProductionDatabaseSessionIdentity) => {
        identity.canCreateDatabaseObjects = true;
      },
    ],
    [
      'schema creator',
      (identity: ProductionDatabaseSessionIdentity) => {
        identity.canCreateInPublicSchema = true;
      },
    ],
    [
      'application-object owner',
      (identity: ProductionDatabaseSessionIdentity) => {
        identity.ownsApplicationObjects = true;
      },
    ],
    [
      'migration-owner member',
      (identity: ProductionDatabaseSessionIdentity) => {
        identity.isMigrationOwnerMember = true;
      },
    ],
    [
      'assumable DDL role member',
      (identity: ProductionDatabaseSessionIdentity) => {
        identity.canAssumeElevatedRole = true;
      },
    ],
    [
      'database-owner member',
      (identity: ProductionDatabaseSessionIdentity) => {
        identity.isDatabaseOwnerMember = true;
      },
    ],
    [
      'unrelated predefined-role member',
      (identity: ProductionDatabaseSessionIdentity) => {
        identity.hasUnexpectedRoleMembership = true;
      },
    ],
  ])('rejects an elevated API %s before executing DDL', async (_label, mutate) => {
    const identities = productionDatabaseSessionIdentities();
    mutate(identities[1]!);
    const readRuntimeDatabasePrivileges = vi.fn(
      async () => productionRuntimeDatabasePrivileges()
    );
    const migrate = vi.fn(async () => undefined);

    await expect(
      runProductionMigration(validEnvironment(), {
        readMigrationConfig: () => migrationConfig(),
        readDatabaseIdentities: async () => identities,
        applyRuntimeDatabasePrivileges: async () => undefined,
        readRuntimeDatabasePrivileges,
        migrate,
      })
    ).rejects.toThrow(
      'Production database credential preflight failed: database-runtime-role-privileges-invalid'
    );
    expect(migrate).not.toHaveBeenCalled();
    expect(readRuntimeDatabasePrivileges).not.toHaveBeenCalled();
  });

  it('rejects a shadowable PostgreSQL search path before executing DDL', async () => {
    const identities = productionDatabaseSessionIdentities();
    identities[1]!.searchPath = 'attacker, public';
    const migrate = vi.fn(async () => undefined);

    await expect(
      runProductionMigration(validEnvironment(), {
        readMigrationConfig: () => migrationConfig(),
        readDatabaseIdentities: async () => identities,
        applyRuntimeDatabasePrivileges: async () => undefined,
        readRuntimeDatabasePrivileges: async () => productionRuntimeDatabasePrivileges(),
        migrate,
      })
    ).rejects.toThrow(
      'Production database credential preflight failed: database-session-search-path-invalid'
    );
    expect(migrate).not.toHaveBeenCalled();
  });

  it('rechecks all identities after DDL and rejects role-membership drift', async () => {
    const postMigrationIdentities = productionDatabaseSessionIdentities();
    postMigrationIdentities[2]!.hasUnexpectedRoleMembership = true;
    const readDatabaseIdentities = vi
      .fn()
      .mockResolvedValueOnce(productionDatabaseSessionIdentities())
      .mockResolvedValueOnce(postMigrationIdentities);
    const applyRuntimeDatabasePrivileges = vi.fn(async () => undefined);
    const readRuntimeDatabasePrivileges = vi.fn(
      async () => productionRuntimeDatabasePrivileges()
    );
    const migrate = vi.fn(async () => undefined);

    await expect(
      runProductionMigration(validEnvironment(), {
        readMigrationConfig: () => migrationConfig(),
        readDatabaseIdentities,
        applyRuntimeDatabasePrivileges,
        readRuntimeDatabasePrivileges,
        migrate,
      })
    ).rejects.toThrow(
      'Production database credential preflight failed: database-runtime-role-privileges-invalid'
    );
    expect(migrate).toHaveBeenCalledOnce();
    expect(applyRuntimeDatabasePrivileges).toHaveBeenCalledOnce();
    expect(readDatabaseIdentities).toHaveBeenCalledTimes(2);
    expect(readRuntimeDatabasePrivileges).not.toHaveBeenCalled();
  });

  it('rejects API write privileges after migration and blocks runtime handoff', async () => {
    const privileges = productionRuntimeDatabasePrivileges();
    privileges[0]!.canInsertDocuments = true;
    const migrate = vi.fn(async () => undefined);

    await expect(
      runProductionMigration(validEnvironment(), {
        readMigrationConfig: () => migrationConfig(),
        readDatabaseIdentities: async () => productionDatabaseSessionIdentities(),
        applyRuntimeDatabasePrivileges: async () => undefined,
        readRuntimeDatabasePrivileges: async () => privileges,
        migrate,
      })
    ).rejects.toThrow(
      'Production database credential preflight failed: database-api-privileges-invalid'
    );
    expect(migrate).toHaveBeenCalledOnce();
  });

  it('rejects API access to the worker fence after migration', async () => {
    const privileges = productionRuntimeDatabasePrivileges();
    privileges[0]!.canSelectWorkerFence = true;
    const migrate = vi.fn(async () => undefined);

    await expect(
      runProductionMigration(validEnvironment(), {
        readMigrationConfig: () => migrationConfig(),
        readDatabaseIdentities: async () => productionDatabaseSessionIdentities(),
        applyRuntimeDatabasePrivileges: async () => undefined,
        readRuntimeDatabasePrivileges: async () => privileges,
        migrate,
      })
    ).rejects.toThrow(
      'Production database credential preflight failed: database-api-privileges-invalid'
    );
    expect(migrate).toHaveBeenCalledOnce();
  });

  it.each([
    [
      'column-level document UPDATE',
      (privileges: ProductionRuntimeDatabasePrivileges) => {
        privileges.canUpdateAnyDocumentColumn = true;
      },
    ],
    [
      'column-level worker-fence SELECT',
      (privileges: ProductionRuntimeDatabasePrivileges) => {
        privileges.canSelectAnyWorkerFenceColumn = true;
      },
    ],
    [
      'document table grant option',
      (privileges: ProductionRuntimeDatabasePrivileges) => {
        privileges.hasDocumentTableGrantOptions = true;
      },
    ],
    [
      'worker-fence column grant option',
      (privileges: ProductionRuntimeDatabasePrivileges) => {
        privileges.hasWorkerFenceColumnGrantOptions = true;
      },
    ],
  ])('rejects API %s after migration', async (_label, mutate) => {
    const privileges = productionRuntimeDatabasePrivileges();
    mutate(privileges[0]!);

    await expect(
      runProductionMigration(validEnvironment(), {
        readMigrationConfig: () => migrationConfig(),
        readDatabaseIdentities: async () => productionDatabaseSessionIdentities(),
        applyRuntimeDatabasePrivileges: async () => undefined,
        readRuntimeDatabasePrivileges: async () => privileges,
        migrate: async () => undefined,
      })
    ).rejects.toThrow(
      'Production database credential preflight failed: database-api-privileges-invalid'
    );
  });

  it('rejects incomplete worker DML privileges after migration and blocks runtime handoff', async () => {
    const privileges = productionRuntimeDatabasePrivileges();
    privileges[1]!.canUpdateWorkerFence = false;
    const migrate = vi.fn(async () => undefined);

    await expect(
      runProductionMigration(validEnvironment(), {
        readMigrationConfig: () => migrationConfig(),
        readDatabaseIdentities: async () => productionDatabaseSessionIdentities(),
        applyRuntimeDatabasePrivileges: async () => undefined,
        readRuntimeDatabasePrivileges: async () => privileges,
        migrate,
      })
    ).rejects.toThrow(
      'Production database credential preflight failed: database-worker-privileges-invalid'
    );
    expect(migrate).toHaveBeenCalledOnce();
  });

  it('rejects worker DELETE access to its singleton fence after migration', async () => {
    const privileges = productionRuntimeDatabasePrivileges();
    privileges[1]!.canDeleteWorkerFence = true;
    const migrate = vi.fn(async () => undefined);

    await expect(
      runProductionMigration(validEnvironment(), {
        readMigrationConfig: () => migrationConfig(),
        readDatabaseIdentities: async () => productionDatabaseSessionIdentities(),
        applyRuntimeDatabasePrivileges: async () => undefined,
        readRuntimeDatabasePrivileges: async () => privileges,
        migrate,
      })
    ).rejects.toThrow(
      'Production database credential preflight failed: database-worker-privileges-invalid'
    );
    expect(migrate).toHaveBeenCalledOnce();
  });

  it.each([
    [
      'column-level document REFERENCES',
      (privileges: ProductionRuntimeDatabasePrivileges) => {
        privileges.canReferenceAnyDocumentColumn = true;
      },
    ],
    [
      'column-level worker-fence REFERENCES',
      (privileges: ProductionRuntimeDatabasePrivileges) => {
        privileges.canReferenceAnyWorkerFenceColumn = true;
      },
    ],
    [
      'document column grant option',
      (privileges: ProductionRuntimeDatabasePrivileges) => {
        privileges.hasDocumentColumnGrantOptions = true;
      },
    ],
    [
      'worker-fence table grant option',
      (privileges: ProductionRuntimeDatabasePrivileges) => {
        privileges.hasWorkerFenceTableGrantOptions = true;
      },
    ],
  ])('rejects worker %s after migration', async (_label, mutate) => {
    const privileges = productionRuntimeDatabasePrivileges();
    mutate(privileges[1]!);

    await expect(
      runProductionMigration(validEnvironment(), {
        readMigrationConfig: () => migrationConfig(),
        readDatabaseIdentities: async () => productionDatabaseSessionIdentities(),
        applyRuntimeDatabasePrivileges: async () => undefined,
        readRuntimeDatabasePrivileges: async () => privileges,
        migrate: async () => undefined,
      })
    ).rejects.toThrow(
      'Production database credential preflight failed: database-worker-privileges-invalid'
    );
  });

  it('rejects a changed runtime session during the post-migration privilege check', async () => {
    const privileges = productionRuntimeDatabasePrivileges();
    privileges[0]!.currentRole = 'pi_migration_owner';
    const migrate = vi.fn(async () => undefined);

    await expect(
      runProductionMigration(validEnvironment(), {
        readMigrationConfig: () => migrationConfig(),
        readDatabaseIdentities: async () => productionDatabaseSessionIdentities(),
        applyRuntimeDatabasePrivileges: async () => undefined,
        readRuntimeDatabasePrivileges: async () => privileges,
        migrate,
      })
    ).rejects.toThrow(
      'Production database credential preflight failed: database-runtime-session-mismatch'
    );
    expect(migrate).toHaveBeenCalledOnce();
  });

  it.each([
    [
      'search-path drift',
      (privileges: ProductionRuntimeDatabasePrivileges) => {
        privileges.searchPath = 'public, pg_temp';
      },
    ],
    [
      'new role membership',
      (privileges: ProductionRuntimeDatabasePrivileges) => {
        privileges.hasOtherRoleMembership = true;
      },
    ],
  ])('rejects runtime %s during the exact privilege check', async (_label, mutate) => {
    const privileges = productionRuntimeDatabasePrivileges();
    mutate(privileges[0]!);

    await expect(
      runProductionMigration(validEnvironment(), {
        readMigrationConfig: () => migrationConfig(),
        readDatabaseIdentities: async () => productionDatabaseSessionIdentities(),
        applyRuntimeDatabasePrivileges: async () => undefined,
        readRuntimeDatabasePrivileges: async () => privileges,
        migrate: async () => undefined,
      })
    ).rejects.toThrow(
      'Production database credential preflight failed: database-runtime-session-invalid'
    );
  });

  it('does not inspect runtime privileges when schema migration itself fails', async () => {
    const readRuntimeDatabasePrivileges = vi.fn(
      async () => productionRuntimeDatabasePrivileges()
    );
    const migrate = vi.fn(async () => {
      throw new Error('DDL failed with owner-test-password');
    });

    await expect(
      runProductionMigration(validEnvironment(), {
        readMigrationConfig: () => migrationConfig(),
        readDatabaseIdentities: async () => productionDatabaseSessionIdentities(),
        applyRuntimeDatabasePrivileges: async () => undefined,
        readRuntimeDatabasePrivileges,
        migrate,
      })
    ).rejects.toThrow('DDL failed with owner-test-password');
    expect(readRuntimeDatabasePrivileges).not.toHaveBeenCalled();
  });

  it('blocks runtime handoff when exact privilege provisioning fails', async () => {
    const readRuntimeDatabasePrivileges = vi.fn(
      async () => productionRuntimeDatabasePrivileges()
    );
    const migrate = vi.fn(async () => undefined);

    await expect(
      runProductionMigration(validEnvironment(), {
        readMigrationConfig: () => migrationConfig(),
        readDatabaseIdentities: async () => productionDatabaseSessionIdentities(),
        applyRuntimeDatabasePrivileges: async () => {
          throw new Error('grant failed with owner-test-password');
        },
        readRuntimeDatabasePrivileges,
        migrate,
      })
    ).rejects.toThrow('grant failed with owner-test-password');
    expect(migrate).toHaveBeenCalledOnce();
    expect(readRuntimeDatabasePrivileges).not.toHaveBeenCalled();
  });

  it('never executes DDL when a live identity check fails', async () => {
    const migrate = vi.fn(async () => undefined);

    await expect(
      runProductionMigration(validEnvironment(), {
        readMigrationConfig: () => migrationConfig(),
        readDatabaseIdentities: async () => {
          throw new Error('connect ENOTFOUND secret-db.internal as owner with ultra-secret');
        },
        applyRuntimeDatabasePrivileges: async () => undefined,
        readRuntimeDatabasePrivileges: async () => productionRuntimeDatabasePrivileges(),
        migrate,
      })
    ).rejects.toThrow('connect ENOTFOUND secret-db.internal as owner with ultra-secret');
    expect(migrate).not.toHaveBeenCalled();
  });

  it('never reflects reused credentials or identities in a failure message', () => {
    const shared =
      'postgresql://shared_role:ultra-secret@secret-db.internal/polkaswap?sslmode=verify-full';
    try {
      readProductionDatabaseTopology({
        DATABASE_URL: shared,
        POLKASWAP_API_DATABASE_URL: shared,
        POLKASWAP_WORKER_DATABASE_URL: shared,
      });
      throw new Error('Expected credential reuse to fail');
    } catch (error) {
      const message = String(error);
      expect(message).toBe(
        'Error: Production database credential preflight failed: database-url-reuse'
      );
      expect(message).not.toContain('shared_role');
      expect(message).not.toContain('ultra-secret');
      expect(message).not.toContain('secret-db.internal');
    }
  });

  it('redacts unexpected configuration, driver, and migration failures at the CLI boundary', () => {
    const driverError = new Error(
      'connect ENOTFOUND secret-db.internal as pi_migration_owner with ultra-secret'
    );
    expect(productionMigrationCliErrorMessage(driverError)).toBe(
      'Production database migration failed'
    );
    expect(productionMigrationCliErrorMessage(driverError)).not.toContain('secret');
    expect(productionMigrationCliErrorMessage('postgresql://owner:password@host/database')).toBe(
      'Production database migration failed'
    );
  });
});
