-- OPERATOR REVIEW REQUIRED. DO NOT run through the agent or rehearsal tool.
-- Changes ownership/privileges on the existing local database. Supply an independently
-- generated password through a trusted client; never paste it into an agent prompt.
-- Abort if these deployment objects already exist: this is initial provisioning only.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
DO $$ BEGIN IF current_database() <> 'migration_flight_recorder' THEN RAISE EXCEPTION 'Wrong database: refusing deployment setup'; END IF; END $$;
CREATE ROLE mfr_executor LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT CONNECT ON DATABASE migration_flight_recorder TO mfr_executor;
CREATE SCHEMA mfr_control;
REVOKE ALL ON SCHEMA mfr_control FROM PUBLIC;
CREATE TABLE mfr_control.executions (
  plan_id uuid PRIMARY KEY,
  sql_sha256 text NOT NULL,
  rehearsal_run_id uuid NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT now(),
  evidence jsonb NOT NULL
);
REVOKE ALL ON mfr_control.executions FROM PUBLIC;
GRANT USAGE ON SCHEMA mfr_control TO mfr_executor;
GRANT SELECT,INSERT ON mfr_control.executions TO mfr_executor;
DO $$
DECLARE obj record;
BEGIN
  FOR obj IN SELECT nspname FROM pg_namespace WHERE nspname IN ('app','auth','billing','operations','audit','analytics','control') LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO mfr_executor', obj.nspname);
    EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO mfr_executor', obj.nspname);
    EXECUTE format('GRANT SELECT ON ALL SEQUENCES IN SCHEMA %I TO mfr_executor', obj.nspname);
    EXECUTE format('GRANT CREATE ON SCHEMA %I TO mfr_executor', obj.nspname);
  END LOOP;
  FOR obj IN SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('app','auth','billing','operations','audit','analytics','control') AND c.relkind='r' LOOP
    EXECUTE format('ALTER TABLE %I.%I OWNER TO mfr_executor', obj.nspname,obj.relname);
  END LOOP;
END $$;
ALTER ROLE mfr_executor SET statement_timeout = '30s';
ALTER ROLE mfr_executor SET lock_timeout = '2s';
ALTER ROLE mfr_executor SET idle_in_transaction_session_timeout = '30s';
COMMIT;
-- Use psql's interactive \password mfr_executor (or an equivalent trusted secret manager)
-- after separately approving this setup; then configure the ignored target.env file.
