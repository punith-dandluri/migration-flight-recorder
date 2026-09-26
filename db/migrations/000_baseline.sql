-- Production-like baseline for Migration Flight Recorder.
-- Run once on an empty database.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA auth;
CREATE SCHEMA app;
CREATE SCHEMA billing;
CREATE SCHEMA operations;
CREATE SCHEMA audit;
CREATE SCHEMA analytics;
CREATE SCHEMA control;

CREATE TYPE app.member_role AS ENUM ('owner', 'admin', 'member', 'viewer');
CREATE TYPE app.project_status AS ENUM ('planned', 'active', 'paused', 'archived');
CREATE TYPE billing.subscription_status AS ENUM ('trialing', 'active', 'past_due', 'canceled');
CREATE TYPE billing.invoice_status AS ENUM ('draft', 'open', 'paid', 'void', 'uncollectible');
CREATE TYPE operations.deployment_status AS ENUM ('queued', 'running', 'succeeded', 'failed', 'rolled_back');

CREATE TABLE control.schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  checksum TEXT NOT NULL,
  applied_by TEXT NOT NULL DEFAULT current_user
);

CREATE TABLE auth.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  phone VARCHAR(30),
  avatar_url TEXT,
  profile JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_platform_admin BOOLEAN NOT NULL DEFAULT false,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT users_email_format CHECK (email ~* '^[^@]+@[^@]+[.][^@]+$')
);
CREATE UNIQUE INDEX users_email_active_key ON auth.users (lower(email)) WHERE deleted_at IS NULL;

CREATE TABLE app.organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  plan TEXT NOT NULL CHECK (plan IN ('free', 'pro', 'enterprise')),
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  legacy_customer_reference VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ
);

CREATE TABLE app.organization_members (
  organization_id UUID NOT NULL REFERENCES app.organizations(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  role app.member_role NOT NULL DEFAULT 'member',
  invited_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);
CREATE INDEX organization_members_user_idx ON app.organization_members (user_id);

CREATE TABLE app.projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES app.organizations(id) ON DELETE RESTRICT,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  status app.project_status NOT NULL DEFAULT 'planned',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ,
  UNIQUE (organization_id, key)
);
CREATE INDEX projects_organization_status_idx ON app.projects (organization_id, status) WHERE archived_at IS NULL;
CREATE INDEX projects_metadata_gin_idx ON app.projects USING GIN (metadata);

CREATE TABLE app.project_members (
  project_id UUID NOT NULL REFERENCES app.projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  role app.member_role NOT NULL DEFAULT 'member',
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE billing.customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL UNIQUE REFERENCES app.organizations(id) ON DELETE RESTRICT,
  provider_customer_id TEXT NOT NULL UNIQUE,
  billing_email TEXT,
  tax_id TEXT,
  address JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE billing.subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES billing.customers(id) ON DELETE RESTRICT,
  provider_subscription_id TEXT NOT NULL UNIQUE,
  status billing.subscription_status NOT NULL,
  seats INTEGER NOT NULL CHECK (seats > 0),
  monthly_cents INTEGER NOT NULL CHECK (monthly_cents >= 0),
  current_period_start TIMESTAMPTZ NOT NULL,
  current_period_end TIMESTAMPTZ NOT NULL,
  canceled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT subscription_period_order CHECK (current_period_end > current_period_start)
);
CREATE INDEX subscriptions_customer_status_idx ON billing.subscriptions (customer_id, status);

CREATE TABLE billing.invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES billing.customers(id) ON DELETE RESTRICT,
  subscription_id UUID REFERENCES billing.subscriptions(id) ON DELETE SET NULL,
  status billing.invoice_status NOT NULL,
  amount_due_cents INTEGER NOT NULL CHECK (amount_due_cents >= 0),
  amount_paid_cents INTEGER NOT NULL DEFAULT 0 CHECK (amount_paid_cents >= 0),
  due_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT invoice_paid_not_over_due CHECK (amount_paid_cents <= amount_due_cents)
);
CREATE INDEX invoices_customer_created_idx ON billing.invoices (customer_id, created_at DESC);

CREATE TABLE operations.deployment_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES app.projects(id) ON DELETE RESTRICT,
  triggered_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  status operations.deployment_status NOT NULL DEFAULT 'queued',
  environment TEXT NOT NULL CHECK (environment IN ('development', 'staging', 'production')),
  commit_sha CHAR(40) NOT NULL,
  duration_ms INTEGER,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT deployment_time_order CHECK (finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at)
);
CREATE INDEX deployment_runs_project_created_idx ON operations.deployment_runs (project_id, created_at DESC);
CREATE INDEX deployment_runs_failed_idx ON operations.deployment_runs (created_at DESC) WHERE status = 'failed';

-- Intentionally large and append-heavy: it makes index and column backfill risks observable.
CREATE TABLE audit.events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES app.organizations(id) ON DELETE RESTRICT,
  actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  request_id UUID NOT NULL DEFAULT gen_random_uuid(),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_org_time_idx ON audit.events (organization_id, occurred_at DESC);
CREATE INDEX audit_events_payload_gin_idx ON audit.events USING GIN (payload);

CREATE TABLE analytics.usage_daily (
  organization_id UUID NOT NULL REFERENCES app.organizations(id) ON DELETE RESTRICT,
  usage_date DATE NOT NULL,
  api_calls BIGINT NOT NULL DEFAULT 0 CHECK (api_calls >= 0),
  build_minutes INTEGER NOT NULL DEFAULT 0 CHECK (build_minutes >= 0),
  storage_bytes BIGINT NOT NULL DEFAULT 0 CHECK (storage_bytes >= 0),
  PRIMARY KEY (organization_id, usage_date)
);

INSERT INTO control.schema_migrations (version, checksum) VALUES ('000_baseline', 'baseline-v1');
