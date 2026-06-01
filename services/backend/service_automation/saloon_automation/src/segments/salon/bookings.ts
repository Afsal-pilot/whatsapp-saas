/**
 * Salon booking capture.
 *
 * The agent emits a `[BOOKING_REQUEST] ...` line — see `prompt.ts`. We strip
 * that line from the user-facing reply and persist a row to `bookings`.
 *
 * Date / time normalization is intentionally permissive: the model is
 * instructed to write YYYY-MM-DD / HH:MM, but accepts close-enough variants
 * (slashes, dots, single-digit components, AM/PM) so a small drift doesn't
 * silently drop the booking on the floor.
 */
import type { TenantClient } from "@whatsapp-saas/wapi-db";
import { logger } from "@/core/logger";
import { BOOKING_MARKER } from "./prompt";

export type ParsedBooking = {
  name: string;
  service: string;
  date: string | null;     // YYYY-MM-DD or null when "flexible"
  time: string | null;     // HH:MM (24h) or null when "flexible"
  notes: string | null;
};

export function extractBooking(replyText: string): {
  cleanText: string;
  booking: ParsedBooking | null;
} {
  const idx = replyText.indexOf(BOOKING_MARKER);
  if (idx === -1) return { cleanText: replyText, booking: null };

  const lineEnd = replyText.indexOf("\n", idx);
  const markerLine =
    lineEnd === -1 ? replyText.slice(idx) : replyText.slice(idx, lineEnd);
  const cleanText = (
    replyText.slice(0, idx) +
    (lineEnd === -1 ? "" : replyText.slice(lineEnd + 1))
  ).trim();

  const fields = parseKvLine(markerLine.slice(BOOKING_MARKER.length).trim());
  const name = fields.name?.trim();
  const service = fields.service?.trim();
  if (!name || !service) {
    logger.warn("salon_booking_marker_missing_fields", { markerLine });
    return { cleanText, booking: null };
  }

  return {
    cleanText,
    booking: {
      name,
      service,
      date: normalizeDate(fields.date),
      time: normalizeTime(fields.time),
      notes: fields.notes?.trim() || null,
    },
  };
}

export async function recordBooking(
  tc: TenantClient,
  input: {
    userId: string;
    conversationId: string;
    booking: ParsedBooking;
  },
): Promise<string> {
  const { data, error } = await tc.from("bookings").insert({
    user_id: input.userId,
    conversation_id: input.conversationId,
    customer_name: input.booking.name,
    service: input.booking.service,
    preferred_date: input.booking.date,
    preferred_time: input.booking.time,
    notes: input.booking.notes,
  }).select("id").single();
  if (error) throw error;
  return (data as unknown as { id: string }).id;
}

// ─── helpers ────────────────────────────────────────────────────────────────
function parseKvLine(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const segment of line.split(";")) {
    const eq = segment.indexOf("=");
    if (eq === -1) continue;
    const key = segment.slice(0, eq).trim();
    const value = segment.slice(eq + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

/**
 * Accepts YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD and pads single-digit
 * month/day. Anything else (or "flexible") becomes null — the salon team
 * follows up to confirm.
 */
export function normalizeDate(v: string | undefined): string | null {
  if (!v) return null;
  const trimmed = v.trim().toLowerCase();
  if (!trimmed || trimmed === "flexible" || trimmed === "tbd") return null;

  const m = trimmed.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Accepts HH:MM / H:MM (24h) and H[:MM] AM/PM. Returns 24h "HH:MM".
 */
export function normalizeTime(v: string | undefined): string | null {
  if (!v) return null;
  const trimmed = v.trim().toLowerCase();
  if (!trimmed || trimmed === "flexible" || trimmed === "tbd") return null;

  // 24h: HH:MM, H:MM, optional :SS suffix
  const m24 = trimmed.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (m24) {
    const h = Number(m24[1]);
    const mi = Number(m24[2]);
    if (h > 23 || mi > 59) return null;
    return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
  }

  // 12h: 4pm, 4:30pm, 4 pm, 11:00 am
  const m12 = trimmed.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?$/);
  if (m12) {
    let h = Number(m12[1]);
    const mi = m12[2] ? Number(m12[2]) : 0;
    const ap = m12[3];
    if (h < 1 || h > 12 || mi > 59) return null;
    if (ap === "a") h = h === 12 ? 0 : h;
    else            h = h === 12 ? 12 : h + 12;
    return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
  }
  return null;
}
