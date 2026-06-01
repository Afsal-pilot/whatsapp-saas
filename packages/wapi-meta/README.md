# @whatsapp-saas/wapi-meta

Shared WhatsApp Cloud API client for every WAPI service.

The Cloud API is the only sanctioned way to send WhatsApp messages
programmatically. This package wraps it with typed helpers, sensible defaults
(global env vars), and per-tenant overrides (for Embedded Signup tenants who
send from their own number using their own token).

## Surface

| Function | When to use |
|---|---|
| `sendText(to, body, opts?)` | Free-form text — only inside the 24h customer service window |
| `sendTemplate(to, template, opts?)` | Meta-approved template — the **only** way to message outside the 24h window |
| `sendButtons(to, payload, opts?)` | Interactive button reply (1–3 buttons) |
| `sendList(to, payload, opts?)` | Interactive sectioned list (up to 10 rows) |
| `markRead(messageId, opts?)` | Blue ticks + optional typing indicator |

All send helpers return `{ wa_message_id }`. Use it as the idempotency key
when persisting outbound rows.

## Required env vars

Caller is responsible for loading these into `process.env` before importing:

| Var | Purpose |
|---|---|
| `META_PHONE_NUMBER_ID` | Default sender phone number id |
| `META_ACCESS_TOKEN` | Default Cloud API access token |
| `META_GRAPH_API_VERSION` | Optional, defaults to `v21.0` |

## Per-tenant overrides

Pass `opts` to override defaults — used once Embedded Signup tenants exist:

```ts
await sendTemplate(
  "919840675929",
  { name: "summer_promo_2026", language: { code: "en_US" }, components: [...] },
  {
    phoneNumberId: tenant.phone_number_id,        // tenant's WhatsApp number
    accessToken: decrypt(tenant.encrypted_meta_token),  // tenant's token
    requestId: "req_abc",
  },
);
```

## Template payload example

For a body `"Hi {{1}}! Get FLAT {{2}}% off at {{3}}."`:

```ts
await sendTemplate("919840675929", {
  name: "summer_promo_2026",
  language: { code: "en_US" },
  components: [
    {
      type: "body",
      parameters: [
        { type: "text", text: "Priya" },
        { type: "text", text: "35" },
        { type: "text", text: "Glow Hair Studio" },
      ],
    },
  ],
});
```
