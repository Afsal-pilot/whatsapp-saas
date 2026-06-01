/**
 * Outbound rate limiter — fixed 1-minute windows per (tenant, recipient).
 *
 * Stored in Postgres (rate_limit_buckets) so it survives across Vercel
 * invocations. Counters are sloppy by design (no row-level locking, just
 * an UPSERT with an increment) — under burst load we may overshoot by one
 * or two; that's fine for "don't blast the same recipient". For hard caps
 * use Meta's own throttles.
 *
 * Returns `{ allowed: true }` when the message may proceed, or
 * `{ allowed: false, retryAfterMs }` when blocked.
 */
import { supabase } from "@whatsapp-saas/wapi-db";
import { logger } from "@/core/logger";
import { env } from "@/core/config/env";

const WINDOW_MS = 60_000;

export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number };

export async function checkAndIncrement(
  tenantId: string,
  recipient: string,
  perMinute: number = env.OUTBOUND_RATE_LIMIT_PER_MIN,
): Promise<RateLimitDecision> {
  if (perMinute <= 0) return { allowed: true };

  const windowStart = currentWindow(new Date());
  const sb = supabase();

  // Lazy insert + read in one trip. We can't do an atomic
  // "increment-if-below-cap" in one call, so we read, decide, then write.
  const { data, error } = await sb
    .from("rate_limit_buckets")
    .select("count")
    .eq("tenant_id", tenantId)
    .eq("recipient", recipient)
    .eq("window_start", windowStart.toISOString())
    .maybeSingle();

  if (error) {
    logger.warn("rate_limit_read_failed", { error: error.message });
    return { allowed: true };
  }

  const current = (data?.count as number | undefined) ?? 0;
  if (current >= perMinute) {
    const retryAfterMs = windowStart.getTime() + WINDOW_MS - Date.now();
    return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 0) };
  }

  const { error: upErr } = await sb.from("rate_limit_buckets").upsert(
    {
      tenant_id: tenantId,
      recipient,
      window_start: windowStart.toISOString(),
      count: current + 1,
    },
    { onConflict: "tenant_id,recipient,window_start" },
  );
  if (upErr) {
    logger.warn("rate_limit_write_failed", { error: upErr.message });
    // Fail open — we'd rather risk a small overshoot than drop a real reply.
    return { allowed: true };
  }
  return { allowed: true };
}

function currentWindow(now: Date): Date {
  const ms = Math.floor(now.getTime() / WINDOW_MS) * WINDOW_MS;
  return new Date(ms);
}
