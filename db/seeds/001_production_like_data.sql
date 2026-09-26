-- Synthetic fixture with stable row counts; generated UUIDs and timestamps vary between installations.

INSERT INTO app.organizations (id, slug, name, plan, settings, legacy_customer_reference) VALUES
  ('00000000-0000-4000-8000-000000000001', 'acme', 'Acme Robotics', 'enterprise', '{"region":"us-east-1","sso_required":true}', 'LEGACY-ACME-01'),
  ('00000000-0000-4000-8000-000000000002', 'globex', 'Globex Analytics', 'pro', '{"region":"eu-west-1"}', 'LEGACY-GLOBEX-02'),
  ('00000000-0000-4000-8000-000000000003', 'initech', 'Initech', 'free', '{"region":"ap-south-1"}', NULL),
  ('00000000-0000-4000-8000-000000000004', 'umbrella', 'Umbrella Health', 'enterprise', '{"region":"us-east-1","hipaa":true}', 'LEGACY-UMB-04'),
  ('00000000-0000-4000-8000-000000000005', 'stark', 'Stark Industries', 'pro', '{"region":"us-west-2"}', 'LEGACY-STARK-05');

-- Additional tenants make billing backfills and uniqueness checks meaningful without making laptop setup slow.
INSERT INTO app.organizations (slug, name, plan, settings, legacy_customer_reference)
SELECT
  'demo-' || lpad(n::text, 3, '0'),
  'Demo Tenant ' || n,
  CASE WHEN n % 19 = 0 THEN 'enterprise' WHEN n % 3 = 0 THEN 'free' ELSE 'pro' END,
  jsonb_build_object('region', CASE n % 3 WHEN 0 THEN 'us-east-1' WHEN 1 THEN 'eu-west-1' ELSE 'ap-south-1' END),
  CASE WHEN n % 4 = 0 THEN 'LEGACY-DEMO-' || n ELSE NULL END
FROM generate_series(6, 200) AS n;

INSERT INTO auth.users (id, email, display_name, phone, profile, is_platform_admin, last_login_at)
VALUES ('10000000-0000-4000-8000-000000000001', 'admin@flightrecorder.local', 'Platform Admin', '+1-555-0100', '{"timezone":"UTC"}', true, now() - interval '1 hour');

INSERT INTO auth.users (email, display_name, phone, profile, last_login_at)
SELECT
  format('user%s@example.test', n),
  format('Demo User %s', n),
  CASE WHEN n % 11 = 0 THEN NULL ELSE format('+1-555-%s', lpad(n::text, 4, '0')) END,
  jsonb_build_object('timezone', CASE n % 3 WHEN 0 THEN 'UTC' WHEN 1 THEN 'America/New_York' ELSE 'Asia/Kolkata' END, 'marketing_opt_in', n % 4 = 0),
  now() - (n || ' hours')::interval
FROM generate_series(1, 500) AS n;

INSERT INTO app.organization_members (organization_id, user_id, role, invited_by)
SELECT
  (ARRAY[
    '00000000-0000-4000-8000-000000000001'::uuid,
    '00000000-0000-4000-8000-000000000002'::uuid,
    '00000000-0000-4000-8000-000000000003'::uuid,
    '00000000-0000-4000-8000-000000000004'::uuid,
    '00000000-0000-4000-8000-000000000005'::uuid
  ])[((n - 1) % 5 + 1)],
  u.id,
  CASE WHEN n <= 5 THEN 'owner'::app.member_role WHEN n % 10 = 0 THEN 'admin'::app.member_role WHEN n % 7 = 0 THEN 'viewer'::app.member_role ELSE 'member'::app.member_role END,
  '10000000-0000-4000-8000-000000000001'
FROM (SELECT id, row_number() OVER (ORDER BY created_at) AS n FROM auth.users WHERE is_platform_admin = false) u;

INSERT INTO app.projects (organization_id, key, name, status, metadata, created_by, created_at)
SELECT
  m.organization_id,
  format('PRJ-%s', lpad(row_number() OVER (PARTITION BY m.organization_id ORDER BY m.user_id)::text, 3, '0')),
  format('Customer Project %s', row_number() OVER (ORDER BY m.user_id)),
  CASE WHEN row_number() OVER (ORDER BY m.user_id) % 17 = 0 THEN 'paused'::app.project_status WHEN row_number() OVER (ORDER BY m.user_id) % 23 = 0 THEN 'archived'::app.project_status ELSE 'active'::app.project_status END,
  jsonb_build_object('tier', CASE WHEN row_number() OVER (ORDER BY m.user_id) % 4 = 0 THEN 'critical' ELSE 'standard' END, 'source', 'seed'),
  m.user_id,
  now() - (row_number() OVER (ORDER BY m.user_id) || ' days')::interval
FROM app.organization_members m;

INSERT INTO app.project_members (project_id, user_id, role)
SELECT p.id, p.created_by, 'owner'::app.member_role FROM app.projects p;

INSERT INTO billing.customers (organization_id, provider_customer_id, billing_email, tax_id, address)
SELECT id, 'cus_' || replace(slug, '-', '_'), CASE WHEN slug = 'initech' OR (slug LIKE 'demo-%' AND substring(slug FROM 6)::integer % 17 = 0) THEN NULL ELSE 'billing@' || slug || '.example.test' END,
  CASE WHEN plan = 'enterprise' THEN 'TAX-' || upper(slug) ELSE NULL END,
  jsonb_build_object('country', CASE WHEN slug = 'globex' THEN 'IE' ELSE 'US' END, 'city', 'Demo City')
FROM app.organizations;

INSERT INTO billing.subscriptions (customer_id, provider_subscription_id, status, seats, monthly_cents, current_period_start, current_period_end)
SELECT id, 'sub_' || replace(provider_customer_id, 'cus_', ''), CASE WHEN provider_customer_id LIKE '%initech%' THEN 'trialing'::billing.subscription_status ELSE 'active'::billing.subscription_status END,
  CASE WHEN provider_customer_id LIKE '%acme%' THEN 250 ELSE 25 END, CASE WHEN provider_customer_id LIKE '%enterprise%' THEN 250000 ELSE 25000 END,
  now() - interval '10 days', now() + interval '20 days'
FROM billing.customers;

INSERT INTO billing.invoices (customer_id, subscription_id, status, amount_due_cents, amount_paid_cents, due_at, paid_at)
SELECT s.customer_id, s.id, CASE WHEN row_number() OVER () % 5 = 0 THEN 'open'::billing.invoice_status ELSE 'paid'::billing.invoice_status END,
  s.monthly_cents, CASE WHEN row_number() OVER () % 5 = 0 THEN 0 ELSE s.monthly_cents END, now() + interval '15 days', CASE WHEN row_number() OVER () % 5 = 0 THEN NULL ELSE now() - interval '2 days' END
FROM billing.subscriptions s;

INSERT INTO operations.deployment_runs (project_id, triggered_by, status, environment, commit_sha, duration_ms, started_at, finished_at, metadata, created_at)
SELECT p.id, p.created_by,
  CASE WHEN n % 12 = 0 THEN 'failed'::operations.deployment_status WHEN n % 29 = 0 THEN 'rolled_back'::operations.deployment_status ELSE 'succeeded'::operations.deployment_status END,
  CASE n % 3 WHEN 0 THEN 'production' ELSE 'staging' END, lpad(to_hex(n), 40, '0'), 500 + (n % 30000), now() - (n || ' minutes')::interval, now() - ((n - 1) || ' minutes')::interval,
  jsonb_build_object('runner', 'seeded-ci', 'retry', n % 13 = 0), now() - (n || ' minutes')::interval
FROM app.projects p CROSS JOIN generate_series(1, 4) n;

INSERT INTO audit.events (organization_id, actor_id, event_type, payload, occurred_at)
SELECT
  p.organization_id, p.created_by,
  CASE n % 5 WHEN 0 THEN 'deployment.completed' WHEN 1 THEN 'project.updated' WHEN 2 THEN 'member.invited' WHEN 3 THEN 'billing.invoice.created' ELSE 'api.token.used' END,
  jsonb_build_object('project_id', p.id, 'sequence', n, 'ip', format('10.0.%s.%s', n % 255, (n / 255) % 255)),
  now() - (n || ' seconds')::interval
FROM app.projects p CROSS JOIN generate_series(1, 50) n;

INSERT INTO analytics.usage_daily (organization_id, usage_date, api_calls, build_minutes, storage_bytes)
SELECT o.id, current_date - n, (n + 1) * 173, n % 100, ((n + 1)::bigint * 1048576)
FROM app.organizations o CROSS JOIN generate_series(0, 89) n;

INSERT INTO control.schema_migrations (version, checksum) VALUES ('001_production_like_data', 'seed-v1');
