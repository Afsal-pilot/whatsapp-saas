-- ============================================================================
-- tenants: Embedded Signup + quality + tier + marketing budget columns.
--
-- Additive ALTERs. Idempotent (IF NOT EXISTS). Adds the per-tenant fields
-- needed once each tenant connects their own WhatsApp Business Account via
-- Meta Embedded Signup, plus the quality/tier signals from Meta webhooks and
-- the platform-level monthly spend cap.
--
-- Companion code: src/core/tenants/types.ts (Tenant type gets these fields).
-- ============================================================================

-- ─── columns ────────────────────────────────────────────────────────────────
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS waba_id                         TEXT,
  ADD COLUMN IF NOT EXISTS encrypted_meta_token            TEXT,
  ADD COLUMN IF NOT EXISTS display_name                    TEXT,
  ADD COLUMN IF NOT EXISTS tenant_slug                     TEXT,
  ADD COLUMN IF NOT EXISTS current_quality_rating          TEXT,
  ADD COLUMN IF NOT EXISTS current_tier                    TEXT,
  ADD COLUMN IF NOT EXISTS monthly_marketing_budget_cents  BIGINT;

-- ─── uniqueness (partial on non-null; mirrors phone_number_id from 0004) ────
-- tenant_slug powers the per-tenant opt-in URL (optin.wapi.com/t/<slug>).
CREATE UNIQUE INDEX IF NOT EXISTS tenants_tenant_slug_unique
  ON tenants (tenant_slug)
  WHERE tenant_slug IS NOT NULL;

-- One WABA per tenant. Like phone_number_id, NULL allowed during the brief
-- window between tenant row creation and Embedded Signup completion.
CREATE UNIQUE INDEX IF NOT EXISTS tenants_waba_id_unique
  ON tenants (waba_id)
  WHERE waba_id IS NOT NULL;

-- ─── CHECK constraints (drop-and-add for idempotency) ───────────────────────
-- Quality rating is a bounded enum from Meta's webhook. NULL allowed for
-- not-yet-rated numbers.
ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_quality_rating_check;
ALTER TABLE tenants
  ADD CONSTRAINT tenants_quality_rating_check
  CHECK (current_quality_rating IS NULL
         OR current_quality_rating IN ('GREEN', 'YELLOW', 'RED'));

-- Messaging tier ladder. TIER_250 is the trial floor for unverified
-- businesses; TIER_1K is the default after Meta business verification.
ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_current_tier_check;
ALTER TABLE tenants
  ADD CONSTRAINT tenants_current_tier_check
  CHECK (current_tier IS NULL
         OR current_tier IN ('TIER_250', 'TIER_1K', 'TIER_10K', 'TIER_100K', 'UNLIMITED'));
