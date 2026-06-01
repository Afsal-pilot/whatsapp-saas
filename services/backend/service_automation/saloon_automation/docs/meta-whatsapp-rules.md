# Meta WhatsApp Business Platform — Rules Cheat Sheet

> Read once, then keep open while you build. Every rule here is enforced by Meta; getting it wrong gets phone numbers banned.

---

## The mental model in one paragraph

WhatsApp Business is **opt-in only**. When a user messages you, a **24-hour free-text window** opens. Outside that window you can **only** send pre-approved **template messages** in one of four categories. **Marketing templates** cost money per send, are capped at **~2 per user per 24h globally**, must include an opt-out line, and **cannot be sent to US numbers** (suspended since April 2025). You **must** honor STOP/UNSUBSCRIBE immediately and in the user's language. Your **quality rating** (Green/Yellow/Red) determines whether you scale up or get suspended.

---

## The 7 hard rules you cannot break

1. **No message without opt-in.** Ever. Keep timestamp + source as proof.
2. **Outside the 24h window → templates only.** Free-form text is blocked.
3. **Marketing templates are capped at ~2 per user per 24h globally** (across all businesses). Excess returns Meta error `131049`.
4. **STOP must be honored immediately** — and in the user's language (PARAR, BERHENTI, रोको, etc.).
5. **No marketing to US (+1) numbers.** Suspended since April 2025. Utility/Auth still work.
6. **No misclassification.** Marketing dressed as Utility gets templates paused and quality rating dropped.
7. **No sudden volume spikes from a new number.** Warm up gradually over a week.

---

## The 24-hour window — when can you send what

```
User messages you
        │
        ▼
┌───── 24-hour window opens (and restarts on every new inbound) ─────┐
│  Inside: send anything — free text, images, voice, buttons         │
│          (Service-category messages here are FREE since Nov 2024)  │
└────────────────────────────────────────────────────────────────────┘
        │
        ▼
Window closed → templates only:
   • MARKETING       → promos, offers          (most expensive, strictest review)
   • UTILITY         → order/appt updates      (cheap)
   • AUTHENTICATION  → OTPs / 2FA              (cheap)
   • SERVICE         → reply within window     (free; can't be used to start a thread)
```

---

## Template categories — what goes where

| Category | Examples | Cost | Review strictness |
|---|---|---|---|
| **MARKETING** | "FLAT 35% OFF", new product launches, reactivation | $$$ (no volume discount) | Strictest. Needs opt-out footer. |
| **UTILITY** | Order confirmed, appointment reminder, delivery tracking | $ (volume discount) | Medium. Must not contain promo content. |
| **AUTHENTICATION** | One-time passcodes, 2FA | $ | Specific OTP template format required. |
| **SERVICE** | Reply within 24h window | **Free** since Nov 2024 | N/A — not pre-approved, just must be a reply. |

---

## Template approval — what makes Meta accept or reject

**Accept**
- Clear, specific purpose ("Your Bare Anatomy order #1234 has shipped")
- Variables `{{1}}`, `{{2}}` with sensible example values at submission
- Opt-out line for marketing ("Reply STOP to unsubscribe")
- Professional tone, normal capitalization

**Reject**
- Vague copy ("Hey! Check this out!")
- ALL CAPS, excessive emoji, multiple exclamation marks
- Misclassified (marketing content submitted as utility)
- Missing opt-out on marketing
- Unsupported media (animated GIFs, oversized files)
- Unverified claims ("Best deal ever!")

Approval time: usually under 24 hours, often under an hour.

---

## Opt-out keywords you MUST recognize

| Language | Keywords |
|---|---|
| English | STOP, UNSUBSCRIBE, CANCEL, QUIT, END, REMOVE, OPT OUT |
| Spanish | PARAR, CANCELAR |
| Portuguese | PARAR, CANCELAR |
| Hindi | रोको, बंद |
| Tamil | நிறுத்து |
| Indonesian | BERHENTI |
| Arabic | إيقاف |
| Chinese | 取消, 退订 |

Pattern: match case-insensitive, whole-message (so "stop sending" qualifies but "I can't stop laughing" doesn't). On match → mark opted-out → stop sending → acknowledge once.

---

## Quality rating & tier ladder

```
Quality:   GREEN ──→ YELLOW ──→ RED ──→ (suspension)
           (good)    (warning)  (capped)
```

```
Tier ladder (unique users you can start convos with per 24h):
   TIER_1K    →  TIER_10K   →   TIER_100K   →   UNLIMITED
   (default)     (after 7d   (after sustained   (high-volume verified)
                  green +      green at 10K)
                  50% use)
```

Quality drops when users:
- Block your business
- Report you as spam
- Don't reply / ignore messages
- Send STOP

Design implication: **auto-pause campaigns when rating drops to Red.**

---

## Frequency cap (the trap)

- Meta limits a user to receive **~2 marketing template messages per 24 hours globally** (across all businesses, not just yours).
- If you try to send a 3rd, Meta silently drops it with error code `131049`.
- Pre-skip recipients likely to be over cap; reconcile from Meta errors after the fact.
- Replying to a user resets the count — users in active conversation aren't affected.

---

## Rate limits (technical, not policy)

| Limit | Default | Upgradeable |
|---|---|---|
| Messages per second per phone number | 80 MPS | Yes, to 1000 MPS |
| API requests per second | 10 RPS | No (separate from MPS) |

Bursting above either → error code `130429` (throttled).

---

## Regional gotchas

- **US (+1):** Marketing templates **suspended** since April 2025. Utility + Auth still work.
- **India:** Strict review; commercial-communication compliance scrutiny.
- **Brazil:** Higher block-rate sensitivity; quality drops faster.
- **EU/EEA:** GDPR applies. Opt-in must be explicit + per-category; DPA required.
- **Pricing varies hugely:** India ~$0.02/marketing msg, Germany ~$0.22.

---

## Webhook events you must handle

| Event | When | What to do |
|---|---|---|
| `sent` | Meta accepted message for delivery | Patch `messages.sent_at` |
| `delivered` | Reached user's device | Patch `messages.delivered_at` + mirror to `campaign_recipients` |
| `read` | User opened the message | Patch `messages.read_at` |
| `failed` | Delivery failed | Patch `failed_at` + `failure_reason`; classify by error code |
| `quality_rating_update` | Meta downgraded/upgraded your number | Update `tenants.current_quality_rating`; auto-pause campaigns if RED |
| `template_status_update` | Template approved/rejected/paused | Update `templates.status` |

---

## Critical error codes (handle explicitly)

| Code | Meaning | What to do |
|---|---|---|
| `131049` | User hit marketing frequency cap | Skip with `skip_reason='frequency_cap'`; bump `user_marketing_quotas` |
| `130429` | API rate limit exceeded | Back off + retry with exponential delay |
| `131026` | Recipient hasn't accepted ToS / not on WhatsApp | Skip with `skip_reason='invalid_wa_id'`; do not retry |
| `131047` | Re-engagement message outside allowed window | Use a template instead |
| `131051` | Unsupported message type | Fix payload |
| `132001` | Template doesn't exist / not approved | Pause campaign + alert tenant |
| `132012` | Template parameter mismatch | Fix variable mapping |

---

## BSP (platform) responsibilities — what's on us

As the platform that lets tenants send messages, **Meta holds us responsible** for:

1. Not allowing tenants to send without opt-in proof.
2. Enforcing per-recipient throttling.
3. Honoring opt-out across all of a tenant's lists.
4. Not letting one tenant's bad behavior poison others' quality ratings (→ separate phone numbers / WABAs per tenant).
5. Storing PII responsibly (DPA, encryption at rest, GDPR compliance for EU tenants).

---

## What gets accounts banned — the short list

- Sending to purchased / scraped contact lists.
- Ignoring opt-outs.
- Repeated template rejections without fixing.
- Sustained Red quality rating.
- Sudden 100x volume spike on a new number.
- Phishing, scams, illegal goods, adult content.

---

## Pre-launch checklist (run through before going live)

- [ ] Opt-in proof captured for every recipient (timestamp + source + business name shown)
- [ ] STOP keyword detection live for English **and** at least the top language of your audience
- [ ] At least one MARKETING template approved with "Reply STOP" footer
- [ ] Webhook URL subscribed and handling `sent / delivered / read / failed`
- [ ] Quality rating webhook handler in place + auto-pause on RED
- [ ] US numbers filtered out of marketing audiences
- [ ] Rate limiter active (≤ 80 MPS per phone number)
- [ ] Frequency-cap pre-check active (≤ 2 marketing msgs / user / 24h)
- [ ] Per-tenant cost ledger + monthly budget cap
- [ ] Tenant onboarding warmup plan (start at 50 messages/day, ramp over a week)

---

## Bookmark these (official Meta docs)

- Business Policy: https://www.whatsapp.com/legal/business-policy
- Commerce Policy: https://www.whatsapp.com/legal/commerce-policy
- Cloud API overview: https://developers.facebook.com/docs/whatsapp/cloud-api
- Message templates: https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates
- Template categorization: https://developers.facebook.com/docs/whatsapp/updates-to-pricing/new-template-guidelines
- Opt-in guidelines: https://developers.facebook.com/docs/whatsapp/overview/getting-opt-in
- Messaging limits & quality rating: https://developers.facebook.com/docs/whatsapp/messaging-limits
- Per-user marketing message limit: https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages#per-user-marketing-template-message-limits
- Pricing (July 2025 changes): https://developers.facebook.com/docs/whatsapp/pricing
- Webhooks reference: https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/components
- Error codes: https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
- Rate limits & throughput: https://developers.facebook.com/docs/whatsapp/cloud-api/overview#rate-limits
- Changelog (check monthly): https://developers.facebook.com/docs/whatsapp/business-platform/changelog
