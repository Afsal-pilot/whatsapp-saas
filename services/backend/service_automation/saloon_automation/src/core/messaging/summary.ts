/**
 * Rolling conversation summary.
 *
 * History context to Claude is capped at the last N turns. For long-running
 * chats, important facts drop off the window — name, allergies, the service
 * they originally asked about. We keep a single-paragraph summary in
 * `conversations.summary` and refresh it every `SUMMARY_REFRESH_AFTER_TURNS`
 * messages. The summary gets prepended to the system prompt on each call.
 *
 * Refresh runs INLINE on the inbound request (cheap Haiku call, ~300 ms).
 * If the summary call itself fails we log and move on — the reply still
 * goes out with the recent window only.
 */
import { complete, type ChatMessage } from "@/core/clients/claude";
import type { TenantClient } from "@whatsapp-saas/wapi-db";
import { updateConversationSummary } from "./conversations";
import { logger } from "@/core/logger";

const SUMMARY_MODEL = "claude-haiku-4-5-20251001";

export async function maybeRefreshSummary(
  tc: TenantClient,
  conversationId: string,
  history: ChatMessage[],
  prevSummary: string | null,
): Promise<void> {
  if (history.length < 4) return;
  try {
    const system = `Summarize this WhatsApp chat in 2-3 short sentences.
Capture: customer name, any service they asked about, dates/times mentioned,
allergies or constraints, escalation flags. Skip pleasantries.
Update — do not replace — the prior summary if facts have changed.`;
    const prior = prevSummary ? `Prior summary: ${prevSummary}\n\n` : "";
    const transcript = history
      .map((m) => `${m.role === "user" ? "Customer" : "Agent"}: ${m.content}`)
      .join("\n");
    const res = await complete({
      system,
      messages: [{ role: "user", content: `${prior}Transcript:\n${transcript}` }],
      model: SUMMARY_MODEL,
      maxTokens: 200,
    });
    const summary = res.text.trim();
    if (!summary) return;
    await updateConversationSummary(tc, conversationId, summary);
  } catch (err) {
    logger.warn("summary_refresh_failed", { error: (err as Error).message });
  }
}
