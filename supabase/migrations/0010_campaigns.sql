-- ============================================================================
-- campaigns: one promotional broadcast.
--
-- Holds the audience definition, schedule, status machine, denormalised
-- counters, and cost tracking. Counters are maintained by the trigger added
-- in migration 0017; treat as approximate for high-volume displays.
--
-- Status machine:
--   draft → scheduled → materialising → sending → (completed | paused |
--                                                  cancelled | failed)
--   paused can return to sending; cancelled / completed are terminal.
--
-- Companion code:
--   src/core/campaigns/{validate,audience,cost,dispatch}.ts
--   src/app/api/campaigns/...
-- ============================================================================

CREATE TABLE IF NOT EXISTS campaigns (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  template_id              UUID NOT NULL REFERENCES templates(id) ON DELETE RESTRICT,

  name                     TEXT NOT NULL,
  description              TEXT,

  -- {kind:'filter', filter:{...}} or {kind:'csv', upload_id:'...'}.
  -- Validated by application code; freeform JSONB at the DB layer.
  audience_definition      JSONB NOT NULL,
  audience_size            INT,             -- set by materialiser when known

  -- {"1":"$user.name","2":"$static:35%","3":"$user.attributes.last_service"}
  variable_mapping         JSONB NOT NULL,

  scheduled_at             TIMESTAMPTZ,     -- NULL = send immediately
  timezone                 TEXT NOT NULL,   -- tenant TZ snapshot at create time

  status                   TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'scheduled', 'materialising', 'sending',
                      'paused', 'completed', 'cancelled', 'failed')),
  pause_reason             TEXT
    CHECK (pause_reason IS NULL OR pause_reason IN
           ('quality_red', 'tier_exceeded', 'manual', 'budget_exhausted')),

  created_by               TEXT NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at               TIMESTAMPTZ,
  completed_at             TIMESTAMPTZ,

  -- Counters maintained by trigger; a nightly pg_cron job reconciles them
  -- from campaign_recipients to fix any drift caused by concurrent updates.
  total_recipients         INT NOT NULL DEFAULT 0,
  sent_count               INT NOT NULL DEFAULT 0,
  delivered_count          INT NOT NULL DEFAULT 0,
  read_count               INT NOT NULL DEFAULT 0,
  failed_count             INT NOT NULL DEFAULT 0,
  skipped_count            INT NOT NULL DEFAULT 0,

  -- Integer cents (paise for INR). Never float — currency math demands exact.
  estimated_cost_cents     BIGINT,
  actual_cost_cents        BIGINT NOT NULL DEFAULT 0
);

-- Scheduler pull: "which scheduled campaigns are due now?"
CREATE INDEX IF NOT EXISTS campaigns_tenant_status_scheduled_idx
  ON campaigns (tenant_id, status, scheduled_at);

-- Dashboard list: "show this tenant's recent campaigns."
CREATE INDEX IF NOT EXISTS campaigns_tenant_created_idx
  ON campaigns (tenant_id, created_at DESC);

-- ─── RLS ────────────────────────────────────────────────────────────────────
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_campaigns ON campaigns;
CREATE POLICY tenant_isolation_campaigns ON campaigns
  USING (tenant_id::text = (auth.jwt() ->> 'tenant_id'));
