/**
 * Customer-profile lookups used to personalise the agent prompt.
 *
 * Both are best-effort: a slow or failing query falls back to "no signal"
 * rather than blocking the reply. They each do ONE small indexed read so
 * the latency cost on the hot path is minimal.
 */
import type { TenantClient } from "@whatsapp-saas/wapi-db";
import { logger } from "@/core/logger";

const RETURNING_THRESHOLD_MS = 30 * 60 * 1000; // 30 min — anything older counts as "returning"

export type Personalisation = {
  isReturning: boolean;
  lastBookingService: string | null;
};

export async function loadPersonalisation(
  tc: TenantClient,
  userId: string,
): Promise<Personalisation> {
  const [firstSeen, lastBooking] = await Promise.all([
    fetchFirstSeen(tc, userId),
    fetchLastBookingService(tc, userId),
  ]);
  const isReturning = firstSeen !== null
    ? Date.now() - firstSeen.getTime() > RETURNING_THRESHOLD_MS
    : false;
  return { isReturning, lastBookingService: lastBooking };
}

async function fetchFirstSeen(tc: TenantClient, userId: string): Promise<Date | null> {
  try {
    const { data, error } = await tc
      .from("users")
      .select("first_seen")
      .eq("id", userId)
      .maybeSingle();
    if (error) throw error;
    const v = (data as { first_seen?: string } | null)?.first_seen;
    return v ? new Date(v) : null;
  } catch (err) {
    logger.warn("personalisation_first_seen_failed", { error: (err as Error).message });
    return null;
  }
}

async function fetchLastBookingService(tc: TenantClient, userId: string): Promise<string | null> {
  try {
    const { data, error } = await tc
      .from("bookings")
      .select("service")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return (data as { service?: string } | null)?.service ?? null;
  } catch (err) {
    logger.warn("personalisation_last_booking_failed", { error: (err as Error).message });
    return null;
  }
}
