-- ============================================================================
-- Resilience & ops migration.
--
-- 1. Conversation race fix: partial unique on (tenant_id, user_id) for
--    open conversations — two concurrent inbound messages can no longer
--    each create an "active" conversation for the same user.
-- 2. Delivery lifecycle on messages: per-state timestamps so we can show
--    sent / delivered / read / failed in a dashboard and alert on stalls.
-- 3. Tenant usage caps: monthly token budget + timezone for booking display.
-- 4. Rate-limit buckets: small table that the outbound limiter writes to.
-- 5. Audit logs: who-did-what for admin endpoints (GDPR delete, replay).
-- ============================================================================

-- ─── 1. conversations: prevent duplicate open threads ───────────────────────
-- Partial unique index handles the race in getOrCreateActiveConversation.
-- Closed / human-handover conversations are excluded so a user can have
-- multiple historical threads.
CREATE UNIQUE INDEX IF NOT EXISTS conversations_one_open_per_user
  ON conversations (tenant_id, user_id)
  WHERE status IN ('active', 'idle');

-- ─── 2. messages: delivery lifecycle ────────────────────────────────────────
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS sent_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delivered_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS read_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS failed_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS failure_reason TEXT,
  ADD COLUMN IF NOT EXISTS tokens_in      INTEGER,
  ADD COLUMN IF NOT EXISTS tokens_out     INTEGER,
  ADD COLUMN IF NOT EXISTS model          TEXT;

-- Used by the rate limiter to count recent outbound messages to a recipient,
-- and by the dashboard to show pending sends.
CREATE INDEX IF NOT EXISTS messages_tenant_direction_created_idx
  ON messages (tenant_id, direction, created_at DESC);

-- ─── 3. tenants: usage caps + timezone ──────────────────────────────────────
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS timezone             TEXT NOT NULL DEFAULT 'UTC',
  ADD COLUMN IF NOT EXISTS monthly_token_cap    BIGINT,
  ADD COLUMN IF NOT EXISTS monthly_tokens_used  BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS usage_period_start   DATE NOT NULL DEFAULT date_trunc('month', now())::date;

-- ─── 4. outbound rate limiter ───────────────────────────────────────────────
-- One row per (tenant, recipient) sliding window. The limiter increments
-- `count` until the window expires, then resets. Sparse table — entries
-- decay via the cleanup job (see scripts/).
CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  recipient    TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, recipient, window_start)
);
CREATE INDEX IF NOT EXISTS rate_limit_buckets_window_idx
  ON rate_limit_buckets (window_start);

-- ─── 5. audit log for admin actions ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_logs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID REFERENCES tenants(id) ON DELETE SET NULL,
  actor        TEXT NOT NULL,            -- 'admin:<key-hint>' or 'system'
  action       TEXT NOT NULL,            -- 'gdpr_delete' | 'webhook_replay' | ...
  target       TEXT,                     -- user id, event id, etc.
  details      JSONB NOT NULL DEFAULT '{}'::jsonb,
  request_id   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_logs_tenant_created_idx
  ON audit_logs (tenant_id, created_at DESC);
