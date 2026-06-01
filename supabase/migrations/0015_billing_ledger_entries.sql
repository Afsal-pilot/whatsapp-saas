-- ============================================================================
-- billing_ledger_entries: append-only money log.
--
-- Every cost-affecting event: campaign reservation, finalisation, platform
-- fee, manual adjustment. Refunds are NEGATIVE-amount rows, not updates to
-- existing rows. Stripe / Razorpay invoicing reads this table.
--
-- Lifecycle (a single campaign produces typically 2–3 rows):
--   1. On confirm:          type='reservation', amount=estimate, status='pending'
--   2. On complete:         type='final',       amount=actual,   status='final'
--   3. If reservation > actual: type='adjustment', amount=-delta, status='final'
--
-- Companion code: src/core/campaigns/billing/reservation.ts
-- ============================================================================

CREATE TABLE IF NOT EXISTS billing_ledger_entries (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id   UUID REFERENCES campaigns(id) ON DELETE SET NULL,

  type          TEXT NOT NULL
    CHECK (type IN ('reservation', 'final', 'platform_fee', 'adjustment')),

  -- Signed integer cents. Negative = refund/credit. Integer only; never float.
  amount_cents  BIGINT NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'INR',

  status        TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'final', 'refunded', 'void')),

  description   TEXT,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at    TIMESTAMPTZ
);

-- "Show me this tenant's billing history" — dashboard ledger.
CREATE INDEX IF NOT EXISTS billing_ledger_tenant_created_idx
  ON billing_ledger_entries (tenant_id, created_at DESC);

-- "Sum spend for campaign X" — used by reconciliation + invoicing.
CREATE INDEX IF NOT EXISTS billing_ledger_campaign_idx
  ON billing_ledger_entries (campaign_id, type, status)
  WHERE campaign_id IS NOT NULL;

-- ─── RLS ────────────────────────────────────────────────────────────────────
ALTER TABLE billing_ledger_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_billing_ledger ON billing_ledger_entries;
CREATE POLICY tenant_isolation_billing_ledger ON billing_ledger_entries
  USING (tenant_id::text = (auth.jwt() ->> 'tenant_id'));
