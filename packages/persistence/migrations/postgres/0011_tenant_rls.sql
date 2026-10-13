-- PostgreSQL runtime engine (ADR-015): SQLite-compatible helpers, 64-bit integers and tenant isolation.

-- 1. SQL functions the application statements rely on. SQLite provides them natively; PostgreSQL
--    gets equivalents so application SQL does not need a second dialect for them.
CREATE FUNCTION json_extract(doc text, path text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  AS $$ SELECT jsonb_path_query_first(doc::jsonb, path::jsonpath) #>> '{}' $$;

CREATE FUNCTION json_type(doc text, path text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  AS $$
    SELECT CASE jsonb_typeof(v)
      WHEN 'number' THEN CASE WHEN v::text ~ '^-?[0-9]+$' THEN 'integer' ELSE 'real' END
      WHEN 'string' THEN 'text'
      WHEN 'boolean' THEN v::text
      ELSE jsonb_typeof(v)
    END
    FROM (SELECT jsonb_path_query_first(doc::jsonb, path::jsonpath) AS v) AS found
  $$;

CREATE FUNCTION instr(haystack text, needle text) RETURNS integer
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  AS 'SELECT strpos(haystack, needle)';

-- 2. SQLite INTEGER columns hold 64-bit values (byte counts, sequence numbers, epoch values).
--    Earlier PostgreSQL migrations declared 32-bit INTEGER; widen every such column.
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = current_schema() AND data_type = 'integer' AND table_name <> 'schema_migrations'
    ORDER BY table_name, ordinal_position
  LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE bigint', c.table_name, c.column_name);
  END LOOP;
END $$;

-- 3. Tenant isolation: every table with a workspace_id column enforces row-level security for the
--    owner too (FORCE). The session scope is set by the persistence layer through
--    set_config('testmaster.workspace', <id> | '*', false). An unset scope matches no row.
--    The DO block below covers every table that exists when this migration runs, including the
--    identity tables of 0010 (password_credentials, sessions). Migrations after 0011 that create
--    such a table MUST call tm_enable_tenant_rls('<table>').
CREATE FUNCTION tm_enable_tenant_rls(target regclass) RETURNS void
  LANGUAGE plpgsql
  AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', target);
  EXECUTE format(
    $policy$CREATE POLICY tenant_isolation ON %s
      USING (current_setting('testmaster.workspace', true) = '*' OR workspace_id = current_setting('testmaster.workspace', true))
      WITH CHECK (current_setting('testmaster.workspace', true) = '*' OR workspace_id = current_setting('testmaster.workspace', true))$policy$,
    target);
END $$;

DO $$
DECLARE t regclass;
BEGIN
  FOR t IN
    SELECT c.oid::regclass FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'workspace_id' AND NOT a.attisdropped
    WHERE n.nspname = current_schema() AND c.relkind = 'r'
    ORDER BY c.relname
  LOOP
    PERFORM tm_enable_tenant_rls(t);
  END LOOP;
END $$;

-- DDL parity with SQLite: 0006 declares each of these single-column references next to the wider
-- composite one, and only the single-column form still binds when the extra column is NULL.
ALTER TABLE analyses ADD FOREIGN KEY (workspace_id, parent_id) REFERENCES analyses(workspace_id, id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE analyses ADD FOREIGN KEY (workspace_id, snapshot_id) REFERENCES snapshots(workspace_id, id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE healing_proposals ADD FOREIGN KEY (workspace_id, analysis_id) REFERENCES analyses(workspace_id, id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE healing_proposals ADD FOREIGN KEY (workspace_id, base_revision_id) REFERENCES test_revisions(workspace_id, id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE healing_proposals ADD FOREIGN KEY (workspace_id, candidate_revision_id) REFERENCES test_revisions(workspace_id, id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE healing_proposals ADD FOREIGN KEY (workspace_id, failed_run_id) REFERENCES runs(workspace_id, id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE healing_proposals ADD FOREIGN KEY (workspace_id, verification_run_id) REFERENCES runs(workspace_id, id) DEFERRABLE INITIALLY DEFERRED;
