-- Risk: LOW. Nullable add; no data rewrite or backfill is required.
BEGIN;
ALTER TABLE app.projects ADD COLUMN description TEXT;
COMMENT ON COLUMN app.projects.description IS 'Human-readable project description; introduced by scenario 01.';
INSERT INTO control.schema_migrations (version, checksum) VALUES ('scenario_01_easy_add_project_description', 'scenario-01-v1');
COMMIT;
