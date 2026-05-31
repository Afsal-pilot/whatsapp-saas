# Meta Cloud API Onboarding — Prerequisites & Flow

> **Audience:** WAPI engineering + business owners onboarding to the platform.
> **Purpose:** Document every prerequisite needed (on both sides) before a tenant can connect their WhatsApp number to WAPI, and walk through the exact login flow with a worked example.
> **Companion docs:** [`meta-whatsapp-rules.md`](./meta-whatsapp-rules.md), [`campaign-mvp-design.md`](./campaign-mvp-design.md).

---

## 0. Two sides, two prerequisite lists

WhatsApp Cloud API onboarding involves **three parties**:

| Party | Who | Their work |
|---|---|---|
| **Platform** | WAPI (us) | One-time Meta-side setup so the platform can host tenants |
| **Tenant** | The business (e.g., Glow Hair Studio) | Has a Facebook account + a phone number for WhatsApp |
| **End user** | The customer (e.g., Priya) | Nothing here — they're only involved later, at opt-in time |

A tenant **cannot connect** unless the platform has completed its prerequisites. This document covers both.

---

## 1. WAPI prerequisites (one-time, blocks all tenant onboarding)

These items must be done by the WAPI team before the first real tenant can sign up. Most are quick clicks; one — App Review — takes weeks.

### Required items

| # | Item | What it is | Cost | Time |
|---|---|---|---|---|
| 1 | **Meta Developer Account** | Sign up at developers.facebook.com with a Facebook login. | Free | 5 min |
| 2 | **Meta App** | Create a new App in App Dashboard, type "Business". | Free | 10 min |
| 3 | **Add WhatsApp product** to the app | In App Dashboard → "Add Product" → WhatsApp. | Free | 2 min |
| 4 | **System User access token** | In Business Settings, create a system user; generate a long-lived token. Used for WAPI-side admin operations. | Free | 5 min |
| 5 | **App secret + App ID** | Auto-issued; needed for OAuth code → token exchange. | Free | — |
| 6 | **Privacy Policy + Terms of Service URLs** | Public URLs required to publish the app. Must be linked from `wapi.com`. | Free | Depends on your team |
| 7 | **App Review** for WhatsApp permissions: `whatsapp_business_management`, `whatsapp_business_messaging`, `business_management` | Meta reviews how WAPI uses these permissions before allowing the app live. Includes a screencast + use-case description. | Free | **1–4 weeks** |
| 8 | **Tech Provider / Solution Partner registration** | Marks WAPI as a "platform" allowed to manage other businesses' WhatsApp accounts. Apply via Business Settings. | Free | ~1–2 weeks |
| 9 | **Webhook URL configured** | Public HTTPS URL where Meta sends inbound messages and status events. WAPI already has `/api/webhook`. | Free | — |
| 10 | **Webhook verify token** | A random secret string WAPI and Meta both know. Used during the GET handshake. | Free | — |
| 11 | **Embedded Signup configuration** | In App Dashboard, configure the Embedded Signup widget with the WhatsApp permissions, your redirect URL, and a config ID. | Free | 30 min |
| 12 | **App switched from Development → Live mode** | Required to onboard real tenants. Only possible after App Review approval. | Free | After step 7 |

### Total upfront timeline

**2–6 weeks**, dominated by App Review (step 7). The other items can be done in parallel while waiting.

### WAPI's end-product state

After completing the above, you have these env vars to bake into the application:

| Var | What it is | Visibility |
|---|---|---|
| `META_APP_ID` | Public app identifier | Browser-safe |
| `META_APP_SECRET` | Private OAuth secret | Server-only |
| `META_CONFIG_ID` | Embedded Signup config ID | Server-only |
| `META_WEBHOOK_VERIFY_TOKEN` | Webhook handshake secret | Server-only |
| `META_SYSTEM_USER_TOKEN` | For WAPI admin operations | Server-only |
| `META_GRAPH_API_VERSION` | Already exists, e.g. `v21.0` | Server-only |

### Critical sequencing for the project plan

App Review + Tech Provider registration are the longest poles. **Start these BEFORE Phase 0 engineering**, in parallel with code work, so the review timeline finishes when engineering is ready to wire them up. If you wait until code is done, you'll sit idle for a month.

Recommended parallel track:

```
Week 1:  Submit App Review + Tech Provider application
Week 1:  Phase 0 engineering starts (migration, opt-in page, STOP handler)
Week 2-4: Engineering continues; review pending with Meta
Week 4-6: Reviews come back; engineering ready to integrate
```

---

## 2. Tenant prerequisites

For the business owner (Riya / Glow Hair Studio) to be able to connect, she needs:

| # | Item | Notes |
|---|---|---|
| 1 | **Facebook account** | Personal account; used to log into Meta's flow. Hard prerequisite — no Facebook account, no onboarding. |
| 2 | **Meta Business Portfolio** | A "business container" inside Meta. If she doesn't have one, the flow creates it during signup. |
| 3 | **Phone number for WhatsApp** | Must be a number that is either (a) brand new, OR (b) not currently registered on regular WhatsApp, OR (c) one she's willing to delete from regular WhatsApp first. |
| 4 | **Ability to receive OTP** | SMS or voice call on the phone she's registering. |

That's it. No technical knowledge required, no documents at signup.

To unlock higher tiers (TIER_1K → TIER_10K and beyond), she'll later need:

| # | Item | When |
|---|---|---|
| 5 | **Business verification** (incorporation cert, address proof, etc.) | After initial signup; required to graduate from TIER_250 trial tier. Meta reviews in 2–10 business days. |

---

## 3. The flow — worked example with Riya

### Scene

Riya owns Glow Hair Studio, a salon in Mumbai. She just signed up to WAPI and lands on her dashboard.

### T+0: Welcome screen

Riya visits `wapi.com` → signs up with email + password. Supabase Auth creates her `auth.users` row, assigns a `tenant_id` claim in her JWT, redirects to dashboard. She sees an onboarding checklist:

```
Welcome to WAPI, Riya 👋

Setup checklist:
  ☐ Connect WhatsApp                    → [ Connect ]
  ☐ Complete business verification       (after step 1)
  ☐ Create your first template           (after step 1)
  ☐ Build your first audience            (after step 3)
```

She clicks **Connect WhatsApp**.

---

### T+5 sec: Step 1 — Facebook login

A button appears: "Continue with Facebook". She clicks it.

A **popup window** opens, hosted at `facebook.com` (not wapi.com):

```
┌──────────────────────────────────────┐
│   facebook.com                       │
├──────────────────────────────────────┤
│                                      │
│   Log in to Facebook                 │
│                                      │
│   Email: [ riya@gmail.com        ]   │
│   Pass:  [ ●●●●●●●●●●            ]   │
│                                      │
│            [ Log In ]                │
│                                      │
└──────────────────────────────────────┘
```

She enters her Facebook credentials. **WAPI never sees her password** — this is OAuth; Facebook handles auth.

---

### T+15 sec: Step 2 — Permission consent

Once logged in, Facebook shows what WAPI is asking for:

```
┌──────────────────────────────────────────────────┐
│   facebook.com                                   │
├──────────────────────────────────────────────────┤
│                                                  │
│   WAPI is requesting access to:                  │
│                                                  │
│   • Manage your WhatsApp Business Account        │
│   • Send WhatsApp messages on your behalf        │
│   • Receive WhatsApp message delivery info       │
│   • Manage your Business Portfolio               │
│                                                  │
│   You can revoke these anytime in                │
│   Business Settings.                             │
│                                                  │
│         [ Cancel ]    [ Continue ]               │
└──────────────────────────────────────────────────┘
```

She clicks **Continue**.

---

### T+20 sec: Step 3 — Embedded Signup wizard begins

Facebook hands off to Meta's **Embedded Signup** flow (still inside the popup, still on facebook.com).

```
┌─────────────────────────────────────────────────┐
│   Set up WhatsApp Business                      │
├─────────────────────────────────────────────────┤
│   Step 1 of 5: Select Business Portfolio        │
│                                                 │
│   Choose where to add WhatsApp:                 │
│   ( ) Glow Hair Studio (existing portfolio)     │
│   (•) Create new: [ Glow Hair Studio Pvt Ltd ]  │
│                                                 │
│              [ Continue ]                       │
└─────────────────────────────────────────────────┘
```

She picks one (or creates a new portfolio).

---

### T+30 sec: Step 4 — Create/select WhatsApp Business Account (WABA)

```
┌─────────────────────────────────────────────────┐
│   Step 2 of 5: WhatsApp Business Account        │
│                                                 │
│   ( ) Use existing WABA                         │
│   (•) Create new WABA                           │
│                                                 │
│   Business name:                                │
│   [ Glow Hair Studio                       ]    │
│                                                 │
│   Industry:                                     │
│   [ Beauty & Wellness ▼ ]                       │
│                                                 │
│   Description:                                  │
│   [ Modern hair salon in Mumbai            ]    │
│                                                 │
│              [ Continue ]                       │
└─────────────────────────────────────────────────┘
```

---

### T+45 sec: Step 5 — Add and verify phone number

```
┌─────────────────────────────────────────────────┐
│   Step 3 of 5: Add Phone Number                 │
│                                                 │
│   This must be a number NOT currently used      │
│   on regular WhatsApp.                          │
│                                                 │
│   Country: [ +91 India ▼ ]                      │
│   Number:  [ 98765 43210 ]                      │
│                                                 │
│   How should we send the verification code?     │
│   (•) SMS                                       │
│   ( ) Voice call                                │
│                                                 │
│              [ Send Code ]                      │
└─────────────────────────────────────────────────┘
```

She receives an OTP on her phone.

```
┌─────────────────────────────────────────────────┐
│   Enter the 6-digit code                        │
│                                                 │
│      [ _ ] [ _ ] [ _ ] [ _ ] [ _ ] [ _ ]        │
│                                                 │
│              [ Verify ]                         │
└─────────────────────────────────────────────────┘
```

She enters it → **the number is now registered on the Cloud API.**

---

### T+90 sec: Step 6 — Display name

```
┌─────────────────────────────────────────────────┐
│   Step 4 of 5: Display Name                     │
│                                                 │
│   This is what customers will see in their      │
│   WhatsApp chats.                               │
│                                                 │
│   Display name:                                 │
│   [ Glow Hair Studio                       ]    │
│                                                 │
│   ⓘ Must match your business name. Meta will    │
│     review and approve within 2 hours.          │
│                                                 │
│              [ Continue ]                       │
└─────────────────────────────────────────────────┘
```

---

### T+120 sec: Step 7 — Review & finish

```
┌─────────────────────────────────────────────────┐
│   Step 5 of 5: Review                           │
│                                                 │
│   Business: Glow Hair Studio Pvt Ltd            │
│   WABA:     Glow Hair Studio                    │
│   Phone:    +91 98765 43210 (verified ✓)        │
│   Display:  Glow Hair Studio (pending review)   │
│                                                 │
│   By finishing, you authorize WAPI to send      │
│   WhatsApp messages on behalf of this WABA.     │
│                                                 │
│              [ Finish ]                         │
└─────────────────────────────────────────────────┘
```

She clicks **Finish**. The popup closes.

---

### T+125 sec: Behind the scenes — what WAPI receives

Meta calls a JavaScript callback in WAPI's onboarding page with:

```json
{
  "phone_number_id": "123456789012345",
  "waba_id": "987654321098765",
  "business_id": "555111222333444",
  "code": "AQDxYz...sessionAuthCode..."
}
```

WAPI's backend then makes a **server-to-server call** to Meta to exchange the `code` for a long-lived access token:

```http
POST https://graph.facebook.com/v21.0/oauth/access_token
  ?client_id={META_APP_ID}
  &client_secret={META_APP_SECRET}
  &code={code_from_callback}
```

Meta responds:

```json
{
  "access_token": "EAAB...long-token-here",
  "token_type": "bearer"
}
```

WAPI's backend writes to the database:

```sql
UPDATE tenants
SET
  waba_id = '987654321098765',
  phone_number_id = '123456789012345',
  encrypted_meta_token = encrypt('EAAB...'),
  display_name = 'Glow Hair Studio',
  tenant_slug = 'glow-hair-studio',
  current_tier = 'TIER_250',
  current_quality_rating = NULL
WHERE id = 'riya-tenant-uuid';
```

Then WAPI subscribes the WABA to our webhook URL:

```http
POST https://graph.facebook.com/v21.0/{waba_id}/subscribed_apps
Authorization: Bearer EAAB...

→ Meta returns:
{ "success": true }
```

Now Meta will deliver inbound messages and status webhooks to `/api/webhook` for Glow Hair Studio.

---

### T+130 sec: Riya sees success

The dashboard refreshes:

```
✓ WhatsApp connected
  Phone:        +91 98765 43210
  Display name: Glow Hair Studio (review pending)
  Tier:         TIER_250 (trial)

Next: complete business verification to unlock TIER_1K
[ Start Verification ]
```

**Total time elapsed: ~2-5 minutes.**

---

## 4. End-to-end sequence diagram

```
Riya            wapi.com           facebook.com          WAPI backend         Database
  │                │                    │                      │                 │
  │ Sign up        │                    │                      │                 │
  │───────────────►│                    │                      │                 │
  │                │ Create tenant      │                      │                 │
  │                │───────────────────────────────────────────│────────────────►│
  │                │                    │                      │                 │
  │ Click          │                    │                      │                 │
  │ Connect WA     │                    │                      │                 │
  │───────────────►│                    │                      │                 │
  │                │ Open popup         │                      │                 │
  │                │───────────────────►│                      │                 │
  │ Log in to FB   │                    │                      │                 │
  │───────────────────────────────────►│                      │                 │
  │ Approve perms  │                    │                      │                 │
  │───────────────────────────────────►│                      │                 │
  │ Pick portfolio │                    │                      │                 │
  │───────────────────────────────────►│                      │                 │
  │ Add phone +    │                    │                      │                 │
  │ verify OTP     │                    │                      │                 │
  │───────────────────────────────────►│                      │                 │
  │ Set display    │                    │                      │                 │
  │ name           │                    │                      │                 │
  │───────────────────────────────────►│                      │                 │
  │ Click Finish   │                    │                      │                 │
  │───────────────────────────────────►│                      │                 │
  │                │ JS callback:       │                      │                 │
  │                │ {code, ids}        │                      │                 │
  │                │◄───────────────────│                      │                 │
  │                │ POST /onboard      │                      │                 │
  │                │───────────────────────────────────────────►                 │
  │                │                    │ exchange code        │                 │
  │                │                    │◄─────────────────────│                 │
  │                │                    │ access_token         │                 │
  │                │                    │─────────────────────►│                 │
  │                │                    │                      │ save tenant     │
  │                │                    │                      │────────────────►│
  │                │                    │ subscribe webhook    │                 │
  │                │                    │◄─────────────────────│                 │
  │                │ ✓ Connected        │                      │                 │
  │                │◄───────────────────────────────────────────│                 │
  │ Dashboard      │                    │                      │                 │
  │ shows success  │                    │                      │                 │
  │◄───────────────│                    │                      │                 │
```

---

## 5. FAQ

| Question | Answer |
|---|---|
| Does WAPI see Riya's Facebook password? | **No.** OAuth means Facebook handles auth; WAPI only ever sees the resulting code/token. |
| Can Riya revoke WAPI's access later? | **Yes.** She goes to facebook.com → Business Settings → Integrations → Remove WAPI. We get notified via webhook and mark her tenant disconnected. |
| Does the access token expire? | **No** (when set up correctly as a system-user-style token). Meta hands out long-lived tokens specifically for BSP platforms. |
| What if she doesn't have a Facebook account? | She must create one. Facebook account is a hard prerequisite — there is no alternative. |
| What if she doesn't have a Business Portfolio? | The flow creates one for her in step 4. |
| What if her phone number is already on regular WhatsApp? | She must first delete that account (in WhatsApp app: Settings → Account → Delete) before registering on Cloud API. Or use a different number. |
| What if the OTP doesn't arrive? | Meta lets her retry; can also use voice call instead of SMS. |
| Can multiple WAPI staff onboard the same Riya? | No — one Facebook account = one onboarding session. Riya can later add other users to her Business Portfolio inside Meta. |
| Does Meta charge WAPI anything for onboarding? | **No.** Onboarding, WABA creation, phone registration, display-name approval, business verification — all free. Only outbound messages cost. |
| What tier does she start at? | `TIER_250` (250 unique customers / 24h) for unverified businesses. Need business verification to graduate to `TIER_1K`. |

---

## 6. Common failure modes

| Failure | Cause | Recovery |
|---|---|---|
| "Permission denied" during OAuth | App Review not approved or app still in Development mode | Complete App Review; switch to Live |
| "Number already registered" | Phone is on regular WhatsApp | Delete from WhatsApp app first, then retry |
| Display name rejected | Doesn't match business identity | Resubmit with corrected name |
| No OTP received | SMS routing issue, esp. in some countries | Use voice call option; retry |
| Token exchange fails | Wrong APP_SECRET or expired code | Server logs will show 400 from Meta; restart flow |
| Webhook subscription fails | WAPI's webhook URL not verified with Meta | Re-verify webhook URL in App Dashboard |
| Tenant later says "I see WAPI in my Facebook integrations" | Normal — that's how she'd revoke access | No action; this is expected |

---

## 7. References

- [Embedded Signup overview](https://developers.facebook.com/docs/whatsapp/embedded-signup)
- [Embedded Signup implementation guide](https://developers.facebook.com/docs/whatsapp/embedded-signup/implementation)
- [Solution Provider / Tech Provider overview](https://developers.facebook.com/docs/whatsapp/solution-providers/overview)
- [App Review for WhatsApp permissions](https://developers.facebook.com/docs/whatsapp/cloud-api/get-started/app-review)
- [Meta Developer App Dashboard](https://developers.facebook.com/apps)
- [Business Settings / Tech Provider registration](https://business.facebook.com/settings)
