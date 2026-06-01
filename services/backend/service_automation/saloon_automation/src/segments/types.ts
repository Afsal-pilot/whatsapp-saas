/**
 * Segment contract.
 *
 * A "segment" is a vertical (salon, restaurant, clinic, retail, …). One
 * codebase, many segments — each tenant picks one via `tenants.segment`.
 *
 * Implement this interface to add a new vertical:
 *   1. Create `src/segments/<name>/index.ts` exporting a `Segment` object.
 *   2. Register it in `src/segments/index.ts`.
 *   3. Add the name to the CHECK constraint in tenants migration.
 *   4. (Optional) Add segment-specific tables under supabase/migrations/.
 *
 * Keep the surface small. If a segment needs more than `buildSystemPrompt`
 * + `onAgentReply`, add a capability to this interface only after a second
 * segment also needs it.
 */
import type { ChatMessage } from "@/core/clients/claude";
import type { TenantClient } from "@whatsapp-saas/wapi-db";
import type { Tenant } from "@/core/tenants/types";
import type { ButtonsPayload, ListPayload } from "@whatsapp-saas/wapi-meta";

export type SegmentContext = {
  tenant: Tenant;
  /** Tenant-scoped Supabase client. Use this for all DB writes in segment code. */
  tc: TenantClient;
  user: {
    id: string;
    name: string | null;
    waId: string;
    /** True when this user has chatted with us before (last_seen > created_at + 30 min). */
    isReturning: boolean;
    /**
     * Title of the most-recent completed/confirmed/requested service for
     * this user (lower-case). Useful for "want another haircut?" style
     * prompts on returning customers. null when there's no booking history.
     */
    lastBookingService: string | null;
  };
  conversation: { id: string };
  /**
   * Wall-clock time at the start of this turn. The processor sets this once
   * per request so prompt builders can format tz-aware dates ("today is …")
   * without each one re-computing. Tests inject a fixed value.
   */
  now: Date;
};

export type AgentRunInput = {
  history: ChatMessage[];
  userMessage: string;
};

export type AgentRunResult = {
  text: string;
  usage?: Record<string, unknown>;
};

export type InteractiveReply =
  | { kind: "buttons"; payload: ButtonsPayload }
  | { kind: "list";    payload: ListPayload };

export type ReplyHookResult = {
  /** Text actually sent to WhatsApp (markers stripped, etc.). */
  cleanText: string;
  /**
   * Optional interactive companion. When set, the processor sends the
   * interactive message INSTEAD of `cleanText` — Meta's interactive types
   * already include a body field that carries the conversational prose.
   */
  interactive?: InteractiveReply;
};

export type OwnerInbound = {
  /** Sender's WhatsApp id (digits only). */
  from: string;
  /** Meta wa_message_id of the inbound. */
  id: string;
  /** Displayed text (button title or list row title). */
  text: string;
  /** Structured payload when the inbound was an interactive tap. */
  interactive?: { type: "button_reply" | "list_reply"; id: string };
};

export type OwnerHookResult = {
  /** True when the segment recognised this inbound and acted on it. */
  handled: boolean;
};

export interface Segment {
  readonly name: string;

  /**
   * Build the system prompt for this tenant. Called once per inbound message.
   * Read everything you need from `ctx.tenant.config`.
   */
  buildSystemPrompt(ctx: SegmentContext): string;

  /**
   * Optional post-processing hook. Use this to:
   *   - extract structured data from the reply (e.g. booking markers)
   *   - strip those markers from the text that gets sent to the user
   *   - persist segment-specific rows (bookings, orders, leads, ...)
   *
   * If not implemented, the raw agent reply is sent verbatim.
   */
  onAgentReply?(ctx: SegmentContext, replyText: string): Promise<ReplyHookResult>;

  /**
   * Optional pre-empt hook for inbound messages from the salon's OWNER (not
   * a customer). The processor calls this BEFORE customer flow. If the hook
   * returns `{ handled: true }`, the processor short-circuits: no agent
   * call, no outbound to the customer. The hook itself is responsible for
   * any outbound (e.g. customer-facing confirmation).
   *
   * Use this for operator workflows like Confirm/Reject on a fresh booking.
   */
  tryHandleOwnerInbound?(
    ctx: { tc: TenantClient; tenant: Tenant; now: Date },
    inbound: OwnerInbound,
  ): Promise<OwnerHookResult>;
}
