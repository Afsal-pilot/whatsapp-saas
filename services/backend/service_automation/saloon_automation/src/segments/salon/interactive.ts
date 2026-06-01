/**
 * Parse Claude's `[INTERACTIVE] {json}` marker into a typed payload.
 *
 * Contract: the model ends an otherwise-normal reply with a single line:
 *
 *   [INTERACTIVE] {"kind":"buttons","body":"...","buttons":[{"id":"...","title":"..."}]}
 *   [INTERACTIVE] {"kind":"list","body":"...","buttonText":"Browse","sections":[...]}
 *
 * The line is stripped from the user-facing text; the rest of the reply
 * (greeting, context) is sent as the interactive message's `body`.
 *
 * Validation here mirrors Meta's hard limits so a bad model output fails
 * loudly at parse time rather than at the WhatsApp API.
 */
import { z } from "zod";
import { logger } from "@/core/logger";
import type { ButtonsPayload, ListPayload } from "@whatsapp-saas/wapi-meta";

export const INTERACTIVE_MARKER = "[INTERACTIVE]";

// Meta limits (kept here so the prompt and parser stay in sync).
export const LIMITS = {
  BODY_MAX:        1024,
  HEADER_MAX:      60,
  FOOTER_MAX:      60,
  BUTTON_TITLE:    20,
  LIST_BUTTON:     20,
  ROW_TITLE:       24,
  ROW_DESCRIPTION: 72,
  ROWS_MAX:        10,
  BUTTONS_MAX:     3,
  ID_MAX:          200,
} as const;

const ButtonSchema = z.object({
  id:    z.string().min(1).max(LIMITS.ID_MAX),
  title: z.string().min(1).max(LIMITS.BUTTON_TITLE),
});

const RowSchema = z.object({
  id:          z.string().min(1).max(LIMITS.ID_MAX),
  title:       z.string().min(1).max(LIMITS.ROW_TITLE),
  description: z.string().max(LIMITS.ROW_DESCRIPTION).optional(),
});

const SectionSchema = z.object({
  title: z.string().max(LIMITS.HEADER_MAX).optional(),
  rows:  z.array(RowSchema).min(1).max(LIMITS.ROWS_MAX),
});

const ButtonsMarkerSchema = z.object({
  kind:    z.literal("buttons"),
  body:    z.string().min(1).max(LIMITS.BODY_MAX),
  header:  z.string().max(LIMITS.HEADER_MAX).optional(),
  footer:  z.string().max(LIMITS.FOOTER_MAX).optional(),
  buttons: z.array(ButtonSchema).min(1).max(LIMITS.BUTTONS_MAX),
});

const ListMarkerSchema = z.object({
  kind:       z.literal("list"),
  body:       z.string().min(1).max(LIMITS.BODY_MAX),
  buttonText: z.string().min(1).max(LIMITS.LIST_BUTTON),
  sections:   z.array(SectionSchema).min(1),
  header:     z.string().max(LIMITS.HEADER_MAX).optional(),
  footer:     z.string().max(LIMITS.FOOTER_MAX).optional(),
});

const MarkerSchema = z.discriminatedUnion("kind", [ButtonsMarkerSchema, ListMarkerSchema]);

export type InteractiveMarker = z.infer<typeof MarkerSchema>;

export type ParsedInteractive =
  | { kind: "buttons"; payload: ButtonsPayload }
  | { kind: "list";    payload: ListPayload };

/**
 * Pull the [INTERACTIVE] line off the reply, parse the JSON, validate.
 *
 * Returns `interactive=null` for any of:
 *   - no marker present
 *   - marker JSON unparseable
 *   - validation failed (e.g. > 3 buttons, > 10 rows, oversized titles)
 *
 * In the failure case we log the issue and the `cleanText` still has the
 * marker stripped — the model's prose still goes out as a plain text reply.
 */
export function extractInteractive(replyText: string): {
  cleanText: string;
  interactive: ParsedInteractive | null;
} {
  const idx = replyText.indexOf(INTERACTIVE_MARKER);
  if (idx === -1) return { cleanText: replyText, interactive: null };

  // The marker occupies its own line (model is instructed to end with it).
  const lineEnd = replyText.indexOf("\n", idx);
  const markerLine =
    lineEnd === -1 ? replyText.slice(idx) : replyText.slice(idx, lineEnd);
  const cleanText = (
    replyText.slice(0, idx) +
    (lineEnd === -1 ? "" : replyText.slice(lineEnd + 1))
  ).trim();

  const jsonPart = markerLine.slice(INTERACTIVE_MARKER.length).trim();
  if (!jsonPart) {
    logger.warn("interactive_marker_empty", { markerLine });
    return { cleanText, interactive: null };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(jsonPart);
  } catch (err) {
    logger.warn("interactive_marker_bad_json", {
      error: (err as Error).message,
      jsonPart: jsonPart.slice(0, 200),
    });
    return { cleanText, interactive: null };
  }

  const parsed = MarkerSchema.safeParse(raw);
  if (!parsed.success) {
    logger.warn("interactive_marker_invalid", {
      issues: parsed.error.flatten(),
    });
    return { cleanText, interactive: null };
  }

  return { cleanText, interactive: toPayload(parsed.data) };
}

function toPayload(m: InteractiveMarker): ParsedInteractive {
  if (m.kind === "buttons") {
    return {
      kind: "buttons",
      payload: {
        body: m.body,
        buttons: m.buttons,
        ...(m.header ? { header: m.header } : {}),
        ...(m.footer ? { footer: m.footer } : {}),
      },
    };
  }
  return {
    kind: "list",
    payload: {
      body: m.body,
      buttonText: m.buttonText,
      sections: m.sections,
      ...(m.header ? { header: m.header } : {}),
      ...(m.footer ? { footer: m.footer } : {}),
    },
  };
}
