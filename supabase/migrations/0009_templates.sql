-- ============================================================================
-- templates: tenant-owned, Meta-approved WhatsApp message templates.
--
-- One row per (tenant, meta_template_name, language). Editing a template
-- requires resubmitting to Meta (status returns to 'submitted').
--
-- Status machine: draft → submitted → (approved | rejected | paused | disabled)
--
-- Compliance:
--   * MARKETING templates must include an opt-out footer (auto-injected by
--     the template editor in app code; see campaign-mvp-design.md §6.3).
--   * category is enforced by CHECK; mis-categorising leads to Meta auto-
--     re-categorising the template and pausing it.
--
-- Companion code: src/core/campaigns/templates/{submit,media}.ts
-- ============================================================================

CREATE TABLE IF NOT EXISTS templates (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  meta_template_name  TEXT NOT NULL,        -- e.g. 'summer_promo_2026'
  meta_template_id    TEXT,                 -- Meta's internal id; set on submission
  language            TEXT NOT NULL,        -- BCP-47-ish e.g. 'en_US', 'hi_IN'
  category            TEXT NOT NULL
    CHECK (category IN ('MARKETING', 'UTILITY', 'AUTHENTICATION', 'SERVICE')),

  status              TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'approved', 'rejected', 'paused', 'disabled')),
  rejection_reason    TEXT,

  -- Template body with {{1}}, {{2}} placeholders. Meta's review compares
  -- this and the variable_schema example values against what we eventually
  -- send; both must match or sends fail with code 132012.
  body_text           TEXT NOT NULL,

  header_type         TEXT
    CHECK (header_type IS NULL
           OR header_type IN ('TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT')),
  header_payload      JSONB,                -- {url, meta_media_id, text, example}

  footer_text         TEXT,                 -- auto-injected for MARKETING

  buttons             JSONB,                -- Meta's buttons spec, verbatim
  variable_schema     JSONB,                -- [{name, type, example}]

  submitted_at        TIMESTAMPTZ,
  approved_at         TIMESTAMPTZ,

  created_by          TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, meta_template_name, language)
);

-- "List my approved templates" — dashboard template picker.
CREATE INDEX IF NOT EXISTS templates_tenant_status_idx
  ON templates (tenant_id, status);

-- ─── RLS ────────────────────────────────────────────────────────────────────
ALTER TABLE templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_templates ON templates;
CREATE POLICY tenant_isolation_templates ON templates
  USING (tenant_id::text = (auth.jwt() ->> 'tenant_id'));
