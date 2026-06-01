/**
 * webhook_events service — durable audit log for inbound Meta webhooks.
 *
 * Why this uses the raw supabase() client (not tenantClient):
 * the webhook handler MUST persist the raw payload before resolving the
 * tenant, so at insert time we don't yet know the tenant_id. The processor
 * back-fills it via `setEventTenant()` once `resolveTenant()` succeeds.
 *
 * Treat that as the only legitimate cross-tenant write in the codebase.
 */
import { supabase } from "@whatsapp-saas/wapi-db";

export type WebhookEventStatus = "received" | "processing" | "processed" | "failed";

export async function recordReceived(eventId: string, payload: unknown): Promise<void> {
  const { error } = await supabase()
    .from("webhook_events")
    .upsert(
      { id: eventId, payload, status: "received" satisfies WebhookEventStatus },
      { onConflict: "id", ignoreDuplicates: true },
    );
  if (error) throw error;
}

export async function getEvent(eventId: string) {
  const { data, error } = await supabase()
    .from("webhook_events")
    .select("id, payload, status, attempts, tenant_id")
    .eq("id", eventId)
    .single();
  if (error) throw error;
  return data;
}

export async function markProcessing(eventId: string): Promise<void> {
  await supabase()
    .from("webhook_events")
    .update({ status: "processing" satisfies WebhookEventStatus })
    .eq("id", eventId);
}

export async function markProcessed(eventId: string): Promise<void> {
  await supabase()
    .from("webhook_events")
    .update({
      status: "processed" satisfies WebhookEventStatus,
      processed_at: new Date().toISOString(),
    })
    .eq("id", eventId);
}

export async function markFailed(eventId: string, error: string, attempts: number): Promise<void> {
  await supabase()
    .from("webhook_events")
    .update({
      status: "failed" satisfies WebhookEventStatus,
      error,
      attempts,
    })
    .eq("id", eventId);
}

/**
 * Populate tenant_id on the event row once the processor has resolved it.
 * Called from the processor, not the webhook intake — by design.
 */
export async function setEventTenant(eventId: string, tenantId: string): Promise<void> {
  await supabase()
    .from("webhook_events")
    .update({ tenant_id: tenantId })
    .eq("id", eventId)
    .is("tenant_id", null);
}
