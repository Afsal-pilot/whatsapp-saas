/**
 * Messages service — read history, append inbound, append outbound.
 *
 * Outbound writes use a two-phase pattern:
 *
 *   1. `insertOutboundPending()` — write a row with status='pending', no
 *      `wa_message_id` yet (placeholder). Returns the row id.
 *   2. WhatsApp `sendText()` runs.
 *   3. On success: `markOutboundSent()` patches wa_message_id + status='sent'.
 *      On failure: `markOutboundFailed()` patches status='failed' + reason.
 *
 * Why: a transient send failure used to leave NO outbound row at all, so the
 * QStash retry would re-invoke Claude and send a duplicate message. With a
 * pending row in place, the retry sees the prior attempt and bails (see
 * processor.ts).
 *
 * History is what we hand to the agent. Default window is 20 turns; expand
 * with a rolling summary in `conversations.summary` when chats grow long.
 *
 * All queries go through `TenantClient` — see `clients/supabase.ts` for why.
 */
import type { TenantClient } from "@whatsapp-saas/wapi-db";
import type { ChatMessage } from "@/core/clients/claude";

const DEFAULT_HISTORY_TURNS = 20;

export async function recordInboundText(
  tc: TenantClient,
  input: {
    conversationId: string;
    waMessageId: string;
    text: string;
    /**
     * For interactive replies (button taps / list selections), the structured
     * payload — id, raw type. The text column stores the displayed title so
     * future agent turns see natural language; meta holds the structured ref.
     */
    interactive?: { type: "button_reply" | "list_reply"; id: string };
  },
): Promise<void> {
  const meta: Record<string, unknown> = {};
  if (input.interactive) meta.interactive = input.interactive;
  const { error } = await tc
    .from("messages")
    .upsert(
      {
        conversation_id: input.conversationId,
        wa_message_id: input.waMessageId,
        direction: "in",
        sender_type: "user",
        content_type: input.interactive ? "interactive" : "text",
        text: input.text,
        status: "delivered",
        meta,
      },
      { onConflict: "wa_message_id", ignoreDuplicates: true },
    );
  if (error) throw error;
}

export type PendingOutbound = { id: string };

export async function insertOutboundPending(
  tc: TenantClient,
  input: {
    conversationId: string;
    text: string;
    agentName: string;
    idempotencyKey: string;          // typically the inbound wa_message_id
    tokensIn?: number;
    tokensOut?: number;
    model?: string;
    /**
     * "text" for plain replies, "interactive" when we're sending buttons/list.
     * The dashboard renders these differently and the agent's history loader
     * uses content_type to decide what's worth replaying.
     */
    contentType?: "text" | "interactive";
    /** Structured interactive payload echoed into meta for the dashboard. */
    interactiveMeta?: Record<string, unknown>;
  },
): Promise<PendingOutbound> {
  // Upsert on a synthetic wa_message_id (the idempotency key) so the QStash
  // retry collapses onto the same row. We do NOT yet know Meta's real id.
  const placeholder = `pending:${input.idempotencyKey}`;
  const meta: Record<string, unknown> = { agent: input.agentName };
  if (input.interactiveMeta) meta.interactive = input.interactiveMeta;
  const { data, error } = await tc
    .from("messages")
    .upsert(
      {
        conversation_id: input.conversationId,
        wa_message_id: placeholder,
        direction: "out",
        sender_type: "agent",
        content_type: input.contentType ?? "text",
        text: input.text,
        status: "pending",
        tokens_in: input.tokensIn ?? null,
        tokens_out: input.tokensOut ?? null,
        model: input.model ?? null,
        meta,
      },
      { onConflict: "wa_message_id" },
    )
    .select("id")
    .single();
  if (error) throw error;
  return { id: (data as { id: string }).id };
}

export async function markOutboundSent(
  tc: TenantClient,
  input: { id: string; waMessageId: string },
): Promise<void> {
  const { error } = await tc.from("messages").update({
    wa_message_id: input.waMessageId,
    status: "sent",
    sent_at: new Date().toISOString(),
  }).eq("id", input.id);
  if (error) throw error;
}

export async function markOutboundFailed(
  tc: TenantClient,
  input: { id: string; reason: string },
): Promise<void> {
  const { error } = await tc.from("messages").update({
    status: "failed",
    failed_at: new Date().toISOString(),
    failure_reason: input.reason.slice(0, 500),
  }).eq("id", input.id);
  if (error) throw error;
}

/**
 * True if we already have a non-failed outbound row for this idempotency key.
 * Used by the processor to short-circuit retries that would otherwise
 * re-invoke Claude + re-send.
 */
export async function outboundAlreadyResolved(
  tc: TenantClient,
  idempotencyKey: string,
): Promise<boolean> {
  const placeholder = `pending:${idempotencyKey}`;
  const { data, error } = await tc
    .from("messages")
    .select("status")
    .eq("wa_message_id", placeholder)
    .maybeSingle();
  if (error) throw error;
  if (!data) return false;
  return (data as unknown as { status: string }).status !== "failed";
}

// ─── inbound status callbacks (delivered/read/failed from Meta) ─────────────
export async function applyDeliveryStatus(
  tc: TenantClient,
  input: {
    waMessageId: string;
    status: "sent" | "delivered" | "read" | "failed";
    timestamp: Date;
    reason?: string;
  },
): Promise<void> {
  const patch: Record<string, unknown> = { status: input.status };
  if (input.status === "delivered") patch.delivered_at = input.timestamp.toISOString();
  if (input.status === "read")      patch.read_at      = input.timestamp.toISOString();
  if (input.status === "failed") {
    patch.failed_at = input.timestamp.toISOString();
    if (input.reason) patch.failure_reason = input.reason.slice(0, 500);
  }

  const { error } = await tc
    .from("messages")
    .update(patch)
    .eq("wa_message_id", input.waMessageId);
  if (error) throw error;
}

export async function loadHistory(
  tc: TenantClient,
  conversationId: string,
  turns: number = DEFAULT_HISTORY_TURNS,
): Promise<ChatMessage[]> {
  const { data, error } = await tc
    .from("messages")
    .select("direction, text, created_at, status")
    .eq("conversation_id", conversationId)
    .in("content_type", ["text", "interactive"])
    .neq("status", "failed")
    .order("created_at", { ascending: false })
    .limit(turns);

  if (error) throw error;

  type Row = { direction: "in" | "out"; text: string | null; created_at: string };
  const rows = ((data ?? []) as unknown as Row[]).slice().reverse();
  return rows
    .filter((m): m is Row & { text: string } =>
      typeof m.text === "string" && m.text.length > 0,
    )
    .map((m) => ({
      role: m.direction === "in" ? "user" : "assistant",
      content: m.text,
    }));
}

export async function countMessages(
  tc: TenantClient,
  conversationId: string,
): Promise<number> {
  const { count, error } = await tc
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("conversation_id", conversationId);
  if (error) throw error;
  return count ?? 0;
}
