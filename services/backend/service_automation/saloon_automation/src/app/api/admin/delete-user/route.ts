/**
 * GDPR delete — wipe one user's PII for a tenant.
 *
 * Cascade deletes conversations + messages + bookings via the FK chain
 * defined in supabase/migrations/0001_init.sql. The webhook_events table is
 * NOT touched (raw payloads are retained for audit; they're tenant-scoped
 * and the email-equivalent — wa_id — can be hashed in a follow-up sweep).
 *
 * Auth: Bearer ADMIN_API_KEY. Required fields: tenantId, waId.
 *
 *   curl -X POST $URL/api/admin/delete-user \
 *     -H "Authorization: Bearer $ADMIN_API_KEY" \
 *     -H "Content-Type: application/json" \
 *     -d '{"tenantId":"...","waId":"4477..."}'
 */
import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizeAdmin } from "@/core/admin/auth";
import { audit } from "@/core/admin/audit";
import { runWithContext } from "@/core/context";
import { tenantClient } from "@whatsapp-saas/wapi-db";
import { logger } from "@/core/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  tenantId: z.string().uuid(),
  waId: z.string().min(1),
});

export async function POST(req: Request) {
  return runWithContext({ requestId: crypto.randomUUID() }, async () => {
    const auth = authorizeAdmin(req);
    if (!auth.ok) return new NextResponse(auth.body, { status: auth.status });

    let parsed;
    try {
      parsed = Body.parse(await req.json());
    } catch (err) {
      return NextResponse.json({ error: "bad request", detail: (err as Error).message }, { status: 400 });
    }

    const tc = tenantClient(parsed.tenantId);
    const { data: user, error: userErr } = await tc
      .from("users")
      .select("id")
      .eq("wa_id", parsed.waId)
      .maybeSingle();
    if (userErr) {
      logger.error("gdpr_delete_user_lookup_failed", { error: userErr.message });
      return NextResponse.json({ error: "lookup failed" }, { status: 500 });
    }
    if (!user) {
      return NextResponse.json({ deleted: false, reason: "user not found" }, { status: 404 });
    }

    const userId = (user as unknown as { id: string }).id;
    const { error: delErr } = await tc.from("users").delete().eq("id", userId);
    if (delErr) {
      logger.error("gdpr_delete_failed", { userId, error: delErr.message });
      return NextResponse.json({ error: "delete failed" }, { status: 500 });
    }

    await audit({
      tenantId: parsed.tenantId,
      actor: `admin:${auth.keyHint}`,
      action: "gdpr_delete",
      target: userId,
      details: { waId: parsed.waId },
    });
    return NextResponse.json({ deleted: true, userId });
  });
}
