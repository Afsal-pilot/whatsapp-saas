-- ============================================================================
-- consent_events: append-only audit trail of opt-in / opt-out / resubscribe.
--
-- Meta may request these records during account disputes; they substantiate
-- our right to message a given wa_id from a given tenant. NEVER delete rows.
--
-- Source of truth for consent state. users.{marketing_consent_at,
-- opted_out_at} are denormalised caches for fast filtering; this table is
-- the audit-grade record.
--
-- Conventional `source` values (free-form text, but use these labels):
--   web_form              opt-in via tenant-branded opt-in page
--   whatsapp_inline_prompt opt-in via in-chat YES/SUBSCRIBE reply
--   whatsapp_inbound_stop opt-out via inbound STOP/UNSUBSCRIBE
--   csv_import            bulk import with audit fields
--   admin_action          tenant admin manually marked
--   meta_webhook_opt_out  Meta-signalled opt-out (rare)
--
-- Helper function `is_opted_in()` derives current state from the latest row
-- for (tenant, wa_id, category|'all'). Single source of truth — used by
-- audience materialiser and pre-send checks.
-- ============================================================================

CREATE TABLE IF NOT EXISTS consent_events (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id                  UUID REFERENCES users(id) ON DELETE SET NULL,
  wa_id                    TEXT NOT NULL,

  event_type               TEXT NOT NULL
    CHECK (event_type IN ('opt_in', 'opt_out', 'consent_revoked', 'resubscribed')),
  category                 TEXT NOT NULL
    CHECK (category IN ('marketing', 'utility', 'all')),

  source                   TEXT NOT NULL,
  source_payload           JSONB NOT NULL,    -- ip, ua, referrer, raw webhook, etc.

  -- The business name the user actually saw at point of opt-in. Meta requires
  -- this on audit (proves they agreed to messages from THIS brand).
  business_name_shown      TEXT NOT NULL,
  consent_text_version     TEXT,              -- hash of consent text shown

  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- "What is the latest consent state for wa_id X on tenant Y?" — the audience
-- materialiser's hot check.
CREATE INDEX IF NOT EXISTS consent_events_tenant_wa_id_created_idx
  ON consent_events (tenant_id, wa_id, created_at DESC);

-- "Export all opt-outs in the last quarter" — compliance reporting.
CREATE INDEX IF NOT EXISTS consent_events_tenant_created_idx
  ON consent_events (tenant_id, created_at DESC);

-- ─── helper: is_opted_in() ──────────────────────────────────────────────────
-- The single rule for "is this person opted in?" derived from latest event.
-- Used by audience.ts at materialisation time and dispatch.ts as a defense-
-- in-depth check just before each send.
CREATE OR REPLACE FUNCTION is_opted_in(
  p_tenant_id UUID,
  p_wa_id     TEXT,
  p_category  TEXT
)
RETURNS BOOLEAN
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(
    (SELECT event_type IN ('opt_in', 'resubscribed')
       FROM consent_events
      WHERE tenant_id = p_tenant_id
        AND wa_id = p_wa_id
        AND category IN (p_category, 'all')
      ORDER BY created_at DESC
      LIMIT 1),
    FALSE
  );
$$;

-- ─── RLS ────────────────────────────────────────────────────────────────────
ALTER TABLE consent_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_consent_events ON consent_events;
CREATE POLICY tenant_isolation_consent_events ON consent_events
  USING (tenant_id::text = (auth.jwt() ->> 'tenant_id'));
