/**
 * A trusted namespace order for every application-controlled PostgreSQL
 * session. Listing pg_temp last prevents PostgreSQL from implicitly searching
 * a session's temporary schema before the audited public relations.
 */
export const POSTGRES_TRUSTED_SEARCH_PATH = 'pg_catalog,public,pg_temp';
export const POSTGRES_TRUSTED_SESSION_OPTIONS =
  `-c search_path=${POSTGRES_TRUSTED_SEARCH_PATH}`;

const FORBIDDEN_NODE_DATABASE_ENVIRONMENT = new Set([
  'NODE_OPTIONS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
]);

/**
 * Returns only the override name, never its potentially sensitive value.
 * Connection policy is owned by the reviewed URL and explicit client config.
 */
export const findUnsafePostgresProcessEnvironmentOverride = (
  environment: NodeJS.ProcessEnv
): string | null => {
  for (const name of Object.keys(environment).sort()) {
    if (FORBIDDEN_NODE_DATABASE_ENVIRONMENT.has(name) || /^PG[A-Z0-9_]+$/.test(name)) {
      return name;
    }
  }
  return null;
};
