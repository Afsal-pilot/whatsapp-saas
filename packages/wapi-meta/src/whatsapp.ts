/**
 * WhatsApp Cloud API client — shared across every WAPI service.
 *
 * Caller is responsible for loading these env vars into process.env before
 * importing this module:
 *
 *   META_PHONE_NUMBER_ID       — default sender phone (used unless overridden)
 *   META_ACCESS_TOKEN          — default access token (used unless overridden)
 *   META_GRAPH_API_VERSION     — optional, defaults to 'v21.0'
 *
 * Per-tenant routing: pass `{ phoneNumberId, accessToken }` in the `opts`
 * argument to override the defaults — this is how Embedded Signup tenants
 * send from their own number using their own token.
 *
 * Surface:
 *   sendText      — plain text
 *   sendTemplate  — Meta-approved template (the ONLY way to message outside
 *                   the 24h customer service window)
 *   sendButtons   — 1–3 reply buttons (interactive button)
 *   sendList      — sectioned list, up to 10 rows (interactive list)
 *   markRead      — read receipt + optional typing indicator
 *
 * All send helpers return `{ wa_message_id }`; use it as the idempotency key
 * when persisting outbound rows.
 */
import type {
  ButtonsPayload,
  ListPayload,
  SendOpts,
  SendResult,
  TemplateMessage,
} from "./types";

const GRAPH_BASE = "https://graph.facebook.com";

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(
      `@whatsapp-saas/wapi-meta: missing env ${key}. Load it before importing this module.`,
    );
  }
  return value;
}

function apiVersion(): string {
  return process.env.META_GRAPH_API_VERSION ?? "v21.0";
}

function resolvePhoneNumberId(opts?: SendOpts): string {
  return opts?.phoneNumberId ?? requireEnv("META_PHONE_NUMBER_ID");
}

function resolveAccessToken(opts?: SendOpts): string {
  return opts?.accessToken ?? requireEnv("META_ACCESS_TOKEN");
}

function messagesUrl(opts?: SendOpts): string {
  return `${GRAPH_BASE}/${apiVersion()}/${resolvePhoneNumberId(opts)}/messages`;
}

function authHeaders(opts?: SendOpts): Record<string, string> {
  return {
    Authorization: `Bearer ${resolveAccessToken(opts)}`,
    "Content-Type": "application/json",
  };
}

async function postMessage(
  body: Record<string, unknown>,
  action: string,
  opts?: SendOpts,
): Promise<SendResult> {
  const res = await fetch(messagesUrl(opts), {
    method: "POST",
    headers: authHeaders(opts),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    console.error(
      `[wapi-meta] whatsapp_send_failed action=${action} status=${res.status} request_id=${opts?.requestId ?? "-"} body=${errText}`,
    );
    throw new Error(`WhatsApp ${action} failed (${res.status}): ${errText}`);
  }
  const data = (await res.json()) as { messages?: Array<{ id?: string }> };
  const id = data.messages?.[0]?.id;
  if (!id) throw new Error(`WhatsApp ${action}: no message id returned`);
  return { wa_message_id: id };
}

// ─── text ───────────────────────────────────────────────────────────────────

export async function sendText(
  to: string,
  body: string,
  opts?: SendOpts,
): Promise<SendResult> {
  return postMessage(
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { preview_url: false, body },
    },
    "send_text",
    opts,
  );
}

// ─── template (Meta-approved; the only way outside the 24h window) ──────────

export async function sendTemplate(
  to: string,
  template: TemplateMessage,
  opts?: SendOpts,
): Promise<SendResult> {
  return postMessage(
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "template",
      template,
    },
    "send_template",
    opts,
  );
}

// ─── interactive: buttons ───────────────────────────────────────────────────

export async function sendButtons(
  to: string,
  p: ButtonsPayload,
  opts?: SendOpts,
): Promise<SendResult> {
  if (p.buttons.length === 0 || p.buttons.length > 3) {
    throw new Error(`sendButtons: buttons must be 1–3, got ${p.buttons.length}`);
  }
  const interactive: Record<string, unknown> = {
    type: "button",
    body: { text: p.body },
    action: {
      buttons: p.buttons.map((b) => ({
        type: "reply",
        reply: { id: b.id, title: b.title },
      })),
    },
  };
  if (p.header) interactive.header = { type: "text", text: p.header };
  if (p.footer) interactive.footer = { text: p.footer };

  return postMessage(
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive,
    },
    "send_buttons",
    opts,
  );
}

// ─── interactive: list ──────────────────────────────────────────────────────

export async function sendList(
  to: string,
  p: ListPayload,
  opts?: SendOpts,
): Promise<SendResult> {
  const totalRows = p.sections.reduce((n, s) => n + s.rows.length, 0);
  if (totalRows === 0 || totalRows > 10) {
    throw new Error(`sendList: total rows must be 1–10, got ${totalRows}`);
  }
  const interactive: Record<string, unknown> = {
    type: "list",
    body: { text: p.body },
    action: {
      button: p.buttonText,
      sections: p.sections.map((s) => ({
        ...(s.title ? { title: s.title } : {}),
        rows: s.rows.map((r) => ({
          id: r.id,
          title: r.title,
          ...(r.description ? { description: r.description } : {}),
        })),
      })),
    },
  };
  if (p.header) interactive.header = { type: "text", text: p.header };
  if (p.footer) interactive.footer = { text: p.footer };

  return postMessage(
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive,
    },
    "send_list",
    opts,
  );
}

// ─── read receipts + typing indicator ───────────────────────────────────────

/**
 * Mark an inbound message as read (blue ticks for the customer) and
 * optionally show the typing indicator while we generate a reply.
 *
 * Meta combines both into a single API call. The typing indicator hides
 * automatically when we send the outbound reply, or after ~25 seconds.
 *
 * Never throws — read receipts and typing dots are nice-to-haves; a failure
 * here must not block the agent reply pipeline. We log and move on.
 */
export async function markRead(
  messageId: string,
  o: { showTyping?: boolean } & SendOpts = {},
): Promise<void> {
  try {
    const body: Record<string, unknown> = {
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
    };
    if (o.showTyping) {
      body.typing_indicator = { type: "text" };
    }

    const res = await fetch(messagesUrl(o), {
      method: "POST",
      headers: authHeaders(o),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.warn(
        `[wapi-meta] whatsapp_mark_read_failed status=${res.status} showTyping=${!!o.showTyping} body=${errText}`,
      );
    }
  } catch (err) {
    console.warn(
      `[wapi-meta] whatsapp_mark_read_threw error=${(err as Error).message}`,
    );
  }
}
