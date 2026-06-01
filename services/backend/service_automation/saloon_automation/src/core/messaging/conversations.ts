/**
 * Conversation service — find-or-create a user + their active conversation.
 *
 * One active conversation per (tenant, user). Closing or escalating is
 * tracked via `status`; the next inbound message reopens or creates a new one.
 *
 * The race we used to lose: two concurrent inbound webhooks both saw
 * "no active conversation" and both inserted. Migration 0005 added a partial
 * unique index on `(tenant_id, user_id) WHERE status IN ('active','idle')`,
 * so the second insert now fails with 23505 — we catch it and re-select.
 *
 * Every call takes a `TenantClient` so the underlying queries are tenant-
 * scoped by construction. Do not introduce a `tenantId: string` overload —
 * the wrapper is the seam that prevents cross-tenant bleed.
 */
import type { TenantClient } from "@whatsapp-saas/wapi-db";

export type User = {
  id: string;
  tenant_id: string;
  wa_id: string;
  name: string | null;
};

export type Conversation = {
  id: string;
  tenant_id: string;
  user_id: string;
  status: "active" | "idle" | "closed" | "human";
  current_agent: string | null;
  summary: string | null;
};

const OPEN_STATUSES = ["active", "idle"] as const;
const CONVERSATION_COLS = "id, tenant_id, user_id, status, current_agent, summary";
const UNIQUE_VIOLATION = "23505";

export async function upsertUser(
  tc: TenantClient,
  input: { waId: string; name?: string | null },
): Promise<User> {
  const { data, error } = await tc
    .from("users")
    .upsert(
      {
        wa_id: input.waId,
        name: input.name ?? null,
        last_seen: new Date().toISOString(),
      },
      { onConflict: "tenant_id,wa_id" },
    )
    .select("id, tenant_id, wa_id, name")
    .single();
  if (error) throw error;
  return data as unknown as User;
}

export async function getOrCreateActiveConversation(
  tc: TenantClient,
  user: User,
): Promise<Conversation> {
  const existing = await selectOpenConversation(tc, user.id);
  if (existing) return existing;

  const created = await tc
    .from("conversations")
    .insert({ user_id: user.id, status: "active" })
    .select(CONVERSATION_COLS)
    .single();

  if (created.error) {
    // Race: the other writer beat us to it. Re-select the winner.
    if ((created.error as { code?: string }).code === UNIQUE_VIOLATION) {
      const winner = await selectOpenConversation(tc, user.id);
      if (winner) return winner;
    }
    throw created.error;
  }
  return created.data as unknown as Conversation;
}

async function selectOpenConversation(
  tc: TenantClient,
  userId: string,
): Promise<Conversation | null> {
  const { data, error } = await tc
    .from("conversations")
    .select(CONVERSATION_COLS)
    .eq("user_id", userId)
    .in("status", OPEN_STATUSES as unknown as string[])
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data ?? null) as Conversation | null;
}

export async function updateConversationSummary(
  tc: TenantClient,
  conversationId: string,
  summary: string,
): Promise<void> {
  const { error } = await tc
    .from("conversations")
    .update({ summary })
    .eq("id", conversationId);
  if (error) throw error;
}
