# WAPI Promotional Campaign — MVP Design Document

> **Status:** Final draft for engineering execution
> **Version:** MVP v1
> **Date:** 2026-05-31
> **Owner:** Afsal
> **Scope:** Build a Meta-compliant, multi-tenant WhatsApp promotional broadcast feature on top of the existing `whatsapp-saas` monorepo. Designed to be safe to launch, defensible against Meta audit, and extensible without rework.

---

## 0. Context

The `whatsapp-saas` monorepo today handles only **1:1 AI conversations** inside Meta's 24-hour window. There is no outbound broadcast capability — no template send, no audience model, no opt-in capture, no opt-out handling.

This document specifies the **MVP** for adding promotional campaign push: tenants like a salon ("Glow Hair Studio") can collect customer consent, build approved templates, target an opted-in audience, and send Meta-compliant marketing messages with delivery tracking and opt-out compliance.

The design is driven by **Meta's 2025/2026 rules** (see Appendix A). Anything that violates those rules risks tenant phone-number suspension and platform-level BSP revocation, both of which are largely unrecoverable.

---

## 1. MVP Scope

### In scope (this document)

1. **Tenant onboarding** via Meta Embedded Signup — each tenant attaches their own WhatsApp Business Account with an isolated quality rating.
2. **Customer opt-in page** at `optin.wapi.com/t/{tenant_slug}` — tenant-branded consent capture with full audit trail.
3. **STOP / opt-out handler** in the inbound webhook — multi-language keyword detection, immediate honor across all tenant campaigns.
4. **Template management (self-serve)** — tenant creates, submits, edits, and manages their own Meta-approved templates via the dashboard with full media support (text / image / video / document headers).
5. **Audience builder** — filter over opted-in users; auto-prune opted-out, US numbers, frequency-cap exceeded, invalid numbers.
6. **Campaign send** — queued via QStash, throttled below 80 MPS, per-batch idempotent, with full delivery tracking.
7. **Live campaign dashboard** — counters (sent / delivered / read / failed / skipped with reasons), pre-send cost estimate, pause/resume/cancel.
8. **Quality auto-pause** — webhook handler that pauses campaigns when tenant's quality rating drops to RED.
9. **Per-tenant monthly spend cap** — hard limit on marketing cost.
10. **Cost transparency** — dashboard shows Meta's per-region cost broken down by recipient region.

### Out of scope (Phase 2+)

- CSV upload audience source (filter-based only at MVP)
- A/B variants on the same campaign
- Click tracking via wrapped URLs
- Recurring / drip / journey campaigns
- WhatsApp Flows
- Multi-region data residency
- Per-tenant API access (tenants use dashboard only)

### Deferred for separate discussion

- **Embedded Signup integration details** (Meta-hosted popup vs custom flow, JS SDK wrapping, access-token rotation handling) — decision is "use Embedded Signup," implementation TBD.
- **Dashboard auth method** — Supabase Auth vs SSO.

---

## 2. Compliance bedrock — the 12 rules every design decision traces back to

Quick reference. Full detail in Appendix A.

| # | Rule | Where enforced in our system |
|---|---|---|
| C1 | Marketing outside 24h window requires approved template | `sendTemplate()` in `src/core/clients/whatsapp.ts` |
| C2 | Max ~2 marketing msgs / user / 24h (error 131049) | `quotas.ts` pre-send check + reconciliation from Meta errors |
| C3 | No marketing to US (+1) numbers | Audience materialiser skips with `skip_reason='us_number'` |
| C4 | STOP / UNSUBSCRIBE must be honored immediately, multi-lang | `opt-out.ts` short-circuit in `/api/webhook` before Claude |
| C5 | Opt-in must be auditable (timestamp, source, business name) | `consent_events` table — append-only, never deleted |
| C6 | Quality rating drives ability to scale | `tenants.current_quality_rating` + auto-pause on RED |
| C7 | Tier limits per business portfolio (Oct 2025) | `tenants.current_tier` tracking |
| C8 | API throughput 80 MPS / 10 RPS | `dispatch.ts` batch sizing + throttle |
| C9 | No volume discount on marketing | Cost ledger per delivered message |
| C10 | BSP must enforce, can't trust tenant | All checks platform-side |
| C11 | Marketing templates need STOP footer | Template editor auto-injects + validates |
| C12 | Frequency cap is global across all businesses | Treat pre-check as best-effort; reconcile from webhooks |

---

## 3. Three actors, three flows

### Roles

| Actor | Who | Example |
|---|---|---|
| **Platform** | You — WAPI | Built and operated by your team |
| **Tenant** | Business owner | Riya, owner of Glow Hair Studio |
| **End user** | Recipient | Priya, a customer of Glow |

### 3.1 Tenant onboarding flow (Embedded Signup)

Riya signs up to WAPI and connects her WhatsApp number.

```
Riya → wapi.com/onboard
   ↓ creates account (email + password)
   ↓ Supabase Auth issues JWT with tenant_id
   ↓ lands on dashboard "Setup" page
   ↓ clicks "Connect WhatsApp"
   ↓ Meta-hosted popup opens (Embedded Signup)
   ↓ logs in with Facebook
   ↓ selects/creates Business Portfolio
   ↓ adds her phone +91-98765-43210
   ↓ verifies via OTP from Meta
   ↓ sets display name "Glow Hair Studio"
   ↓ authorizes WAPI to send on her behalf
   ↓ Meta returns to our callback with:
     - phone_number_id
     - waba_id
     - access_token (system-user, never expires)
   ↓ WAPI writes to tenants row (access_token encrypted)
   ↓ WAPI subscribes the WABA to our webhook URL
   ↓ Riya sees "✓ Connected" badge
```

**Implementation specifics deferred** — see §1 "Deferred."

What's locked in:
- Each tenant has their own `phone_number_id`, `waba_id`, `access_token`
- Quality rating + tier are tenant-isolated
- Tenant's customers see "Glow Hair Studio", not "WAPI"

### 3.2 Customer opt-in flow (Step 0 — must ship before anything else)

The opt-in page is **tenant-branded** and lives on a per-tenant URL.

```
optin.wapi.com/t/glow-hair-studio
```

#### Page UX

```
┌─────────────────────────────────────────────────────┐
│              Glow Hair Studio                       │
│       [tenant logo if uploaded]                     │
│                                                     │
│   Get appointment reminders & special offers        │
│   on WhatsApp                                       │
│                                                     │
│   We'll send you:                                   │
│   • Booking confirmations & reminders               │
│   • Birthday offers                                 │
│   • Seasonal promotions                             │
│                                                     │
│   Your name:    [ Priya Sharma             ]        │
│   Phone:        [ +91 │ 98xxx xxxxx        ]        │
│                                                     │
│   ☐ I agree to receive WhatsApp messages from       │
│     Glow Hair Studio. I can reply STOP anytime      │
│     to unsubscribe.                                 │
│                                                     │
│              [   Subscribe   ]                      │
│                                                     │
│   By subscribing you agree to our Privacy Policy.   │
└─────────────────────────────────────────────────────┘
```

#### Server flow on submit

```ts
POST /api/optin/{tenant_slug}
Body: { name, phone, consent: true }

→ validate phone (E.164, libphonenumber)
→ resolve tenant from slug
→ INSERT or UPDATE users (tenant_id, wa_id, name, marketing_consent_at)
→ INSERT consent_events {
    tenant_id, wa_id, event_type='opt_in', category='marketing',
    source='web_form',
    source_payload={ url, ip, user_agent, referrer, page_session_id },
    business_name_shown=tenant.display_name
  }
→ return 200 + confirmation page
```

The user is now opted in. Their `wa_id` is eligible to be included in future campaigns from this tenant.

#### Required audit fields (Meta requires these for opt-in defense)

| Field | Source |
|---|---|
| `wa_id` | From phone input, normalized to E.164 |
| `created_at` | now() |
| `source` | `'web_form'` |
| `source_payload.url` | The opt-in page URL |
| `source_payload.ip` | Client IP (from request headers) |
| `source_payload.user_agent` | From request headers |
| `business_name_shown` | The tenant's display_name as rendered on the page |
| `consent_text_version` | Hash of the exact consent text shown (for version control) |

### 3.3 Sending a promotional campaign (the main flow)

Riya runs her "Summer Promo" campaign. Sequence:

```
Riya (dashboard)
  ↓ picks template "summer_promo_2026"
  ↓ builds audience: filter = "marketing_consent_at IS NOT NULL"
  ↓ maps variables: {{1}} → user.name, {{2}} → "35"
  ↓ sees cost estimate: 1,800 × ₹1.20 = ₹2,160
  ↓ confirms

POST /api/campaigns
  → validate (template approved, vars mapped, budget OK)
  → INSERT campaigns row (status='scheduled')
  → ENQUEUE materialise-audience job
  ↓

QStash → /api/jobs/materialise-audience
  → for each chunk of 5,000 users matching filter:
    → prune: opt-out, US numbers, frequency-cap, invalid wa_id
    → INSERT campaign_recipients (status='pending')
  → on final chunk: UPDATE campaigns SET audience_size=N
  → ENQUEUE first send batch
  ↓

QStash → /api/jobs/send-campaign-batch (chained, batch=100)
  → SELECT next 100 pending recipients
  → for each (throttled to ≤ 80 MPS):
    → re-check users.opted_out_at (defense in depth)
    → checkAndIncrement rate-limit bucket
    → resolve template variables for this recipient
    → sendTemplate(to, template, {phoneNumberId: tenant.pn_id})
    → INSERT messages (conversation_id=NULL, campaign_id, content_type='template')
    → UPDATE campaign_recipients (status='sent', wa_message_id=...)
  → if more pending: enqueue next batch
  → else: UPDATE campaigns (status='completed', completed_at=now())
  ↓

Meta webhook → /api/webhook (status events)
  → existing applyDeliveryStatus patches messages row
  → DB trigger mirrors to campaign_recipients (delivered_at/read_at/failed_at)
  → DB trigger updates campaigns counters
  → on 'failed' with code 131049: bump user_marketing_quotas
  ↓

Riya (dashboard)
  ← Supabase Realtime: counters update live
```

---

## 4. STOP / opt-out flow

This must ship in lockstep with the opt-in page — **shipping opt-in without opt-out is non-compliant.**

```
Priya → sends "STOP" to Glow's number
   ↓
Meta webhook → /api/webhook
   ↓
NEW: tryHandleOptOut(inbound)
   - normalize text: trim, uppercase
   - test against OPT_OUT_REGEX:
     /^(STOP|UNSUBSCRIBE|CANCEL|QUIT|END|REMOVE|OPT\s*OUT|
       PARAR|CANCELAR|BERHENTI|रोको|बंद|நிறுத்து|إيقاف|取消|退订)\b/i
   - if match:
     → INSERT consent_events (event_type='opt_out', source='whatsapp_inbound_stop',
       source_payload=raw_inbound)
     → UPDATE users SET opted_out_at = now()
     → check if 24h window is open (last inbound < 24h ago)
       - YES: sendText(to, "You're unsubscribed from Glow Hair Studio.
         You won't receive promotional messages. Reply START to resubscribe.")
       - NO: sendTemplate using a pre-approved 'optout_confirmation' UTILITY template
     → RETURN — never reaches Claude
   - if no match: continue to existing processWebhookPayload
```

**Why this must run BEFORE Claude:** if Priya sends "STOP" and Claude replies "Sorry to see you go!", that's a free-form text reply that Meta may interpret as continuing to message someone who opted out. Bypassing Claude entirely is the only safe pattern.

**Resubscribe:** detect "START", "UNSTOP", or similar → `consent_events.event_type='resubscribed'` → `users.opted_out_at = NULL`.

---

## 5. Data model

All new tables follow the existing RLS pattern at `supabase/migrations/0001_init.sql:108-123` (root-level shared schema, accessible to every service):

```sql
ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_<table> ON <table>
  USING (tenant_id::text = (auth.jwt() ->> 'tenant_id'));
```

Server workers use `TenantClient` from `src/core/clients/supabase.ts` which scopes by tenant explicitly via service role.

Migration files: split into one focused file per concern (`0006`–`0017`) for atomic review and selective rollback. Apply in numeric order:

| # | File | Purpose |
|---|---|---|
| 0006 | `tenants_extend.sql` | ALTER tenants: waba_id, encrypted_meta_token, display_name, tenant_slug, current_quality_rating, current_tier, monthly_marketing_budget_cents + CHECK constraints |
| 0007 | `users_extend.sql` | ALTER users: marketing_consent_at, opted_out_at + partial indexes |
| 0008 | `messages_conversation_nullable.sql` | ALTER messages.conversation_id DROP NOT NULL |
| 0009 | `templates.sql` | CREATE templates + RLS + indexes |
| 0010 | `campaigns.sql` | CREATE campaigns + RLS + indexes |
| 0011 | `messages_campaign_link.sql` | ALTER messages ADD campaign_id FK + index |
| 0012 | `campaign_recipients.sql` | CREATE campaign_recipients + RLS + indexes |
| 0013 | `consent_events.sql` | CREATE consent_events + RLS + indexes + `is_opted_in()` helper |
| 0014 | `user_marketing_quotas.sql` | CREATE user_marketing_quotas (global, no RLS) |
| 0015 | `billing_ledger_entries.sql` | CREATE billing_ledger_entries + RLS + indexes |
| 0016 | `messages_status_mirror_trigger.sql` | messages → campaign_recipients status mirror |
| 0017 | `campaign_counters_trigger.sql` | campaign_recipients → campaigns counter delta |

### 5.1 Changes to EXISTING tables

#### `tenants`
```sql
ALTER TABLE tenants ADD COLUMN
  phone_number_id TEXT,                          -- already exists from 0004
  waba_id TEXT,                                  -- NEW
  encrypted_meta_token TEXT,                     -- NEW (encrypted at rest)
  display_name TEXT,                             -- NEW (from Embedded Signup)
  tenant_slug TEXT UNIQUE,                       -- NEW (for opt-in URL)
  current_quality_rating TEXT,                   -- NEW ('GREEN','YELLOW','RED')
  current_tier TEXT,                             -- NEW ('TIER_1K'...'UNLIMITED')
  monthly_marketing_budget_cents BIGINT;         -- NEW (hard spend cap)
```

#### `users`
```sql
ALTER TABLE users ADD COLUMN
  marketing_consent_at TIMESTAMPTZ,
  opted_out_at TIMESTAMPTZ;

CREATE INDEX users_tenant_marketing_eligible_idx
  ON users (tenant_id)
  WHERE marketing_consent_at IS NOT NULL AND opted_out_at IS NULL;

CREATE INDEX users_tenant_opted_out_idx
  ON users (tenant_id, opted_out_at)
  WHERE opted_out_at IS NOT NULL;
```

#### `messages`
```sql
ALTER TABLE messages
  ALTER COLUMN conversation_id DROP NOT NULL,    -- broadcast msgs have no conversation
  ADD COLUMN campaign_id UUID NULL REFERENCES campaigns(id);

CREATE INDEX messages_campaign_idx
  ON messages (campaign_id)
  WHERE campaign_id IS NOT NULL;
```

### 5.2 NEW: `templates`

```sql
CREATE TABLE templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  meta_template_name TEXT NOT NULL,              -- e.g., 'summer_promo_2026'
  meta_template_id TEXT,                         -- Meta's internal id, set after submission
  language TEXT NOT NULL,                        -- 'en_US', 'hi_IN', etc.
  category TEXT NOT NULL CHECK (category IN ('MARKETING','UTILITY','AUTHENTICATION','SERVICE')),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','submitted','approved','rejected','paused','disabled')),
  rejection_reason TEXT,
  body_text TEXT NOT NULL,                       -- with {{1}}, {{2}} placeholders
  header_type TEXT CHECK (header_type IN ('TEXT','IMAGE','VIDEO','DOCUMENT')),
  header_payload JSONB,                          -- {url, meta_media_id, example_text}
  footer_text TEXT,                              -- auto-injected for MARKETING
  buttons JSONB,                                 -- [{type, text, url|payload}]
  variable_schema JSONB,                         -- [{name, type, example}]
  submitted_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  created_by TEXT NOT NULL,                      -- auth.users.id
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, meta_template_name, language)
);

CREATE INDEX templates_tenant_status_idx
  ON templates (tenant_id, status);
```

### 5.3 NEW: `campaigns`

```sql
CREATE TABLE campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  template_id UUID NOT NULL REFERENCES templates(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  description TEXT,
  audience_definition JSONB NOT NULL,            -- {kind:'filter', filter:{...}}
  audience_size INT,                             -- set after materialisation
  variable_mapping JSONB NOT NULL,               -- {"1":"$user.name","2":"$static:35"}
  scheduled_at TIMESTAMPTZ,                      -- NULL = send immediately
  timezone TEXT NOT NULL,                        -- tenant TZ snapshot
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','scheduled','materialising','sending','paused',
                      'completed','cancelled','failed')),
  pause_reason TEXT CHECK (pause_reason IN
    ('quality_red','tier_exceeded','manual','budget_exhausted')),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  -- denormalised counters (kept fresh by trigger; nightly recount fixes drift)
  total_recipients INT NOT NULL DEFAULT 0,
  sent_count INT NOT NULL DEFAULT 0,
  delivered_count INT NOT NULL DEFAULT 0,
  read_count INT NOT NULL DEFAULT 0,
  failed_count INT NOT NULL DEFAULT 0,
  skipped_count INT NOT NULL DEFAULT 0,
  estimated_cost_cents INT,
  actual_cost_cents INT NOT NULL DEFAULT 0
);

CREATE INDEX campaigns_tenant_status_scheduled_idx
  ON campaigns (tenant_id, status, scheduled_at);
CREATE INDEX campaigns_tenant_created_idx
  ON campaigns (tenant_id, created_at DESC);
```

### 5.4 NEW: `campaign_recipients` (the hot table)

```sql
CREATE TABLE campaign_recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),
  wa_id TEXT NOT NULL,                           -- denormalised from users
  template_vars JSONB NOT NULL,                  -- resolved per-recipient
  send_at TIMESTAMPTZ NOT NULL DEFAULT now(),    -- per-recipient (future TZ-aware)
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','queued','sent','delivered','read','failed','skipped')),
  skip_reason TEXT,                              -- 'opted_out'|'us_number'|'frequency_cap'|...
  failure_code TEXT,                             -- Meta error code (131049, etc.)
  failure_reason TEXT,                           -- ≤ 500 chars
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  wa_message_id TEXT,
  message_id UUID REFERENCES messages(id),
  retry_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, wa_id)                    -- idempotency on materialisation retry
);

-- worker pull query (partial index keeps it tiny)
CREATE INDEX campaign_recipients_worker_queue_idx
  ON campaign_recipients (tenant_id, campaign_id, status, send_at)
  WHERE status = 'pending';

-- webhook fan-in (must be O(1))
CREATE INDEX campaign_recipients_wa_message_idx
  ON campaign_recipients (wa_message_id)
  WHERE wa_message_id IS NOT NULL;

-- "did user X get campaign Y?" queries
CREATE INDEX campaign_recipients_tenant_user_idx
  ON campaign_recipients (tenant_id, user_id, campaign_id);
```

### 5.5 NEW: `consent_events` (compliance audit, never delete)

```sql
CREATE TABLE consent_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),              -- may be null if pre-user-creation
  wa_id TEXT NOT NULL,
  event_type TEXT NOT NULL
    CHECK (event_type IN ('opt_in','opt_out','consent_revoked','resubscribed')),
  category TEXT NOT NULL                          -- 'marketing'|'utility'|'all'
    CHECK (category IN ('marketing','utility','all')),
  source TEXT NOT NULL,                           -- 'web_form'|'whatsapp_inbound_stop'|...
  source_payload JSONB NOT NULL,                  -- raw evidence (ip, ua, referrer, etc.)
  business_name_shown TEXT NOT NULL,              -- what user agreed to (Meta requirement)
  consent_text_version TEXT,                      -- hash of consent text shown
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX consent_events_tenant_wa_id_idx
  ON consent_events (tenant_id, wa_id, created_at DESC);
CREATE INDEX consent_events_tenant_created_idx
  ON consent_events (tenant_id, created_at DESC);
```

Helper function:
```sql
CREATE FUNCTION is_opted_in(p_tenant_id UUID, p_wa_id TEXT, p_category TEXT)
RETURNS BOOLEAN
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(
    (SELECT event_type IN ('opt_in','resubscribed')
       FROM consent_events
      WHERE tenant_id = p_tenant_id
        AND wa_id = p_wa_id
        AND category IN (p_category, 'all')
      ORDER BY created_at DESC
      LIMIT 1),
    FALSE
  );
$$;
```

### 5.6 NEW: `user_marketing_quotas` (frequency-cap accounting)

```sql
-- global across tenants because Meta's cap is cross-business
CREATE TABLE user_marketing_quotas (
  wa_id TEXT NOT NULL,
  window_start_date DATE NOT NULL,
  sends_24h INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (wa_id, window_start_date)
);
```

**Note:** Best-effort soft check. Postgres row-contention is acceptable at MVP volumes. The interface (`tryReserveMarketingSlot(waId)`) is abstract so we can move to Upstash Redis at scale without API changes.

### 5.7 NEW: `billing_ledger_entries` (append-only money log)

```sql
CREATE TABLE billing_ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id UUID REFERENCES campaigns(id),
  type TEXT NOT NULL                              -- 'reservation'|'final'|'platform_fee'|'adjustment'
    CHECK (type IN ('reservation','final','platform_fee','adjustment')),
  amount_cents BIGINT NOT NULL,                   -- signed; negative for refunds
  currency TEXT NOT NULL DEFAULT 'INR',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','final','refunded','void')),
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at TIMESTAMPTZ
);

CREATE INDEX billing_ledger_tenant_created_idx
  ON billing_ledger_entries (tenant_id, created_at DESC);
```

### 5.8 Database triggers

```sql
-- 1. When messages delivery columns update and campaign_id set, mirror to campaign_recipients.
CREATE FUNCTION mirror_message_status_to_campaign_recipients()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE campaign_recipients
    SET status = NEW.status,
        delivered_at = NEW.delivered_at,
        read_at = NEW.read_at,
        failed_at = NEW.failed_at,
        failure_reason = NEW.failure_reason
  WHERE wa_message_id = NEW.wa_message_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER messages_after_update_mirror
  AFTER UPDATE OF status, delivered_at, read_at, failed_at ON messages
  FOR EACH ROW WHEN (NEW.campaign_id IS NOT NULL)
  EXECUTE FUNCTION mirror_message_status_to_campaign_recipients();

-- 2. Update denormalised counters on campaigns when campaign_recipients status changes.
CREATE FUNCTION update_campaign_counters()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'sent' AND OLD.status != 'sent' THEN
    UPDATE campaigns SET sent_count = sent_count + 1 WHERE id = NEW.campaign_id;
  ELSIF NEW.status = 'delivered' AND OLD.status != 'delivered' THEN
    UPDATE campaigns SET delivered_count = delivered_count + 1 WHERE id = NEW.campaign_id;
  ELSIF NEW.status = 'read' AND OLD.status != 'read' THEN
    UPDATE campaigns SET read_count = read_count + 1 WHERE id = NEW.campaign_id;
  ELSIF NEW.status = 'failed' AND OLD.status != 'failed' THEN
    UPDATE campaigns SET failed_count = failed_count + 1 WHERE id = NEW.campaign_id;
  ELSIF NEW.status = 'skipped' AND OLD.status != 'skipped' THEN
    UPDATE campaigns SET skipped_count = skipped_count + 1 WHERE id = NEW.campaign_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER campaign_recipients_after_update_count
  AFTER UPDATE OF status ON campaign_recipients
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION update_campaign_counters();
```

A nightly `pg_cron` job reconciles counters from `campaign_recipients` to fix any drift.

### 5.9 RLS policies for new tables

```sql
ALTER TABLE templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_templates ON templates
  USING (tenant_id::text = (auth.jwt() ->> 'tenant_id'));

ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_campaigns ON campaigns
  USING (tenant_id::text = (auth.jwt() ->> 'tenant_id'));

ALTER TABLE campaign_recipients ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_campaign_recipients ON campaign_recipients
  USING (tenant_id::text = (auth.jwt() ->> 'tenant_id'));

ALTER TABLE consent_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_consent_events ON consent_events
  USING (tenant_id::text = (auth.jwt() ->> 'tenant_id'));

ALTER TABLE billing_ledger_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_billing_ledger ON billing_ledger_entries
  USING (tenant_id::text = (auth.jwt() ->> 'tenant_id'));

-- user_marketing_quotas is platform-wide (no tenant_id), service-role only access.
```

---

## 6. Backend architecture

Base path: `services/backend/service_automation/saloon_automation/`

### 6.1 NEW files

#### Core module — `src/core/campaigns/`

| File | Purpose |
|---|---|
| `validate.ts` | `validateCampaignDraft(input)` — template approved, vars mapped, schedule future, budget OK, audience non-empty |
| `audience.ts` | `materialiseAudience(campaignId)` — expand filter in chunks; prune opt-out + US + freq-cap + invalid; INSERT recipients |
| `cost.ts` | `estimateCost(template, audienceByRegion)` — regional pricing × counts; returns `{currency, cents, breakdown}` |
| `dispatch.ts` | `sendBatch(campaignId, cursor, batchSize)` — pull pending, send, persist, chain next batch |
| `opt-out.ts` | `OPT_OUT_REGEX` (multi-lang), `tryHandleOptOut(inbound)`, `recordOptOut`, `recordOptIn`, `recordResubscribe` |
| `quotas.ts` | `tryReserveMarketingSlot(waId)` — atomic INCR against `user_marketing_quotas`; abstract enough to swap to Redis |
| `pricing.ts` | Per-region marketing template rates (₹1.20 India, etc.); updated quarterly |
| `templates/submit.ts` | `submitTemplateToMeta(template)` — POST to `/{waba_id}/message_templates`; uses tenant's access_token |
| `templates/media.ts` | `uploadHeaderMedia(file, type)` — Supabase Storage upload + Meta media upload API |
| `billing/reservation.ts` | `reserveCampaignBudget(campaignId)`, `finaliseCost(campaignId)` — ledger entries |

#### API routes — `src/app/api/`

```
optin/
  [tenant_slug]/route.ts          POST  capture consent
campaigns/
  route.ts                        POST (create), GET (list)
  [id]/
    route.ts                      GET (detail+counters)
    pause/route.ts                POST
    resume/route.ts               POST
    cancel/route.ts               POST
    recipients/route.ts           GET (cursor pagination, filter by status)
templates/
  route.ts                        POST, GET
  [id]/route.ts                   GET, PATCH, DELETE
  [id]/submit/route.ts            POST submit to Meta
  media/upload/route.ts           POST signed-URL handoff
audiences/
  preview/route.ts                POST (count + 5 sample contacts for filter)
consent/
  route.ts                        GET (search opt-ins/outs)
  exports/opt-out.csv/route.ts    GET (streamed CSV for compliance audit)
tenants/
  onboard/route.ts                POST (Embedded Signup callback handler)
jobs/
  materialise-audience/route.ts
  send-campaign-batch/route.ts
  submit-template-to-meta/route.ts
  poll-template-status/route.ts
```

Every `jobs/*` route follows the existing pattern in `src/app/api/jobs/process-message/route.ts:47-87` — QStash signature verify, idempotency check, on error return 500 to trigger retry, final attempt captures to Sentry.

### 6.2 MODIFIED files

| File | Change |
|---|---|
| `src/core/clients/whatsapp.ts` | Add `sendTemplate(to, template, {phoneNumberId})` |
| `src/app/api/webhook/route.ts` | Insert `tryHandleOptOut()` short-circuit before `processWebhookPayload` |
| `src/core/messaging/processor.ts` | Defensive STOP double-check (cheap; protects against future regression) |
| `src/core/messaging/messages.ts` | `insertOutboundPending` accepts optional `campaignId`; allow null `conversationId` |
| `src/core/tenants/types.ts` | Add `qualityRating`, `currentTier`, `monthlyMarketingBudgetCents`, `wabaId`, `displayName`, `tenantSlug` |
| `src/segments/salon/config.ts` | Optional `campaigns?: { senderPhoneNumberId?, optOutKeyword?, businessHours? }` |

### 6.3 REUSED primitives (do not duplicate)

| Need | Existing primitive | Path |
|---|---|---|
| Meta API POST | `postMessage()` | `src/core/clients/whatsapp.ts:35-49` |
| QStash publish | `qstashClient().publishJSON()` | `src/core/clients/qstash.ts:27-38` |
| QStash worker pattern | inbound job route | `src/app/api/jobs/process-message/route.ts:47-87` |
| Per-recipient rate limit | `checkAndIncrement(tenantId, recipient)` | `src/core/messaging/rate-limit.ts:23-69` |
| Tenant-scoped DB client | `tenantClient()` | `src/core/clients/supabase.ts` |
| Idempotent outbound | `insertOutboundPending` + `markOutboundSent` | `src/core/messaging/messages.ts:63-122` |
| Delivery status fan-in | `applyDeliveryStatus` | `src/core/messaging/messages.ts:157-179` |
| Sentry capture | final-attempt block | `process-message/route.ts:73-82` |
| Logger | `logger` | `src/core/logger.ts` |
| Audit logs | `audit_logs` table | `0005_resilience.sql` |

---

## 7. Frontend dashboard — `apps/web-app`

Today this is a skeleton. Build out:

### 7.1 Foundation

| File | Purpose |
|---|---|
| `lib/supabase.ts` | Supabase client (browser + server) with auth |
| `lib/api.ts` | Typed fetch wrapper for automation service REST endpoints |
| `lib/realtime.ts` | Subscribe to `campaigns` + `campaign_recipients` Realtime channels |
| `lib/meta-signup.ts` | Meta Embedded Signup SDK loader (implementation deferred per §1) |
| `middleware.ts` | Auth gate for `/app/(authed)/*` |

### 7.2 Pages

```
app/
  (auth)/
    login/page.tsx
    callback/page.tsx
  (authed)/
    layout.tsx                     sidebar + topbar + auth check
    dashboard/page.tsx             summary cards (sends this month, opt-out rate, quality)
    setup/page.tsx                 Embedded Signup connect + setup checklist
    campaigns/
      page.tsx                     list with status filters
      new/page.tsx                 wizard: template → audience → vars → preview → schedule
      [id]/
        page.tsx                   live counters + chart
        recipients/page.tsx        paginated failed/skipped drill-down
    templates/
      page.tsx                     list + approval pill
      new/page.tsx                 editor (body, header media, footer, buttons)
      [id]/page.tsx                detail + resubmit
    audiences/
      page.tsx                     saved filters
    contacts/
      page.tsx                     users browser
      [id]/page.tsx                contact detail + consent history
    settings/
      quality/page.tsx             tier, quality rating
      billing/page.tsx             cost ledger, budget cap
      team/page.tsx                members + roles

# Public, tenant-branded opt-in page (no auth)
app/(public)/optin/[tenant_slug]/page.tsx
```

### 7.3 Template editor UX

The editor renders a live WhatsApp-style preview as the tenant types. Supports:
- Body with `{{1}}` chip insertion + example values
- Header type picker (NONE / TEXT / IMAGE / VIDEO / DOCUMENT)
- Media upload to Supabase Storage with size/MIME validation per Meta's rules
- Footer with auto-injection of "Reply STOP to unsubscribe" for MARKETING
- Buttons (URL or quick reply)
- Submit-to-Meta button → polls status, displays approved/rejected pill

### 7.4 Campaign wizard

Step-by-step with **dry-run preview on 3 sample recipients** before confirm, and a **cost estimate** that breaks down by recipient region (the competitive edge from §15).

### 7.5 Shared package usage

- `packages/ui`: existing `Card`, `Button`, `LayoutWrapper` — reuse
- `packages/utils`: extend with `formatCurrency`, `formatE164`, `humanizeMetaErrorCode`

---

## 8. Webhook handling

The existing `/api/webhook` handles inbound messages today. MVP extends it for three new event types Meta sends.

| Event | Field | Handler | Action |
|---|---|---|---|
| Inbound user message | `messages` | `tryHandleOptOut()` → existing `processWebhookPayload` | STOP short-circuit or normal AI flow |
| Outbound delivery status | `statuses` | existing `applyDeliveryStatus` | Patch `messages` row; trigger mirrors to `campaign_recipients` |
| Quality rating update | `account_update.event=quality_rating_update` | NEW: `handleQualityUpdate()` | Update `tenants.current_quality_rating`; if RED, pause all in-flight campaigns with `pause_reason='quality_red'` |
| Template status update | `message_template_status_update` | NEW: `handleTemplateStatusUpdate()` | Update `templates.status`, surface to dashboard |

Each new handler is just a new branch in the existing switch statement in `/api/webhook/route.ts`.

---

## 9. Observability

| Signal | Mechanism | Action |
|---|---|---|
| Meta send failure rate per tenant | Sentry counter tagged `{tenant_id, error_code}` | Alert > 5% over 10 min |
| QStash retry depth on send-batch | `upstash-retried` header → Sentry tag | Alert on 3+ retries |
| Campaign stuck in `materialising` > 30 min | Scheduled query | Auto-fail + tenant notification |
| Quality rating drops to RED | `account_update` webhook | Auto-pause campaigns + alert tenant |
| Per-tenant monthly spend over budget | Pre-send validate check | Block new sends, surface in dashboard |
| Counter drift `campaigns.*_count` vs `campaign_recipients` | Nightly `pg_cron` recount | Auto-correct + log |

Existing Sentry integration (`captureException` across the codebase) gets the new tags. No new infra.

---

## 10. Security

| Area | Approach |
|---|---|
| Tenant isolation | RLS policies on every new table (same JWT claim pattern) |
| Cross-tenant test | Extend `scripts/test-tenant-isolation.ts` for new tables |
| Media uploads | Supabase Storage with per-tenant prefix; presigned URLs; max size enforced |
| PII in `consent_events.source_payload` | Encrypted at rest (Supabase default); explicit redaction in logs |
| Tenant access_token | Encrypted at rest in `tenants.encrypted_meta_token` (pgcrypto) |
| Admin actions | Existing `audit_logs` gains new actions: `campaign_paused`, `template_submitted`, `consent_bulk_imported`, `tenant_onboarded` |
| Webhook signatures | Existing Meta + QStash signature verification |
| Frontend auth | Supabase Auth; JWT carries `tenant_id` claim |

---

## 11. Verification

| # | Test | Pass criteria |
|---|---|---|
| V1 | Migration applies cleanly | All RLS policies present; existing tests still pass |
| V2 | RLS isolation | Tenant A's JWT cannot SELECT tenant B's campaigns / recipients / consent / templates |
| V3 | `sendTemplate()` payload | Matches Meta Cloud API contract exactly (messaging_product, type:'template', template.{name,language.code,components}) |
| V4 | Opt-out e2e | Send "STOP" inbound → `consent_events` row, `users.opted_out_at` set, ack sent, future campaign skips with `skip_reason='opted_out'` |
| V5 | Multi-language opt-out | "PARAR", "BERHENTI", "रोको" all trigger opt-out |
| V6 | Campaign happy path | 10-recipient campaign with 2 opted-out + 1 US-number → 7 sent, 3 skipped with correct reasons; webhooks → counters update |
| V7 | Frequency cap | 3 marketing campaigns to same recipient in 24h → third skipped with `frequency_cap` |
| V8 | Throughput | 5k recipients, batch=100 → completes ~8 min, no 130429 errors |
| V9 | Quality auto-pause | Simulate `quality_rating_update='RED'` → in-flight campaign → `paused`, `pause_reason='quality_red'` |
| V10 | Idempotency | Re-fire same QStash job → no duplicate sends (verified via `wa_message_id` UNIQUE) |
| V11 | Dashboard live updates | Open campaign detail → Realtime updates `delivered_count` without refresh |
| V12 | Cost accuracy | Sum `actual_cost_cents` matches Meta invoice ±1¢ for a 100-message controlled test |
| V13 | Audit trail | Pause/resume/cancel/template-submit all create `audit_logs` rows |
| V14 | Opt-in page e2e | Submit valid → user row + consent_events row with full audit payload; invalid phone → 400 |
| V15 | Embedded Signup callback | Mocked Meta callback → tenants row populated with phone_number_id, waba_id, encrypted access_token |

---

## 12. Phasing

### Phase 0 — Foundation (~1 week, blocks everything)

0a. Migration `0006_campaigns.sql` (tables, RLS, indexes, triggers)
0b. Opt-in page at `optin.wapi.com/t/{tenant_slug}` + `POST /api/optin/[tenant_slug]`
0c. STOP / opt-out handler in `/api/webhook` (multi-language)
0d. Embedded Signup integration (details deferred — see §1)
0e. Extend `scripts/test-tenant-isolation.ts` for new tables

### Phase 1 — Core campaign (2–3 weeks)

1. `sendTemplate()` in `whatsapp.ts`
2. Template editor UI (self-serve, full media) + media upload pipeline
3. Meta template submission API + status polling
4. `materialiseAudience` + `sendBatch` QStash workers
5. REST API: campaigns, templates, audiences, consent
6. Campaign wizard + live counters dashboard
7. Cost estimate UI with regional breakdown
8. Per-tenant spend cap enforcement
9. Quality auto-pause on RED webhook

### Phase 2 — Polish & operability (~2 weeks)

10. CSV upload + column mapping
11. Tier visibility in settings
12. Recurring campaigns (cron scheduler)
13. Bulk consent re-import endpoint
14. Tenant onboarding checklist UI
15. Compliance audit export (consent CSV)

### Phase 3 — Scale & differentiation (later)

- A/B variants
- Click tracking with wrapped URLs
- Drip / journey campaigns
- ML send-time optimisation
- Multi-region data residency

---

## 13. Still-open questions

1. **Data residency.** Any EU-based tenants? If yes, commit to a region story now (V3 work) or defer with explicit risk acknowledgement.
2. **Dashboard auth.** Supabase Auth (email magic link) or SSO from day one?
3. **Embedded Signup integration details** — deferred per §1 to a separate session.

---

## Critical files inventory

### New
- `supabase/migrations/0006_*.sql` through `0017_*.sql` (root-level shared schema)
- `src/core/campaigns/{validate,audience,cost,dispatch,opt-out,quotas,pricing}.ts`
- `src/core/campaigns/templates/{submit,media}.ts`
- `src/core/campaigns/billing/reservation.ts`
- `src/app/api/optin/[tenant_slug]/route.ts`
- `src/app/api/campaigns/` (tree per §6.1)
- `src/app/api/templates/` (tree per §6.1)
- `src/app/api/audiences/preview/route.ts`
- `src/app/api/consent/` (tree per §6.1)
- `src/app/api/tenants/onboard/route.ts`
- `src/app/api/jobs/{materialise-audience,send-campaign-batch,submit-template-to-meta,poll-template-status}/route.ts`
- `apps/web-app/lib/{supabase,api,realtime,meta-signup}.ts`
- `apps/web-app/middleware.ts`
- `apps/web-app/app/(auth)/...`, `(authed)/...`, `(public)/optin/[tenant_slug]/page.tsx`
- `services/backend/service_automation/saloon_automation/docs/meta-whatsapp-rules.md` (already created)

### Modified
- `src/core/clients/whatsapp.ts` — `sendTemplate()` + tenant `phoneNumberId`
- `src/app/api/webhook/route.ts` — opt-out short-circuit + quality_rating + template_status handlers
- `src/core/messaging/processor.ts` — defensive STOP double-check
- `src/core/messaging/messages.ts` — accept `campaignId`, allow null `conversationId`
- `src/segments/salon/config.ts` — optional `campaigns` block
- `src/core/tenants/types.ts` — quality, tier, budget, waba, slug, display_name fields

---

# Appendix A — Meta WhatsApp Rules Cheat Sheet

> A canonical version of this also lives at `services/backend/service_automation/saloon_automation/docs/meta-whatsapp-rules.md`.

### Mental model in one paragraph

WhatsApp Business is opt-in only. When a user messages you, a 24-hour free-text window opens. Outside that window you can only send pre-approved template messages in one of four categories. Marketing templates cost money per send, are capped at ~2 per user per 24h globally, must include an opt-out line, and cannot be sent to US numbers. You must honor STOP/UNSUBSCRIBE immediately, in the user's language. Your quality rating (Green/Yellow/Red) determines whether you scale up or get suspended.

### 7 hard rules

1. No message without opt-in. Keep timestamp + source as proof.
2. Outside the 24h window → templates only.
3. Marketing capped at ~2/user/24h globally (Meta error 131049).
4. STOP must be honored immediately, in the user's language.
5. No marketing to US (+1) numbers (suspended Apr 2025).
6. No category misclassification.
7. No sudden volume spikes from a new number — warm up gradually.

### Template categories

| Category | Use | Cost | Notes |
|---|---|---|---|
| MARKETING | Promos, offers | $$$ | Needs STOP footer |
| UTILITY | Order updates | $ | Has volume discount |
| AUTHENTICATION | OTPs | $ | Specific format |
| SERVICE | Reply within 24h | **₹0** | Not pre-approved |

### Opt-out keywords

| Language | Keywords |
|---|---|
| English | STOP, UNSUBSCRIBE, CANCEL, QUIT, END, REMOVE, OPT OUT |
| Spanish/Portuguese | PARAR, CANCELAR |
| Hindi | रोको, बंद |
| Tamil | நிறுத்து |
| Indonesian | BERHENTI |
| Arabic | إيقاف |
| Chinese | 取消, 退订 |

### Critical Meta error codes

| Code | Meaning | What to do |
|---|---|---|
| 131049 | Frequency cap hit | Skip with `skip_reason='frequency_cap'`; bump quota |
| 130429 | Rate limit exceeded | Backoff + exponential retry |
| 131026 | Not on WhatsApp | Skip with `skip_reason='invalid_wa_id'`; no retry |
| 131047 | Re-engagement window expired | Use a template instead |
| 132001 | Template doesn't exist / not approved | Pause campaign + alert tenant |
| 132012 | Template parameter mismatch | Fix variable mapping |

### Quality rating + tier ladder

```
Quality:  GREEN → YELLOW → RED → (suspension)
Tier:     1K → 10K → 100K → UNLIMITED
```

### Per-region marketing pricing (current)

| Region | Per delivered marketing msg |
|---|---|
| India | ~₹1.20 ($0.014) |
| Brazil, Mexico, Argentina | $0.04–0.08 |
| Southeast Asia | $0.03–0.06 |
| Europe (DE, FR, UK) | $0.15–0.22 |
| US (+1) | **Suspended** |

### Bookmark these (official Meta docs)

- https://www.whatsapp.com/legal/business-policy
- https://developers.facebook.com/docs/whatsapp/cloud-api
- https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing
- https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview
- https://developers.facebook.com/docs/whatsapp/overview/getting-opt-in
- https://developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits
- https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/components
- https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
- https://developers.facebook.com/docs/whatsapp/embedded-signup
- https://developers.facebook.com/docs/whatsapp/business-platform/changelog

---

# Appendix B — V2/V3 roadmap (NOT MVP scope)

| Stage | Volume | Bottleneck | Action |
|---|---|---|---|
| MVP | 100s tenants, <10k recipients per campaign | n/a | Ship as designed |
| Year 1-2 | 1k tenants, low millions msgs/month | `user_marketing_quotas` row contention; dashboard reads | Move quotas to Upstash Redis (`INCR` + 24h TTL). Add Supabase read replica. |
| Year 3-5 | 10k tenants, billions of recipients lifetime | `campaign_recipients` size | Partition `campaign_recipients` by `HASH(campaign_id)` × 32. Cold-archive old campaigns to R2. |
| Year 5+ | Multi-region | EU residency, Meta latency | Regional Vercel deployments. Per-tenant `data_residency`. Dedicated WABAs per tenant. |

**Decisions made at MVP that future-proof scale:**
1. `tenant_id` on every row → no join to discover tenancy.
2. `wa_message_id UNIQUE` → universal join key.
3. All writes QStash-backed → throughput lever is worker concurrency.
4. No `OFFSET` pagination anywhere → cursor only.
5. Money as integer cents → no floats.
6. `tryReserveMarketingSlot(waId)` is abstract → swap Postgres → Redis without API change.
7. `sendTemplate(to, template, {phoneNumberId})` already accepts per-tenant number.

---

# Appendix C — Competitor positioning

| Competitor | Strength | Our angle |
|---|---|---|
| AiSensy | Easy CSV upload, simple wizard | Match wizard; **win** with cost estimate, dry-run preview, TZ-aware sends |
| Wati | Strong template library, good integrations | Match templates; **win** with auto-pause on quality drop |
| Interakt | Good analytics, segment builder | Match analytics; **win** with per-recipient Meta-error timeline |
| DoubleTick | Polished UI, fast onboarding | Match UI quality; **win** with compliance audit export |
| Gallabox | Multi-channel, automation flows | Defer multi-channel; **win** on Claude-powered conversational follow-up — leads from broadcasts convert into AI conversations seamlessly |

The structural advantage we already have: **a sophisticated 1:1 AI conversation engine.** Broadcasts that drop into that engine for follow-up is a differentiator competitors can't easily copy.
