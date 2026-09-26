-- Risk: HIGH on a large production audit table. This is intentionally split: CREATE INDEX CONCURRENTLY cannot run inside a transaction.
-- Stage 1: nullable schema expansion.
ALTER TABLE audit.events ADD COLUMN actor_ip INET;

-- Stage 2: full-table backfill for the small fixture. This is not a batched production migration.
UPDATE audit.events
SET actor_ip = NULLIF(payload ->> 'ip', '')::inet
WHERE actor_ip IS NULL AND payload ? 'ip';

-- Stage 3: validate before enforcing a contract. This migration deliberately leaves actor_ip nullable because older events may lack an IP.
CREATE INDEX CONCURRENTLY audit_events_actor_ip_idx ON audit.events (actor_ip) WHERE actor_ip IS NOT NULL;
INSERT INTO control.schema_migrations (version, checksum) VALUES ('scenario_03_high_add_audit_actor_ip_index', 'scenario-03-v1');
