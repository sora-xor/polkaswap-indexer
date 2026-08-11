import { readConfig } from '../config.js';
import { migrate } from '../db/migrate.js';
import {
  findUnsafePostgresProcessEnvironmentOverride,
  POSTGRES_TRUSTED_SEARCH_PATH,
  POSTGRES_TRUSTED_SESSION_OPTIONS,
} from '../postgres-session.js';
import pg from 'pg';

import type { MigrationRuntimeConfig } from '../db/migrate.js';

const { Client } = pg;

const OWNER_URL_ENV = 'DATABASE_URL';
const API_URL_ENV = 'POLKASWAP_API_DATABASE_URL';
const WORKER_URL_ENV = 'POLKASWAP_WORKER_DATABASE_URL';
const TARGET_OVERRIDE_QUERY_PARAMETERS = new Set([
  'database',
  'dbname',
  'host',
  'password',
  'port',
  'user',
  'username',
]);
const ALLOWED_CONNECTION_QUERY_PARAMETERS = new Set(['sslmode', 'sslnegotiation']);
const ALLOWED_SSL_NEGOTIATION_MODES = new Set(['direct', 'postgres']);
const DATABASE_CLIENT_CLOSE_TIMEOUT_MS = 1_000;

type ProductionDatabaseRole = 'migration-owner' | 'api' | 'worker';

type ValidatedProductionDatabaseUrl = {
  href: string;
  roleIdentity: string;
  databaseIdentity: string;
  targetIdentity: string;
};

export type ProductionDatabaseTopology = {
  migrationOwnerUrl: string;
  apiUrl: string;
  workerUrl: string;
};

export type ProductionDatabaseSessionIdentity = {
  currentRole: string;
  sessionRole: string;
  databaseIdentity: string;
  searchPath: string;
  isSuperuser: boolean;
  canCreateRoles: boolean;
  canCreateDatabases: boolean;
  canReplicate: boolean;
  canBypassRowSecurity: boolean;
  canCreateDatabaseObjects: boolean;
  canCreateInPublicSchema: boolean;
  ownsApplicationObjects: boolean;
  isMigrationOwnerMember: boolean;
  canAssumeElevatedRole: boolean;
  isDatabaseOwnerMember: boolean;
  hasUnexpectedRoleMembership: boolean;
};

export type ProductionRuntimeDatabasePrivileges = {
  currentRole: string;
  sessionRole: string;
  databaseIdentity: string;
  searchPath: string;
  hasOtherRoleMembership: boolean;
  canSelectDocuments: boolean;
  canInsertDocuments: boolean;
  canUpdateDocuments: boolean;
  canDeleteDocuments: boolean;
  canTruncateDocuments: boolean;
  canReferenceDocuments: boolean;
  canTriggerDocuments: boolean;
  canInsertAnyDocumentColumn: boolean;
  canUpdateAnyDocumentColumn: boolean;
  canReferenceAnyDocumentColumn: boolean;
  hasDocumentTableGrantOptions: boolean;
  hasDocumentColumnGrantOptions: boolean;
  canSelectWorkerFence: boolean;
  canInsertWorkerFence: boolean;
  canUpdateWorkerFence: boolean;
  canDeleteWorkerFence: boolean;
  canTruncateWorkerFence: boolean;
  canReferenceWorkerFence: boolean;
  canTriggerWorkerFence: boolean;
  canSelectAnyWorkerFenceColumn: boolean;
  canInsertAnyWorkerFenceColumn: boolean;
  canUpdateAnyWorkerFenceColumn: boolean;
  canReferenceAnyWorkerFenceColumn: boolean;
  hasWorkerFenceTableGrantOptions: boolean;
  hasWorkerFenceColumnGrantOptions: boolean;
};

export type ProductionMigrationDependencies = {
  readMigrationConfig(): MigrationRuntimeConfig;
  readDatabaseIdentities(
    topology: ProductionDatabaseTopology,
    config: MigrationRuntimeConfig
  ): Promise<ProductionDatabaseSessionIdentity[]>;
  readRuntimeDatabasePrivileges(
    topology: ProductionDatabaseTopology,
    config: MigrationRuntimeConfig
  ): Promise<ProductionRuntimeDatabasePrivileges[]>;
  applyRuntimeDatabasePrivileges(
    topology: ProductionDatabaseTopology,
    config: MigrationRuntimeConfig
  ): Promise<void>;
  migrate(config: MigrationRuntimeConfig): Promise<void>;
};

class ProductionDatabasePreflightError extends Error {
  constructor(code: string) {
    super(`Production database credential preflight failed: ${code}`);
  }
}

const preflightError = (code: string): Error => new ProductionDatabasePreflightError(code);

export const productionMigrationCliErrorMessage = (error: unknown): string =>
  error instanceof ProductionDatabasePreflightError
    ? error.message
    : 'Production database migration failed';

const requiredUrl = (
  environment: NodeJS.ProcessEnv,
  name: string,
  role: ProductionDatabaseRole
): string => {
  const value = environment[name];
  if (value === undefined || value.length === 0) throw preflightError(`${role}-url-missing`);
  if (value.trim() !== value) throw preflightError(`${role}-url-invalid`);
  return value;
};

const decodeUrlComponent = (value: string, role: ProductionDatabaseRole): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    throw preflightError(`${role}-url-invalid`);
  }
};

const validateDatabaseUrl = (
  value: string,
  role: ProductionDatabaseRole
): ValidatedProductionDatabaseUrl => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw preflightError(`${role}-url-invalid`);
  }

  if (
    (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') ||
    !url.hostname ||
    url.hash ||
    !url.username
  ) {
    throw preflightError(`${role}-url-invalid`);
  }
  const roleIdentity = decodeUrlComponent(url.username, role);
  const databaseName = decodeUrlComponent(url.pathname.slice(1), role);
  if (!roleIdentity || !databaseName) throw preflightError(`${role}-url-invalid`);

  const seenQueryParameters = new Set<string>();
  for (const [rawKey, value] of url.searchParams.entries()) {
    const key = rawKey.toLowerCase();
    if (rawKey !== key || seenQueryParameters.has(key)) {
      throw preflightError(`${role}-url-parameter-invalid`);
    }
    seenQueryParameters.add(key);
    if (TARGET_OVERRIDE_QUERY_PARAMETERS.has(key)) {
      throw preflightError(`${role}-url-target-override`);
    }
    if (!ALLOWED_CONNECTION_QUERY_PARAMETERS.has(key)) {
      throw preflightError(`${role}-url-parameter-unsupported`);
    }
    if (key === 'sslmode' && value !== 'verify-full') {
      throw preflightError(`${role}-url-tls-invalid`);
    }
    if (key === 'sslnegotiation' && !ALLOWED_SSL_NEGOTIATION_MODES.has(value)) {
      throw preflightError(`${role}-url-parameter-invalid`);
    }
  }
  if (url.searchParams.get('sslmode') !== 'verify-full') {
    throw preflightError(`${role}-url-tls-required`);
  }

  return {
    href: url.href,
    roleIdentity,
    databaseIdentity: databaseName,
    targetIdentity: `${url.hostname.toLowerCase()}:${url.port || '5432'}/${databaseName}`,
  };
};

const validateProductionDatabaseTopology = (
  environment: NodeJS.ProcessEnv
): {
  topology: ProductionDatabaseTopology;
  validated: ValidatedProductionDatabaseUrl[];
} => {
  if (findUnsafePostgresProcessEnvironmentOverride(environment) !== null) {
    throw preflightError('process-environment-override');
  }
  const topology = {
    migrationOwnerUrl: requiredUrl(environment, OWNER_URL_ENV, 'migration-owner'),
    apiUrl: requiredUrl(environment, API_URL_ENV, 'api'),
    workerUrl: requiredUrl(environment, WORKER_URL_ENV, 'worker'),
  };
  const validated = [
    validateDatabaseUrl(topology.migrationOwnerUrl, 'migration-owner'),
    validateDatabaseUrl(topology.apiUrl, 'api'),
    validateDatabaseUrl(topology.workerUrl, 'worker'),
  ];

  if (new Set(validated.map(({ href }) => href)).size !== validated.length) {
    throw preflightError('database-url-reuse');
  }
  if (new Set(validated.map(({ roleIdentity }) => roleIdentity)).size !== validated.length) {
    throw preflightError('database-role-reuse');
  }
  if (new Set(validated.map(({ targetIdentity }) => targetIdentity)).size !== 1) {
    throw preflightError('database-target-mismatch');
  }

  return { topology, validated };
};

/**
 * Validates the three production PostgreSQL credentials without logging or
 * embedding their identities in any failure message.
 */
export const readProductionDatabaseTopology = (
  environment: NodeJS.ProcessEnv = process.env
): ProductionDatabaseTopology => validateProductionDatabaseTopology(environment).topology;

const closeDatabaseClient = async (client: pg.Client): Promise<void> => {
  let timeout: NodeJS.Timeout | undefined;
  let endPromise: Promise<void>;
  try {
    endPromise = client.end();
  } catch {
    client.connection.stream.destroy();
    return;
  }

  try {
    await Promise.race([
      endPromise.catch(() => undefined),
      new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
          client.connection.stream.destroy();
          resolve();
        }, DATABASE_CLIENT_CLOSE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
};

const createDatabaseClients = (
  connectionStrings: string[],
  config: MigrationRuntimeConfig
): pg.Client[] =>
  connectionStrings.map((connectionString) => {
    const client = new Client({
      connectionString,
      connectionTimeoutMillis: config.postgresConnectionTimeoutMs,
      query_timeout: config.postgresConnectionTimeoutMs,
      statement_timeout: config.postgresConnectionTimeoutMs,
      options: POSTGRES_TRUSTED_SESSION_OPTIONS,
    });
    client.on('error', () => undefined);
    return client;
  });

const connectDatabaseClients = async (
  clients: pg.Client[],
  failureCode: string
): Promise<void> => {
  const connections = await Promise.allSettled(clients.map((client) => client.connect()));
  if (connections.some(({ status }) => status === 'rejected')) {
    throw preflightError(failureCode);
  }
};

export const readProductionDatabaseIdentities = async (
  topology: ProductionDatabaseTopology,
  config: MigrationRuntimeConfig
): Promise<ProductionDatabaseSessionIdentity[]> => {
  let clients: pg.Client[] = [];

  try {
    clients = createDatabaseClients(
      [topology.migrationOwnerUrl, topology.apiUrl, topology.workerUrl],
      config
    );
    await connectDatabaseClients(clients, 'database-session-check-failed');
    const results = await Promise.allSettled(
      clients.map((client) =>
        client.query<{
          currentRole: string;
          sessionRole: string;
          databaseIdentity: string;
          searchPath: string;
          isSuperuser: boolean;
          canCreateRoles: boolean;
          canCreateDatabases: boolean;
          canReplicate: boolean;
          canBypassRowSecurity: boolean;
          canCreateDatabaseObjects: boolean;
          canCreateInPublicSchema: boolean;
          ownsApplicationObjects: boolean;
          isMigrationOwnerMember: boolean;
          canAssumeElevatedRole: boolean;
          isDatabaseOwnerMember: boolean;
          hasUnexpectedRoleMembership: boolean;
        }>(
          `select current_user::text as "currentRole",
                  session_user::text as "sessionRole",
                  current_database()::text as "databaseIdentity",
                  current_setting('search_path')::text as "searchPath",
                  role.rolsuper as "isSuperuser",
                  role.rolcreaterole as "canCreateRoles",
                  role.rolcreatedb as "canCreateDatabases",
                  role.rolreplication as "canReplicate",
                  role.rolbypassrls as "canBypassRowSecurity",
                  has_database_privilege(current_user, current_database(), 'CREATE')
                    as "canCreateDatabaseObjects",
                  has_schema_privilege(current_user, 'public', 'CREATE')
                    as "canCreateInPublicSchema",
                  exists (
                    select 1
                    from pg_namespace schema_object
                    where pg_has_role(current_user, schema_object.nspowner, 'MEMBER')
                      and schema_object.nspname !~ '^pg_'
                      and schema_object.nspname <> 'information_schema'
                    union all
                    select 1
                    from pg_class object
                    join pg_namespace namespace on namespace.oid = object.relnamespace
                    where pg_has_role(current_user, object.relowner, 'MEMBER')
                      and namespace.nspname !~ '^pg_'
                      and namespace.nspname <> 'information_schema'
                    union all
                    select 1
                    from pg_proc routine_object
                    join pg_namespace namespace on namespace.oid = routine_object.pronamespace
                    where pg_has_role(current_user, routine_object.proowner, 'MEMBER')
                      and namespace.nspname !~ '^pg_'
                      and namespace.nspname <> 'information_schema'
                    union all
                    select 1
                    from pg_type type_object
                    join pg_namespace namespace on namespace.oid = type_object.typnamespace
                    where pg_has_role(current_user, type_object.typowner, 'MEMBER')
                      and namespace.nspname !~ '^pg_'
                      and namespace.nspname <> 'information_schema'
                  ) as "ownsApplicationObjects",
                  pg_has_role(current_user, $1, 'MEMBER') as "isMigrationOwnerMember",
                  exists (
                    select 1
                    from pg_roles assumable
                    where assumable.oid <> role.oid
                      and pg_has_role(current_user, assumable.oid, 'MEMBER')
                      and (
                        assumable.rolsuper
                        or assumable.rolcreaterole
                        or assumable.rolcreatedb
                        or assumable.rolreplication
                        or assumable.rolbypassrls
                        or has_database_privilege(
                          assumable.rolname,
                          current_database(),
                          'CREATE'
                        )
                        or has_schema_privilege(assumable.rolname, 'public', 'CREATE')
                      )
                  ) as "canAssumeElevatedRole",
                  pg_has_role(current_user, 'pg_database_owner', 'MEMBER')
                    as "isDatabaseOwnerMember",
                  exists (
                    select 1
                    from pg_roles assumable
                    where assumable.oid <> role.oid
                      and assumable.rolname <> 'pg_database_owner'
                      and pg_has_role(current_user, assumable.oid, 'MEMBER')
                  ) as "hasUnexpectedRoleMembership"
             from pg_roles role
            where role.rolname = current_user`,
          [decodeURIComponent(new URL(topology.migrationOwnerUrl).username)]
        )
      )
    );
    if (results.some(({ status }) => status === 'rejected')) {
      throw preflightError('database-session-check-failed');
    }
    return results.map((result) => {
      if (result.status !== 'fulfilled' || result.value.rows.length !== 1) {
        throw preflightError('database-session-check-failed');
      }
      return result.value.rows[0]!;
    });
  } catch (error) {
    if (error instanceof ProductionDatabasePreflightError) throw error;
    throw preflightError('database-session-check-failed');
  } finally {
    await Promise.allSettled(clients.map((client) => closeDatabaseClient(client)));
  }
};

export const applyProductionRuntimeDatabasePrivileges = async (
  topology: ProductionDatabaseTopology,
  config: MigrationRuntimeConfig
): Promise<void> => {
  let clients: pg.Client[] = [];
  let transactionStarted = false;
  try {
    clients = createDatabaseClients([topology.migrationOwnerUrl], config);
    await connectDatabaseClients(clients, 'database-runtime-privilege-provision-failed');
    const client = clients[0]!;
    const ownerUrl = new URL(topology.migrationOwnerUrl);
    const ownerRole = decodeURIComponent(ownerUrl.username);
    const databaseIdentity = decodeURIComponent(ownerUrl.pathname.slice(1));
    const apiRole = pg.escapeIdentifier(decodeURIComponent(new URL(topology.apiUrl).username));
    const workerRole = pg.escapeIdentifier(
      decodeURIComponent(new URL(topology.workerUrl).username)
    );
    const session = await client.query<{
      currentRole: string;
      sessionRole: string;
      databaseIdentity: string;
      searchPath: string;
    }>(
      `select current_user::text as "currentRole",
              session_user::text as "sessionRole",
              current_database()::text as "databaseIdentity",
              current_setting('search_path')::text as "searchPath"`
    );
    if (
      session.rows.length !== 1 ||
      session.rows[0]!.currentRole !== ownerRole ||
      session.rows[0]!.sessionRole !== ownerRole ||
      session.rows[0]!.databaseIdentity !== databaseIdentity ||
      session.rows[0]!.searchPath !== POSTGRES_TRUSTED_SEARCH_PATH
    ) {
      throw preflightError('database-runtime-privilege-provision-failed');
    }

    await client.query('begin');
    transactionStarted = true;
    await client.query(
      `revoke all privileges on table public.indexer_documents from ${apiRole}, ${workerRole}`
    );
    await client.query(
      `revoke all privileges on table public.polkaswap_indexer_worker_lease_fence from ${apiRole}, ${workerRole}`
    );
    await client.query(`grant select on table public.indexer_documents to ${apiRole}`);
    await client.query(
      `grant select, insert, update, delete on table public.indexer_documents to ${workerRole}`
    );
    await client.query(
      `grant select, insert, update on table public.polkaswap_indexer_worker_lease_fence to ${workerRole}`
    );
    await client.query('commit');
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      await clients[0]?.query('rollback').catch(() => undefined);
    }
    if (error instanceof ProductionDatabasePreflightError) throw error;
    throw preflightError('database-runtime-privilege-provision-failed');
  } finally {
    await Promise.allSettled(clients.map((client) => closeDatabaseClient(client)));
  }
};

export const readProductionRuntimeDatabasePrivileges = async (
  topology: ProductionDatabaseTopology,
  config: MigrationRuntimeConfig
): Promise<ProductionRuntimeDatabasePrivileges[]> => {
  let clients: pg.Client[] = [];
  try {
    clients = createDatabaseClients([topology.apiUrl, topology.workerUrl], config);
    await connectDatabaseClients(clients, 'database-runtime-privilege-check-failed');
    const results = await Promise.allSettled(
      clients.map((client) =>
        client.query<ProductionRuntimeDatabasePrivileges>(
          `with reachable_runtime_roles("roleName") as (
             select current_user::name
             union
             select assumable.rolname
               from pg_roles assumable
              where pg_has_role(current_user, assumable.oid, 'MEMBER')
           )
           select current_user::text as "currentRole",
                  session_user::text as "sessionRole",
                  current_database()::text as "databaseIdentity",
                  current_setting('search_path')::text as "searchPath",
                  exists (
                    select 1
                      from pg_roles other_role
                     where other_role.rolname <> current_user
                       and pg_has_role(current_user, other_role.oid, 'MEMBER')
                  ) as "hasOtherRoleMembership",
                  exists (
                    select 1 from reachable_runtime_roles
                     where has_table_privilege("roleName", 'public.indexer_documents', 'SELECT')
                  )
                    as "canSelectDocuments",
                  exists (
                    select 1 from reachable_runtime_roles
                     where has_table_privilege("roleName", 'public.indexer_documents', 'INSERT')
                  )
                    as "canInsertDocuments",
                  exists (
                    select 1 from reachable_runtime_roles
                     where has_table_privilege("roleName", 'public.indexer_documents', 'UPDATE')
                  )
                    as "canUpdateDocuments",
                  exists (
                    select 1 from reachable_runtime_roles
                     where has_table_privilege("roleName", 'public.indexer_documents', 'DELETE')
                  )
                    as "canDeleteDocuments",
                  exists (
                    select 1 from reachable_runtime_roles
                     where has_table_privilege("roleName", 'public.indexer_documents', 'TRUNCATE')
                  )
                    as "canTruncateDocuments",
                  exists (
                    select 1 from reachable_runtime_roles
                     where has_table_privilege(
                       "roleName",
                       'public.indexer_documents',
                       'REFERENCES'
                     )
                  )
                    as "canReferenceDocuments",
                  exists (
                    select 1 from reachable_runtime_roles
                     where has_table_privilege("roleName", 'public.indexer_documents', 'TRIGGER')
                  )
                    as "canTriggerDocuments",
                  exists (
                    select 1 from reachable_runtime_roles
                     where has_any_column_privilege(
                       "roleName",
                       'public.indexer_documents',
                       'INSERT'
                     )
                  ) as "canInsertAnyDocumentColumn",
                  exists (
                    select 1 from reachable_runtime_roles
                     where has_any_column_privilege(
                       "roleName",
                       'public.indexer_documents',
                       'UPDATE'
                     )
                  ) as "canUpdateAnyDocumentColumn",
                  exists (
                    select 1 from reachable_runtime_roles
                     where has_any_column_privilege(
                       "roleName",
                       'public.indexer_documents',
                       'REFERENCES'
                     )
                  ) as "canReferenceAnyDocumentColumn",
                  exists (
                    select 1
                      from reachable_runtime_roles
                      cross join unnest(
                        array[
                          'SELECT',
                          'INSERT',
                          'UPDATE',
                          'DELETE',
                          'TRUNCATE',
                          'REFERENCES',
                          'TRIGGER'
                        ]
                      ) privilege("name")
                     where has_table_privilege(
                       "roleName",
                       'public.indexer_documents',
                       privilege."name" || ' WITH GRANT OPTION'
                     )
                  ) as "hasDocumentTableGrantOptions",
                  exists (
                    select 1
                      from reachable_runtime_roles
                      cross join unnest(
                        array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']
                      ) privilege("name")
                     where has_any_column_privilege(
                       "roleName",
                       'public.indexer_documents',
                       privilege."name" || ' WITH GRANT OPTION'
                     )
                  ) as "hasDocumentColumnGrantOptions",
                  exists (
                    select 1 from reachable_runtime_roles
                     where has_table_privilege(
                       "roleName",
                       'public.polkaswap_indexer_worker_lease_fence',
                       'SELECT'
                     )
                  ) as "canSelectWorkerFence",
                  exists (
                    select 1 from reachable_runtime_roles
                     where has_table_privilege(
                       "roleName",
                       'public.polkaswap_indexer_worker_lease_fence',
                       'INSERT'
                     )
                  ) as "canInsertWorkerFence",
                  exists (
                    select 1 from reachable_runtime_roles
                     where has_table_privilege(
                       "roleName",
                       'public.polkaswap_indexer_worker_lease_fence',
                       'UPDATE'
                     )
                  ) as "canUpdateWorkerFence",
                  exists (
                    select 1 from reachable_runtime_roles
                     where has_table_privilege(
                       "roleName",
                       'public.polkaswap_indexer_worker_lease_fence',
                       'DELETE'
                     )
                  ) as "canDeleteWorkerFence",
                  exists (
                    select 1 from reachable_runtime_roles
                     where has_table_privilege(
                       "roleName",
                       'public.polkaswap_indexer_worker_lease_fence',
                       'TRUNCATE'
                     )
                  ) as "canTruncateWorkerFence",
                  exists (
                    select 1 from reachable_runtime_roles
                     where has_table_privilege(
                       "roleName",
                       'public.polkaswap_indexer_worker_lease_fence',
                       'REFERENCES'
                     )
                  ) as "canReferenceWorkerFence",
                  exists (
                    select 1 from reachable_runtime_roles
                     where has_table_privilege(
                       "roleName",
                       'public.polkaswap_indexer_worker_lease_fence',
                       'TRIGGER'
                     )
                  ) as "canTriggerWorkerFence",
                  exists (
                    select 1 from reachable_runtime_roles
                     where has_any_column_privilege(
                       "roleName",
                       'public.polkaswap_indexer_worker_lease_fence',
                       'SELECT'
                     )
                  ) as "canSelectAnyWorkerFenceColumn",
                  exists (
                    select 1 from reachable_runtime_roles
                     where has_any_column_privilege(
                       "roleName",
                       'public.polkaswap_indexer_worker_lease_fence',
                       'INSERT'
                     )
                  ) as "canInsertAnyWorkerFenceColumn",
                  exists (
                    select 1 from reachable_runtime_roles
                     where has_any_column_privilege(
                       "roleName",
                       'public.polkaswap_indexer_worker_lease_fence',
                       'UPDATE'
                     )
                  ) as "canUpdateAnyWorkerFenceColumn",
                  exists (
                    select 1 from reachable_runtime_roles
                     where has_any_column_privilege(
                       "roleName",
                       'public.polkaswap_indexer_worker_lease_fence',
                       'REFERENCES'
                     )
                  ) as "canReferenceAnyWorkerFenceColumn",
                  exists (
                    select 1
                      from reachable_runtime_roles
                      cross join unnest(
                        array[
                          'SELECT',
                          'INSERT',
                          'UPDATE',
                          'DELETE',
                          'TRUNCATE',
                          'REFERENCES',
                          'TRIGGER'
                        ]
                      ) privilege("name")
                     where has_table_privilege(
                       "roleName",
                       'public.polkaswap_indexer_worker_lease_fence',
                       privilege."name" || ' WITH GRANT OPTION'
                     )
                  ) as "hasWorkerFenceTableGrantOptions",
                  exists (
                    select 1
                      from reachable_runtime_roles
                      cross join unnest(
                        array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']
                      ) privilege("name")
                     where has_any_column_privilege(
                       "roleName",
                       'public.polkaswap_indexer_worker_lease_fence',
                       privilege."name" || ' WITH GRANT OPTION'
                     )
                  ) as "hasWorkerFenceColumnGrantOptions"`
        )
      )
    );
    if (results.some(({ status }) => status === 'rejected')) {
      throw preflightError('database-runtime-privilege-check-failed');
    }
    return results.map((result) => {
      if (result.status !== 'fulfilled' || result.value.rows.length !== 1) {
        throw preflightError('database-runtime-privilege-check-failed');
      }
      return result.value.rows[0]!;
    });
  } catch (error) {
    if (error instanceof ProductionDatabasePreflightError) throw error;
    throw preflightError('database-runtime-privilege-check-failed');
  } finally {
    await Promise.allSettled(clients.map((client) => closeDatabaseClient(client)));
  }
};

const defaultDependencies = (): ProductionMigrationDependencies => ({
  readMigrationConfig: () => readConfig(),
  readDatabaseIdentities: readProductionDatabaseIdentities,
  applyRuntimeDatabasePrivileges: applyProductionRuntimeDatabasePrivileges,
  readRuntimeDatabasePrivileges: readProductionRuntimeDatabasePrivileges,
  migrate,
});

const hasElevatedRoleAttributes = (identity: ProductionDatabaseSessionIdentity): boolean =>
  identity.isSuperuser ||
  identity.canCreateRoles ||
  identity.canCreateDatabases ||
  identity.canReplicate ||
  identity.canBypassRowSecurity;

const validateDatabaseSessionIdentities = (
  identities: ProductionDatabaseSessionIdentity[],
  validated: ValidatedProductionDatabaseUrl[]
): void => {
  if (identities.length !== validated.length) {
    throw preflightError('database-session-check-failed');
  }
  if (new Set(identities.map(({ sessionRole }) => sessionRole)).size !== identities.length) {
    throw preflightError('database-session-role-reuse');
  }
  if (new Set(identities.map(({ databaseIdentity }) => databaseIdentity)).size !== 1) {
    throw preflightError('database-session-target-mismatch');
  }
  for (const [index, identity] of identities.entries()) {
    if (
      identity.currentRole !== validated[index]!.roleIdentity ||
      identity.sessionRole !== validated[index]!.roleIdentity
    ) {
      throw preflightError('database-session-role-mismatch');
    }
    if (identity.databaseIdentity !== validated[index]!.databaseIdentity) {
      throw preflightError('database-session-target-mismatch');
    }
    if (identity.searchPath !== POSTGRES_TRUSTED_SEARCH_PATH) {
      throw preflightError('database-session-search-path-invalid');
    }
  }

  const owner = identities[0]!;
  if (
    hasElevatedRoleAttributes(owner) ||
    !owner.canCreateInPublicSchema ||
    owner.hasUnexpectedRoleMembership
  ) {
    throw preflightError('database-migration-owner-privileges-invalid');
  }
  for (const runtime of identities.slice(1)) {
    if (
      hasElevatedRoleAttributes(runtime) ||
      runtime.canCreateDatabaseObjects ||
      runtime.canCreateInPublicSchema ||
      runtime.ownsApplicationObjects ||
      runtime.isMigrationOwnerMember ||
      runtime.canAssumeElevatedRole ||
      runtime.isDatabaseOwnerMember ||
      runtime.hasUnexpectedRoleMembership
    ) {
      throw preflightError('database-runtime-role-privileges-invalid');
    }
  }
};

const validateRuntimeDatabasePrivileges = (
  privileges: ProductionRuntimeDatabasePrivileges[],
  validated: ValidatedProductionDatabaseUrl[]
): void => {
  if (privileges.length !== 2) {
    throw preflightError('database-runtime-privilege-check-failed');
  }
  for (const [index, identity] of privileges.entries()) {
    const expected = validated[index + 1]!;
    if (
      identity.currentRole !== expected.roleIdentity ||
      identity.sessionRole !== expected.roleIdentity ||
      identity.databaseIdentity !== expected.databaseIdentity
    ) {
      throw preflightError('database-runtime-session-mismatch');
    }
    if (
      identity.searchPath !== POSTGRES_TRUSTED_SEARCH_PATH ||
      identity.hasOtherRoleMembership
    ) {
      throw preflightError('database-runtime-session-invalid');
    }
  }

  const api = privileges[0]!;
  if (
    !api.canSelectDocuments ||
    api.canInsertDocuments ||
    api.canUpdateDocuments ||
    api.canDeleteDocuments ||
    api.canTruncateDocuments ||
    api.canReferenceDocuments ||
    api.canTriggerDocuments ||
    api.canInsertAnyDocumentColumn ||
    api.canUpdateAnyDocumentColumn ||
    api.canReferenceAnyDocumentColumn ||
    api.hasDocumentTableGrantOptions ||
    api.hasDocumentColumnGrantOptions ||
    api.canSelectWorkerFence ||
    api.canInsertWorkerFence ||
    api.canUpdateWorkerFence ||
    api.canDeleteWorkerFence ||
    api.canTruncateWorkerFence ||
    api.canReferenceWorkerFence ||
    api.canTriggerWorkerFence ||
    api.canSelectAnyWorkerFenceColumn ||
    api.canInsertAnyWorkerFenceColumn ||
    api.canUpdateAnyWorkerFenceColumn ||
    api.canReferenceAnyWorkerFenceColumn ||
    api.hasWorkerFenceTableGrantOptions ||
    api.hasWorkerFenceColumnGrantOptions
  ) {
    throw preflightError('database-api-privileges-invalid');
  }

  const worker = privileges[1]!;
  if (
    !worker.canSelectDocuments ||
    !worker.canInsertDocuments ||
    !worker.canUpdateDocuments ||
    !worker.canDeleteDocuments ||
    worker.canTruncateDocuments ||
    worker.canReferenceDocuments ||
    worker.canTriggerDocuments ||
    worker.canReferenceAnyDocumentColumn ||
    worker.hasDocumentTableGrantOptions ||
    worker.hasDocumentColumnGrantOptions ||
    !worker.canSelectWorkerFence ||
    !worker.canInsertWorkerFence ||
    !worker.canUpdateWorkerFence ||
    worker.canDeleteWorkerFence ||
    worker.canTruncateWorkerFence ||
    worker.canReferenceWorkerFence ||
    worker.canTriggerWorkerFence ||
    worker.canReferenceAnyWorkerFenceColumn ||
    worker.hasWorkerFenceTableGrantOptions ||
    worker.hasWorkerFenceColumnGrantOptions
  ) {
    throw preflightError('database-worker-privileges-invalid');
  }
};

/**
 * Runs schema DDL only after the owner, API, and worker credentials prove a
 * distinct-role, same-database production topology.
 */
export const runProductionMigration = async (
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: ProductionMigrationDependencies = defaultDependencies()
): Promise<void> => {
  const { topology, validated } = validateProductionDatabaseTopology(environment);
  const config = dependencies.readMigrationConfig();
  if (config.databaseUrl !== topology.migrationOwnerUrl) {
    throw preflightError('migration-owner-config-mismatch');
  }
  const identities = await dependencies.readDatabaseIdentities(topology, config);
  validateDatabaseSessionIdentities(identities, validated);

  console.info(
    'Verified distinct least-privilege production PostgreSQL sessions before schema migration'
  );
  await dependencies.migrate(config);
  await dependencies.applyRuntimeDatabasePrivileges(topology, config);
  const postMigrationIdentities = await dependencies.readDatabaseIdentities(topology, config);
  validateDatabaseSessionIdentities(postMigrationIdentities, validated);
  const runtimePrivileges = await dependencies.readRuntimeDatabasePrivileges(topology, config);
  validateRuntimeDatabasePrivileges(runtimePrivileges, validated);
  console.info(
    'Verified production PostgreSQL sessions and exact table/column privileges after schema migration'
  );
};

if (import.meta.url === `file://${process.argv[1]}`) {
  runProductionMigration().catch((error: unknown) => {
    console.error(productionMigrationCliErrorMessage(error));
    process.exitCode = 1;
  });
}
