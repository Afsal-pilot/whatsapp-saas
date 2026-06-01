-- ============================================================================
-- WAPI: initial schema
--
-- Tables:
--   users            — WhatsApp end-users (your customers' customers)
--   conversations    — one thread per (tenant, user)
--   messages         — every inbound + outbound message
--   webhook_events   — raw Meta payloads, for replay and idempotency
--
-- Notes:
--   * `tenant_id` is included on every table from day one so RLS and
--     multi-tenant scaling cost nothing later.
--   * Idempotency is enforced by UNIQUE(wa_message_id) and webhook_events.id.
--   * RLS policies use a `tenant_id` JWT claim — set this from your auth layer.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── tenants ────────────────────────────────────────────────────────────────
CREATE TABLE tenants (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── users (WhatsApp contacts) ──────────────────────────────────────────────
CREATE TABLE users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  wa_id       TEXT NOT NULL,
  name        TEXT,
  locale      TEXT,
  attributes  JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, wa_id)
);
CREATE INDEX users_tenant_lastseen_idx ON users (tenant_id, last_seen DESC);

-- ─── conversations ──────────────────────────────────────────────────────────
CREATE TYPE conversation_status AS ENUM ('active', 'idle', 'closed', 'human');

CREATE TABLE conversations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status          conversation_status NOT NULL DEFAULT 'active',
  current_agent   TEXT,
  summary         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX conversations_tenant_status_idx
  ON conversations (tenant_id, status, updated_at DESC);
CREATE INDEX conversations_user_idx ON conversations (user_id, updated_at DESC);

-- ─── messages ───────────────────────────────────────────────────────────────
CREATE TYPE message_direction AS ENUM ('in', 'out');
CREATE TYPE message_sender_type AS ENUM ('user', 'agent', 'human', 'system');

CREATE TABLE messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  wa_message_id   TEXT UNIQUE,           -- Meta's id; UNIQUE gives us idempotency
  direction       message_direction NOT NULL,
  sender_type     message_sender_type NOT NULL,
  content_type    TEXT NOT NULL,         -- text|image|audio|video|document|template
  text            TEXT,
  media_url       TEXT,
  media_mime      TEXT,
  status          TEXT,                  -- queued|sent|delivered|read|failed
  meta            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX messages_conversation_created_idx
  ON messages (conversation_id, created_at);

-- ─── webhook_events (raw payload + retry log) ───────────────────────────────
CREATE TYPE webhook_event_status AS ENUM ('received', 'processing', 'processed', 'failed');

CREATE TABLE webhook_events (
  id            TEXT PRIMARY KEY,        -- WA message id when available, else uuid
  tenant_id     UUID REFERENCES tenants(id) ON DELETE SET NULL,
  payload       JSONB NOT NULL,
  status        webhook_event_status NOT NULL DEFAULT 'received',
  attempts      INT NOT NULL DEFAULT 0,
  error         TEXT,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at  TIMESTAMPTZ
);
CREATE INDEX webhook_events_pending_idx
  ON webhook_events (status, received_at)
  WHERE status <> 'processed';

-- ─── trigger: keep conversations.updated_at fresh ───────────────────────────
CREATE OR REPLACE FUNCTION touch_conversation_updated_at() RETURNS trigger AS $$
BEGIN
  UPDATE conversations SET updated_at = now() WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER messages_touch_conversation
AFTER INSERT ON messages
FOR EACH ROW EXECUTE FUNCTION touch_conversation_updated_at();

-- ─── RLS (off by default for service-role workloads, on for dashboard) ─────
-- The service role bypasses RLS, so workers are unaffected.
-- Enable + add policies if/when you expose these tables to the browser.
ALTER TABLE users          ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages       ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;

-- Example tenant-isolation policy. Adjust JWT claim name to match your auth.
CREATE POLICY tenant_isolation_users ON users
  USING (tenant_id::text = (auth.jwt() ->> 'tenant_id'));
CREATE POLICY tenant_isolation_conversations ON conversations
  USING (tenant_id::text = (auth.jwt() ->> 'tenant_id'));
CREATE POLICY tenant_isolation_messages ON messages
  USING (tenant_id::text = (auth.jwt() ->> 'tenant_id'));
