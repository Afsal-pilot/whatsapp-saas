-- ============================================================================
-- campaign_recipients: one row per (campaign, contact) — the hot table.
--
-- Lifecycle: pending → queued → sent → (delivered → read | failed)
--                                 → skipped
--
-- Idempotency: UNIQUE (campaign_id, wa_id) means the materialiser can retry
-- a chunk without inserting duplicates. The worker's per-recipient send
-- relies on (campaign_recipients row id) + (messages.wa_message_id UNIQUE)
-- to guarantee at-most-once delivery even under QStash redelivery.
--
-- Scale plan: keep as a single table at MVP. When row count exceeds ~500M,
-- switch to PARTITION BY HASH (campaign_id) × 32 — the indexes below carry
-- over because the partition key is a leading column on every hot path.
--
-- Companion code: src/core/campaigns/{audience,dispatch}.ts
-- ============================================================================

CREATE TABLE IF NOT EXISTS campaign_recipients (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id         UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id             UUID REFERENCES users(id) ON DELETE SET NULL,
  wa_id               TEXT NOT NULL,         -- denormalised from users.wa_id

  template_vars       JSONB NOT NULL,        -- resolved per-recipient
  send_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  status              TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'queued', 'sent', 'delivered',
                      'read', 'failed', 'skipped')),
  skip_reason         TEXT
    CHECK (skip_reason IS NULL OR skip_reason IN
           ('opted_out', 'us_number', 'frequency_cap', 'invalid_wa_id',
            'no_consent', 'tier_exceeded')),
  failure_code        TEXT,                  -- Meta error code (e.g. '131049')
  failure_reason      TEXT,                  -- truncated message, ≤ 500 chars

  sent_at             TIMESTAMPTZ,
  delivered_at        TIMESTAMPTZ,
  read_at             TIMESTAMPTZ,
  failed_at           TIMESTAMPTZ,

  wa_message_id       TEXT,                  -- joins to messages.wa_message_id
  message_id          UUID REFERENCES messages(id) ON DELETE SET NULL,

  retry_count         INT NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (campaign_id, wa_id)
);

-- Worker pull: "next N pending recipients for this campaign whose send_at
-- has elapsed". Partial — the only state the worker queries on.
CREATE INDEX IF NOT EXISTS campaign_recipients_worker_queue_idx
  ON campaign_recipients (tenant_id, campaign_id, send_at)
  WHERE status = 'pending';

-- Webhook fan-in: status callbacks arrive with wa_message_id; we patch the
-- corresponding recipient. Partial; wa_message_id is NULL until send returns.
CREATE INDEX IF NOT EXISTS campaign_recipients_wa_message_idx
  ON campaign_recipients (wa_message_id)
  WHERE wa_message_id IS NOT NULL;

-- "Has user X received any campaigns?" — dashboard contact history.
CREATE INDEX IF NOT EXISTS campaign_recipients_tenant_user_idx
  ON campaign_recipients (tenant_id, user_id, campaign_id)
  WHERE user_id IS NOT NULL;

-- Drill-down: "show me FAILED recipients for campaign X" — paginated UI.
CREATE INDEX IF NOT EXISTS campaign_recipients_campaign_status_idx
  ON campaign_recipients (campaign_id, status, created_at DESC);

-- ─── RLS ────────────────────────────────────────────────────────────────────
ALTER TABLE campaign_recipients ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_campaign_recipients ON campaign_recipients;
CREATE POLICY tenant_isolation_campaign_recipients ON campaign_recipients
  USING (tenant_id::text = (auth.jwt() ->> 'tenant_id'));
