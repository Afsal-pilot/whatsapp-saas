-- ============================================================================
-- users: marketing consent timestamp + opt-out fast path.
--
-- Denormalised mirrors of consent_events (the source of truth, see migration
-- 0013). These columns let the audience materialiser prune ineligible
-- recipients without a JOIN, which keeps the hot path cheap.
--
-- Both NULL by default. App code sets them in lockstep with consent_events
-- INSERTs (single transaction).
-- ============================================================================

-- ─── columns ────────────────────────────────────────────────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS marketing_consent_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS opted_out_at          TIMESTAMPTZ;

-- ─── indexes ────────────────────────────────────────────────────────────────
-- Audience-builder hot query: "give me all wa_ids eligible to receive
-- marketing for this tenant." Partial index = only the rows we care about.
CREATE INDEX IF NOT EXISTS users_tenant_marketing_eligible_idx
  ON users (tenant_id)
  WHERE marketing_consent_at IS NOT NULL AND opted_out_at IS NULL;

-- Compliance export: "list everyone who opted out from this tenant."
-- Partial; opt-out is rare relative to the user base.
CREATE INDEX IF NOT EXISTS users_tenant_opted_out_idx
  ON users (tenant_id, opted_out_at)
  WHERE opted_out_at IS NOT NULL;
