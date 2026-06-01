/**
 * Message processor — the core pipeline for one inbound WhatsApp event.
 *
 * Lives outside the route handler so it can be invoked from:
 *   - the QStash worker (production / preview)
 *   - the webhook itself, inline, when running on localhost (dev only)
 *
 * Two payload shapes flow through here:
 *
 *   1. `messages[]` — a customer sent us a message. We resolve tenant, look
 *      up / create the user and open conversation, persist the inbound row,
 *      run the agent, send the reply, persist the outbound row.
 *
 *      Inbound messages may be:
 *        - text:        normal customer message
 *        - interactive: a button_reply / list_reply from a previous send.
 *                       Normalised to text (the displayed title) so the
 *                       agent sees natural language in history; the
 *                       structured {id, type} is preserved in messages.meta.
 *
 *   2. `statuses[]` — Meta is telling us about a previously-sent outbound
 *      message (delivered / read / failed). We patch the matching row's
 *      delivery timestamps.
 *
 * Tenant resolution happens here, not in the webhook intake. Once resolved,
 * every downstream DB call goes through a `TenantClient` so isolation is
 * enforced by construction — see `clients/supabase.ts`.
 */
import { z } from "zod";
import { logger } from "@/core/logger";
import { setContext } from "@/core/context";
import { captureMessage } from "@/core/sentry";
import { tenantClient } from "@whatsapp-saas/wapi-db";
import { markRead, sendButtons, sendList, sendText } from "@whatsapp-saas/wapi-meta";
import { complete } from "@/core/clients/claude";
import { env } from "@/core/config/env";
import {
  getOrCreateActiveConversation,
  upsertUser,
} from "@/core/messaging/conversations";
import {
  applyDeliveryStatus,
  countMessages,
  insertOutboundPending,
  loadHistory,
  markOutboundFailed,
  markOutboundSent,
  outboundAlreadyResolved,
  recordInboundText,
} from "@/core/messaging/messages";
import { loadPersonalisation } from "@/core/messaging/profile";
import { checkAndIncrement } from "@/core/messaging/rate-limit";
import { maybeRefreshSummary } from "@/core/messaging/summary";
import { setEventTenant } from "@/core/messaging/webhook-events";
import {
  assertBudget,
  recordUsage,
  resolveTenant,
  TokenBudgetExceededError,
  UnknownTenantError,
  type Tenant,
} from "@/core/tenants";
import { getSegment } from "@/segments";
import type { InteractiveReply } from "@/segments/types";

// ─── inbound shapes ─────────────────────────────────────────────────────────
const InboundTextMessage = z.object({
  from: z.string(),
  id:   z.string(),
  type: z.literal("text"),
  text: z.object({ body: z.string() }),
});

const InboundInteractiveMessage = z.object({
  from: z.string(),
  id:   z.string(),
  type: z.literal("interactive"),
  interactive: z.union([
    z.object({
      type: z.literal("button_reply"),
      button_reply: z.object({ id: z.string(), title: z.string() }),
    }),
    z.object({
      type: z.literal("list_reply"),
      list_reply: z.object({
        id:          z.string(),
        title:       z.string(),
        description: z.string().optional(),
      }),
    }),
  ]),
});

type NormalizedInbound = {
  from: string;
  id: string;
  text: string;
  interactive?: { type: "button_reply" | "list_reply"; id: string };
};

const Contact = z.object({
  wa_id: z.string(),
  profile: z.object({ name: z.string().optional() }).optional(),
});

const StatusEvent = z.object({
  id: z.string(),
  status: z.enum(["sent", "delivered", "read", "failed"]),
  timestamp: z.string(),
  recipient_id: z.string().optional(),
  errors: z
    .array(z.object({ title: z.string().optional(), message: z.string().optional() }).passthrough())
    .optional(),
});

const WebhookPayload = z.object({
  entry: z.array(
    z.object({
      changes: z.array(
        z.object({
          value: z.object({
            metadata: z
              .object({
                phone_number_id: z.string().optional(),
                display_phone_number: z.string().optional(),
              })
              .optional(),
            messages: z.array(z.unknown()).optional(),
            contacts: z.array(Contact).optional(),
            statuses: z.array(z.unknown()).optional(),
          }),
        }),
      ),
    }),
  ),
});

export async function processWebhookPayload(
  payload: unknown,
  opts: { eventId?: string } = {},
): Promise<void> {
  if (opts.eventId) setContext({ eventId: opts.eventId });

  const parsed = WebhookPayload.safeParse(payload);
  if (!parsed.success) {
    logger.info("webhook_unsupported_shape");
    return;
  }

  const change = parsed.data.entry[0]?.changes[0]?.value;
  if (!change) return;
  const phoneNumberId = change.metadata?.phone_number_id;
  if (!phoneNumberId) {
    logger.warn("webhook_missing_phone_number_id");
    return;
  }

  let tenant: Tenant;
  try {
    tenant = await resolveTenant(phoneNumberId);
  } catch (err) {
    if (err instanceof UnknownTenantError) {
      logger.warn("webhook_unknown_tenant", { phoneNumberId });
      return; // 200 to Meta; no retry will help an unprovisioned number
    }
    throw err;
  }
  setContext({ tenantId: tenant.id });

  const tc = tenantClient(tenant.id);
  if (opts.eventId) await setEventTenant(opts.eventId, tenant.id);

  // ── status callbacks: patch delivery timestamps and return ──────────────
  if (change.statuses && change.statuses.length > 0) {
    for (const raw of change.statuses) {
      const s = StatusEvent.safeParse(raw);
      if (!s.success) {
        logger.info("status_event_skip_shape");
        continue;
      }
      const ts = new Date(Number(s.data.timestamp) * 1000);
      const reason = s.data.errors?.[0]?.message ?? s.data.errors?.[0]?.title;
      try {
        await applyDeliveryStatus(tc, {
          waMessageId: s.data.id,
          status: s.data.status,
          timestamp: Number.isNaN(ts.getTime()) ? new Date() : ts,
          reason,
        });
      } catch (err) {
        logger.warn("status_event_update_failed", {
          waMessageId: s.data.id,
          error: (err as Error).message,
        });
      }
    }
    return;
  }

  // ── inbound message branch ──────────────────────────────────────────────
  const rawMsg = change.messages?.[0];
  if (!rawMsg) return;
  const inbound = normalizeInbound(rawMsg);
  if (!inbound) {
    logger.info("webhook_unsupported_message", { type: (rawMsg as { type?: string }).type });
    return;
  }

  // Idempotency: a QStash retry after the outbound row was written should
  // NOT re-run Claude or re-send. Check before doing anything expensive.
  if (await outboundAlreadyResolved(tc, inbound.id)) {
    logger.info("inbound_already_resolved", { waMessageId: inbound.id });
    return;
  }

  const segment = getSegment(tenant.segment);

  // ── owner inbound short-circuit ─────────────────────────────────────────
  // If this is an interactive tap from the salon owner (Confirm/Reject on a
  // booking card), the segment handles it directly and we skip the agent
  // flow entirely. tryHandleOwnerInbound returns handled=false if the
  // inbound doesn't match its prefix, so this is safe to call for every
  // inbound that came from a known-owner number.
  if (segment.tryHandleOwnerInbound) {
    const ownerResult = await segment.tryHandleOwnerInbound(
      { tc, tenant, now: new Date() },
      inbound,
    );
    if (ownerResult.handled) {
      logger.info("owner_inbound_handled", { from: inbound.from });
      return;
    }
  }

  const contact = change.contacts?.[0];
  const user = await upsertUser(tc, {
    waId: inbound.from,
    name: contact?.profile?.name ?? null,
  });
  const conv = await getOrCreateActiveConversation(tc, user);

  await recordInboundText(tc, {
    conversationId: conv.id,
    waMessageId: inbound.id,
    text: inbound.text,
    ...(inbound.interactive ? { interactive: inbound.interactive } : {}),
  });

  if (conv.status === "human") {
    await markRead(inbound.id);
    return;
  }

  // Budget guard.
  try {
    assertBudget(tenant);
  } catch (err) {
    if (err instanceof TokenBudgetExceededError) {
      logger.warn("tenant_over_budget", { used: err.used, cap: err.cap });
      captureMessage("tenant_over_budget", "warning", { tenantId: err.tenantId, used: err.used, cap: err.cap });
      await markRead(inbound.id);
      return;
    }
    throw err;
  }

  // Outbound rate limit per recipient.
  const rl = await checkAndIncrement(tenant.id, inbound.from);
  if (!rl.allowed) {
    logger.warn("outbound_rate_limited", {
      recipient: inbound.from,
      retryAfterMs: rl.retryAfterMs,
    });
    await markRead(inbound.id);
    return;
  }

  const [history, personalisation] = await Promise.all([
    loadHistory(tc, conv.id),
    loadPersonalisation(tc, user.id),
    markRead(inbound.id, { showTyping: true }),
  ]);

  const segCtx = {
    tenant,
    tc,
    user: {
      id: user.id,
      name: user.name,
      waId: user.wa_id,
      isReturning: personalisation.isReturning,
      lastBookingService: personalisation.lastBookingService,
    },
    conversation: { id: conv.id },
    now: new Date(),
  };

  const summaryPreamble = conv.summary
    ? `Prior conversation summary (older history not shown):\n${conv.summary}\n\n`
    : "";
  const system = summaryPreamble + segment.buildSystemPrompt(segCtx);

  const completion = await complete({
    system,
    messages: [...history, { role: "user", content: inbound.text }],
    maxTokens: 512,
  });

  await recordUsage(tenant.id, completion.usage.total_billable_tokens);

  if (!completion.text) {
    logger.warn("agent_empty_reply", { conversationId: conv.id });
    return;
  }

  const hookResult = segment.onAgentReply
    ? await segment.onAgentReply(segCtx, completion.text)
    : { cleanText: completion.text };

  // If the agent emitted an interactive payload, the body of the interactive
  // message *is* the user-facing prose; we still keep `cleanText` for the
  // dashboard / history readers. If there's no interactive, plain text only.
  const sendKind: "text" | "buttons" | "list" = hookResult.interactive
    ? hookResult.interactive.kind
    : "text";

  // For a pure-marker reply (no prose), the body in the marker is what the
  // user sees; cleanText may be empty. Treat empty-prose-with-interactive
  // as valid.
  if (sendKind === "text" && !hookResult.cleanText) return;

  // Phase 1: persist pending row (idempotency anchor).
  const pending = await insertOutboundPending(tc, {
    conversationId: conv.id,
    text: textForRow(hookResult),
    agentName: segment.name,
    idempotencyKey: inbound.id,
    tokensIn: completion.usage.input_tokens,
    tokensOut: completion.usage.output_tokens,
    model: completion.model,
    contentType: sendKind === "text" ? "text" : "interactive",
    interactiveMeta: interactiveMetaFor(hookResult.interactive),
  });

  // Phase 2: send. On error mark failed (so retries are allowed) and rethrow.
  let sent;
  try {
    sent = await sendForReply(inbound.from, hookResult.cleanText, hookResult.interactive);
  } catch (err) {
    await markOutboundFailed(tc, { id: pending.id, reason: (err as Error).message });
    throw err;
  }

  // Phase 3: patch the row with Meta's real id and the sent timestamp.
  await markOutboundSent(tc, { id: pending.id, waMessageId: sent.wa_message_id });

  // Side-channel work: roll the summary forward if the conversation has
  // outgrown the recent-history window. Best-effort, never throws.
  const totalMessages = await countMessages(tc, conv.id).catch(() => 0);
  if (totalMessages >= env.SUMMARY_REFRESH_AFTER_TURNS) {
    await maybeRefreshSummary(tc, conv.id, history, conv.summary);
  }

  if (completion.usage.total_billable_tokens > 5000) {
    captureMessage("high_token_turn", "info", {
      tokens: completion.usage.total_billable_tokens,
      model: completion.model,
    });
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Normalize an inbound payload into a uniform shape. Interactive replies
 * get their displayed title surfaced as `text` so the model sees natural
 * language — the structured id stays in `interactive` for persistence.
 */
function normalizeInbound(raw: unknown): NormalizedInbound | null {
  const t = InboundTextMessage.safeParse(raw);
  if (t.success) {
    return { from: t.data.from, id: t.data.id, text: t.data.text.body };
  }
  const i = InboundInteractiveMessage.safeParse(raw);
  if (i.success) {
    const ix = i.data.interactive;
    if (ix.type === "button_reply") {
      return {
        from: i.data.from,
        id: i.data.id,
        text: ix.button_reply.title,
        interactive: { type: "button_reply", id: ix.button_reply.id },
      };
    }
    return {
      from: i.data.from,
      id: i.data.id,
      text: ix.list_reply.title,
      interactive: { type: "list_reply", id: ix.list_reply.id },
    };
  }
  return null;
}

/**
 * Pick the text we record in the messages.text column. For interactive
 * sends, prefer the marker's body (what the customer actually reads); fall
 * back to the prose if the body was empty.
 */
function textForRow(r: { cleanText: string; interactive?: InteractiveReply }): string {
  if (!r.interactive) return r.cleanText;
  return r.interactive.payload.body || r.cleanText || "(interactive message)";
}

function interactiveMetaFor(i?: InteractiveReply): Record<string, unknown> | undefined {
  if (!i) return undefined;
  if (i.kind === "buttons") {
    return { kind: "buttons", buttons: i.payload.buttons };
  }
  return {
    kind: "list",
    buttonText: i.payload.buttonText,
    sections: i.payload.sections,
  };
}

async function sendForReply(
  to: string,
  cleanText: string,
  interactive?: InteractiveReply,
): Promise<{ wa_message_id: string }> {
  if (!interactive) return sendText(to, cleanText);
  if (interactive.kind === "buttons") return sendButtons(to, interactive.payload);
  return sendList(to, interactive.payload);
}
