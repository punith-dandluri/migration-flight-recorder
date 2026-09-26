-- Risk: HIGH. Type changes can take heavyweight locks and rewrite a table. BIGINT is needed before duration values exceed INTEGER.
-- The USING clause is explicit so the agent can reason about conversion semantics.
BEGIN;
ALTER TABLE operations.deployment_runs
  ALTER COLUMN duration_ms TYPE BIGINT USING duration_ms::BIGINT;
INSERT INTO control.schema_migrations (version, checksum) VALUES ('scenario_04_high_widen_deployment_duration', 'scenario-04-v1');
COMMIT;
