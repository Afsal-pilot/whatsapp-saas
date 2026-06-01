/**
 * Salon segment.
 *
 * Composes the salon-specific pieces (config schema, system prompt, booking
 * capture, interactive markers, owner Confirm/Reject flow) into a single
 * `Segment` registered in `src/segments/index.ts`.
 *
 * Reply post-processing happens in this order:
 *   1. Strip + persist any [BOOKING_REQUEST] marker.
 *   2. Strip + parse any [INTERACTIVE] marker into a button/list payload.
 *   3. If a booking landed, notify the salon owner (best-effort).
 *   4. Return the trimmed text and the optional interactive companion.
 */
import { logger } from "@/core/logger";
import type {
  OwnerInbound,
  OwnerHookResult,
  Segment,
  SegmentContext,
  ReplyHookResult,
} from "../types";
import type { TenantClient } from "@whatsapp-saas/wapi-db";
import type { Tenant } from "@/core/tenants/types";
import { parseSalonConfig } from "./config";
import { buildSalonSystemPrompt } from "./prompt";
import { extractBooking, recordBooking } from "./bookings";
import { extractInteractive } from "./interactive";
import { handleOwnerInbound, notifyOwner } from "./owner-flow";

export const salonSegment: Segment = {
  name: "salon",

  buildSystemPrompt(ctx: SegmentContext): string {
    const cfg = parseSalonConfig(ctx.tenant.config, ctx.tenant.id);
    return buildSalonSystemPrompt({
      cfg,
      tenantTimezone: ctx.tenant.timezone,
      now: ctx.now,
      customer: {
        name: ctx.user.name,
        isReturning: ctx.user.isReturning,
        lastBookingService: ctx.user.lastBookingService,
      },
    });
  },

  async onAgentReply(ctx: SegmentContext, replyText: string): Promise<ReplyHookResult> {
    const cfg = parseSalonConfig(ctx.tenant.config, ctx.tenant.id);

    const afterBooking = extractBooking(replyText);
    let recordedBookingId: string | null = null;
    if (afterBooking.booking) {
      try {
        recordedBookingId = await recordBooking(ctx.tc, {
          userId: ctx.user.id,
          conversationId: ctx.conversation.id,
          booking: afterBooking.booking,
        });
        logger.info("salon_booking_captured", {
          conversationId: ctx.conversation.id,
          service: afterBooking.booking.service,
        });
      } catch (err) {
        // Never block the reply over a booking insert failure — log + move on.
        logger.error("salon_booking_insert_failed", {
          conversationId: ctx.conversation.id,
          error: (err as Error).message,
        });
      }

      if (recordedBookingId) {
        // Fire-and-forget owner notification. Don't await — the customer's
        // reply shouldn't wait on a separate WhatsApp send to the owner.
        notifyOwner({
          cfg,
          booking: {
            id: recordedBookingId,
            customerName: afterBooking.booking.name,
            serviceId: afterBooking.booking.service,
            date: afterBooking.booking.date,
            time: afterBooking.booking.time,
            notes: afterBooking.booking.notes,
          },
          customerWaId: ctx.user.waId,
        }).catch((err) => {
          logger.error("owner_notify_unhandled", { error: (err as Error).message });
        });
      }
    }

    const afterInteractive = extractInteractive(afterBooking.cleanText);
    const result: ReplyHookResult = { cleanText: afterInteractive.cleanText };
    if (afterInteractive.interactive) {
      result.interactive = afterInteractive.interactive;
      logger.info("salon_interactive_attached", {
        conversationId: ctx.conversation.id,
        kind: afterInteractive.interactive.kind,
      });
    }
    return result;
  },

  async tryHandleOwnerInbound(
    ctx: { tc: TenantClient; tenant: Tenant; now: Date },
    inbound: OwnerInbound,
  ): Promise<OwnerHookResult> {
    return handleOwnerInbound(ctx, inbound);
  },
};
