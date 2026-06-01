/**
 * Salon operator workflow — Confirm / Reject buttons on new bookings.
 *
 * When a customer's booking lands in the `bookings` table, we WhatsApp the
 * salon owner a card with two buttons. Their tap comes back through the
 * normal webhook → processor pipeline, where this module intercepts it
 * BEFORE the customer agent flow runs.
 *
 * Button-id encoding:
 *
 *   "bk_confirm_<bookingId>"
 *   "bk_reject_<bookingId>"
 *
 * The booking id is a UUID, so the id stays well under WhatsApp's 256-char
 * cap. The prefix is intentionally distinct from anything the model can
 * emit so we can recognise it without false positives.
 *
 * 24h re-engagement window: this module sends free-text to the customer
 * when the owner taps a button. WhatsApp allows free-form within 24h of
 * the customer's last inbound. New bookings are usually confirmed within
 * minutes of the customer's request, so this is safe. If the owner sits
 * on the request for >24h, the customer message will be rejected by Meta
 * (logged + Sentry'd) — the workaround is a Utility template, which is a
 * v2 feature.
 */
import type { TenantClient } from "@whatsapp-saas/wapi-db";
import type { Tenant } from "@/core/tenants/types";
import { sendButtons, sendText } from "@whatsapp-saas/wapi-meta";
import { logger } from "@/core/logger";
import { captureException } from "@/core/sentry";
import type { OwnerHookResult, OwnerInbound } from "../types";
import { parseSalonConfig, servicesAsRows, type SalonConfig } from "./config";

const PREFIX_CONFIRM = "bk_confirm_";
const PREFIX_REJECT  = "bk_reject_";

type ParsedOwnerButton =
  | { action: "confirm"; bookingId: string }
  | { action: "reject";  bookingId: string };

export function parseOwnerButton(buttonId: string): ParsedOwnerButton | null {
  if (buttonId.startsWith(PREFIX_CONFIRM)) {
    const bookingId = buttonId.slice(PREFIX_CONFIRM.length);
    return bookingId ? { action: "confirm", bookingId } : null;
  }
  if (buttonId.startsWith(PREFIX_REJECT)) {
    const bookingId = buttonId.slice(PREFIX_REJECT.length);
    return bookingId ? { action: "reject", bookingId } : null;
  }
  return null;
}

/**
 * Intercept an inbound from the salon owner. Returns handled=true and
 * short-circuits the customer-facing pipeline when the inbound is one of
 * our Confirm/Reject button taps.
 */
export async function handleOwnerInbound(
  ctx: { tc: TenantClient; tenant: Tenant },
  inbound: OwnerInbound,
): Promise<OwnerHookResult> {
  const cfg = parseSalonConfig(ctx.tenant.config, ctx.tenant.id);
  // Belt-and-braces — caller should have checked this already.
  if (!cfg.ownerWaId || inbound.from !== cfg.ownerWaId) {
    return { handled: false };
  }
  if (inbound.interactive?.type !== "button_reply") {
    return { handled: false };
  }
  const parsed = parseOwnerButton(inbound.interactive.id);
  if (!parsed) return { handled: false };

  const booking = await fetchBooking(ctx.tc, parsed.bookingId);
  if (!booking) {
    logger.warn("owner_button_unknown_booking", { bookingId: parsed.bookingId });
    await safeSend(cfg.ownerWaId, "Couldn't find that booking — it may have been deleted.");
    return { handled: true };
  }

  if (parsed.action === "confirm") {
    await updateBooking(ctx.tc, parsed.bookingId, "confirmed");
    await notifyCustomerConfirmed(ctx.tc, booking, cfg);
    await safeSend(cfg.ownerWaId, "✓ Confirmation sent to the customer.");
  } else {
    await updateBooking(ctx.tc, parsed.bookingId, "cancelled");
    await notifyCustomerRejected(ctx.tc, booking, cfg);
    await safeSend(cfg.ownerWaId, "Booking marked as cancelled. We let the customer know.");
  }
  return { handled: true };
}

/**
 * Send the operator the Confirm/Reject card right after a booking lands.
 * Best-effort — a failure here logs but does NOT propagate, because the
 * customer-facing booking has already been captured.
 */
export async function notifyOwner(input: {
  cfg: SalonConfig;
  booking: {
    id: string;
    customerName: string;
    serviceId: string;
    date: string | null;
    time: string | null;
    notes: string | null;
  };
  customerWaId: string;
}): Promise<void> {
  const { cfg, booking, customerWaId } = input;
  if (!cfg.ownerWaId) {
    logger.info("owner_notify_skipped_no_owner");
    return;
  }
  const services = servicesAsRows(cfg);
  const serviceTitle =
    services.find((s) => s.id === booking.serviceId)?.title ?? booking.serviceId;

  const bodyLines = [
    `Service: ${serviceTitle}`,
    `Date: ${booking.date ?? "flexible"}`,
    `Time: ${booking.time ?? "flexible"}`,
    `For: ${booking.customerName}`,
    `WhatsApp: +${customerWaId}`,
  ];
  if (booking.notes) bodyLines.push(`Notes: ${booking.notes}`);
  const body = bodyLines.join("\n").slice(0, 1020);

  try {
    await sendButtons(cfg.ownerWaId, {
      header: "📋 New booking request",
      body,
      footer: "Tap to action — the customer will be notified.",
      buttons: [
        { id: `${PREFIX_CONFIRM}${booking.id}`, title: "✓ Confirm" },
        { id: `${PREFIX_REJECT}${booking.id}`,  title: "✕ Reject" },
      ],
    });
    logger.info("owner_notified", { bookingId: booking.id, ownerWaId: cfg.ownerWaId });
  } catch (err) {
    logger.error("owner_notify_failed", {
      bookingId: booking.id,
      error: (err as Error).message,
    });
    captureException(err, { stage: "owner_notify", bookingId: booking.id });
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

async function fetchBooking(tc: TenantClient, bookingId: string) {
  const { data, error } = await tc
    .from("bookings")
    .select("id, customer_name, service, preferred_date, preferred_time, notes, user_id, status")
    .eq("id", bookingId)
    .maybeSingle();
  if (error) {
    logger.warn("owner_booking_lookup_failed", { bookingId, error: error.message });
    return null;
  }
  return data as null | {
    id: string;
    customer_name: string;
    service: string;
    preferred_date: string | null;
    preferred_time: string | null;
    notes: string | null;
    user_id: string;
    status: string;
  };
}

async function updateBooking(
  tc: TenantClient,
  bookingId: string,
  status: "confirmed" | "cancelled",
): Promise<void> {
  const { error } = await tc
    .from("bookings")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", bookingId);
  if (error) {
    logger.error("owner_booking_update_failed", { bookingId, status, error: error.message });
    captureException(error, { stage: "owner_booking_update", bookingId });
  }
}

async function notifyCustomerConfirmed(
  tc: TenantClient,
  booking: NonNullable<Awaited<ReturnType<typeof fetchBooking>>>,
  cfg: SalonConfig,
): Promise<void> {
  const wa = await fetchUserWaId(tc, booking.user_id);
  if (!wa) return;
  const services = servicesAsRows(cfg);
  const serviceTitle =
    services.find((s) => s.id === booking.service)?.title ?? booking.service;
  const when = booking.preferred_date
    ? `on ${booking.preferred_date}${booking.preferred_time ? ` at ${booking.preferred_time}` : ""}`
    : "at the agreed time";
  const address = cfg.address ? ` See you at ${cfg.address}.` : "";
  await safeSend(
    wa,
    `✅ ${booking.customer_name}, your ${serviceTitle} ${when} is confirmed.${address}`,
  );
}

async function notifyCustomerRejected(
  tc: TenantClient,
  booking: NonNullable<Awaited<ReturnType<typeof fetchBooking>>>,
  cfg: SalonConfig,
): Promise<void> {
  const wa = await fetchUserWaId(tc, booking.user_id);
  if (!wa) return;
  const services = servicesAsRows(cfg);
  const serviceTitle =
    services.find((s) => s.id === booking.service)?.title ?? booking.service;
  const when = booking.preferred_date
    ? `on ${booking.preferred_date}${booking.preferred_time ? ` at ${booking.preferred_time}` : ""}`
    : "at that time";
  await safeSend(
    wa,
    `Sorry ${booking.customer_name} — we can't fit in a ${serviceTitle} ${when}. ` +
      "Reply with another day or time and we'll try again.",
  );
}

async function fetchUserWaId(tc: TenantClient, userId: string): Promise<string | null> {
  const { data, error } = await tc
    .from("users")
    .select("wa_id")
    .eq("id", userId)
    .maybeSingle();
  if (error) {
    logger.warn("owner_user_lookup_failed", { userId, error: error.message });
    return null;
  }
  return (data as { wa_id?: string } | null)?.wa_id ?? null;
}

async function safeSend(to: string, body: string): Promise<void> {
  try {
    await sendText(to, body);
  } catch (err) {
    logger.error("owner_flow_send_failed", { to, error: (err as Error).message });
    captureException(err, { stage: "owner_flow_send", to });
  }
}
