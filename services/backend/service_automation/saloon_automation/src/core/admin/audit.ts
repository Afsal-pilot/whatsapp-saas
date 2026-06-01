/**
 * Audit log — every admin action is recorded with actor + target + details.
 * Best-effort: a failure here logs a warning but never blocks the action.
 */
import { supabase } from "@whatsapp-saas/wapi-db";
import { getRequestId } from "@/core/context";
import { logger } from "@/core/logger";

export async function audit(input: {
  tenantId?: string | null;
  actor: string;
  action: string;
  target?: string | null;
  details?: Record<string, unknown>;
}): Promise<void> {
  const { error } = await supabase().from("audit_logs").insert({
    tenant_id: input.tenantId ?? null,
    actor: input.actor,
    action: input.action,
    target: input.target ?? null,
    details: input.details ?? {},
    request_id: getRequestId() ?? null,
  });
  if (error) {
    logger.warn("audit_log_write_failed", { action: input.action, error: error.message });
  }
}
