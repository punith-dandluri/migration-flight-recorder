-- Risk: MEDIUM. A direct NOT NULL constraint would fail because seeded customers include NULL emails.
BEGIN;
UPDATE billing.customers c
SET billing_email = 'billing+' || o.slug || '@migration-demo.invalid', updated_at = now()
FROM app.organizations o
WHERE c.organization_id = o.id AND c.billing_email IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM billing.customers WHERE billing_email IS NULL) THEN
    RAISE EXCEPTION 'Safety check failed: billing.customers.billing_email still has NULL values';
  END IF;
END $$;

ALTER TABLE billing.customers ALTER COLUMN billing_email SET NOT NULL;
INSERT INTO control.schema_migrations (version, checksum) VALUES ('scenario_02_medium_backfill_billing_email', 'scenario-02-v1');
COMMIT;
