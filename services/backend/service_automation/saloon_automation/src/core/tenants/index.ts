/**
 * Tenant resolver + per-tenant usage helpers.
 *
 * Looks up a tenant by the Meta phone-number-id that arrives on every webhook
 * payload at `entry[0].changes[0].value.metadata.phone_number_id`. There is
 * one tenant per phone_number_id; unknown numbers are rejected loudly.
 *
 * To onboard a new tenant:
 *   1. INSERT into tenants (name, segment, config, phone_number_id, timezone).
 *   2. Register the same phone_number_id with Meta against your WhatsApp app.
 *   3. No code changes needed — this resolver picks it up automatically.
 */
import { supabase } from "@whatsapp-saas/wapi-db";
import { logger } from "@/core/logger";
import type { Tenant, SegmentName } from "./types";

export type { Tenant, SegmentName } from "./types";

export class UnknownTenantError extends Error {
  constructor(public readonly phoneNumberId: string) {
    super(`Unknown tenant for phone_number_id=${phoneNumberId}`);
    this.name = "UnknownTenantError";
  }
}

export class TokenBudgetExceededError extends Error {
  constructor(
    public readonly tenantId: string,
    public readonly used: number,
    public readonly cap: number,
  ) {
    super(`Tenant ${tenantId} over monthly token cap (${used}/${cap})`);
    this.name = "TokenBudgetExceededError";
  }
}

export async function resolveTenant(phoneNumberId: string): Promise<Tenant> {
  if (!phoneNumberId) {
    throw new Error("resolveTenant: phone_number_id is required");
  }

  const { data, error } = await supabase()
    .from("tenants")
    .select(
      "id, name, segment, config, timezone, monthly_token_cap, monthly_tokens_used, usage_period_start",
    )
    .eq("phone_number_id", phoneNumberId)
    .maybeSingle();

  if (error) throw new Error(`Tenant lookup failed: ${error.message}`);
  if (!data) throw new UnknownTenantError(phoneNumberId);

  return {
    id: data.id as string,
    name: data.name as string,
    segment: (data.segment ?? "salon") as SegmentName,
    config: (data.config ?? {}) as Record<string, unknown>,
    timezone: (data.timezone ?? "UTC") as string,
    monthlyTokenCap: (data.monthly_token_cap as number | null) ?? null,
    monthlyTokensUsed: (data.monthly_tokens_used as number | null) ?? 0,
    usagePeriodStart: (data.usage_period_start as string | null) ?? null,
  };
}

/**
 * Check whether the tenant has budget for another Claude call.
 * Returns the rolled-over budget snapshot (period reset is lazy: when the
 * row's `usage_period_start` is in a prior month, we treat used as 0).
 *
 * Throws `TokenBudgetExceededError` when the cap is set and exceeded.
 */
export function assertBudget(tenant: Tenant, now: Date = new Date()): { used: number; cap: number | null } {
  if (tenant.monthlyTokenCap == null) return { used: tenant.monthlyTokensUsed, cap: null };

  const periodStart = tenant.usagePeriodStart ? new Date(tenant.usagePeriodStart) : null;
  const currentPeriod = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const periodActive = periodStart && periodStart.toISOString().slice(0, 10) === currentPeriod;
  const used = periodActive ? tenant.monthlyTokensUsed : 0;

  if (used >= tenant.monthlyTokenCap) {
    throw new TokenBudgetExceededError(tenant.id, used, tenant.monthlyTokenCap);
  }
  return { used, cap: tenant.monthlyTokenCap };
}

/**
 * Atomic-ish usage increment. Rolls the period forward on the first hit of
 * a new month. Best-effort: a failure here is logged but does NOT throw —
 * we'd rather under-bill than fail the message reply.
 */
export async function recordUsage(tenantId: string, tokens: number, now: Date = new Date()): Promise<void> {
  if (tokens <= 0) return;
  const currentPeriod = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);

  const sb = supabase();
  const { data, error } = await sb
    .from("tenants")
    .select("monthly_tokens_used, usage_period_start")
    .eq("id", tenantId)
    .single();
  if (error || !data) {
    logger.warn("tenant_usage_read_failed", { tenantId, error: error?.message });
    return;
  }

  const periodActive = (data.usage_period_start as string | null) === currentPeriod;
  const nextUsed = (periodActive ? (data.monthly_tokens_used as number) : 0) + tokens;

  const { error: upErr } = await sb
    .from("tenants")
    .update({
      monthly_tokens_used: nextUsed,
      usage_period_start: currentPeriod,
    })
    .eq("id", tenantId);
  if (upErr) {
    logger.warn("tenant_usage_write_failed", { tenantId, error: upErr.message });
  }
}
