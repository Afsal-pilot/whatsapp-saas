/**
 * Cross-tenant isolation test for the shared WAPI schema.
 *
 * Proves that data written via `tenantClient(A)` is invisible to
 * `tenantClient(B)`. If this ever fails, isolation is broken — stop the
 * line, do not deploy.
 *
 * Lives at the monorepo root because the schema (supabase/migrations/) and
 * the client (@whatsapp-saas/wapi-db) are both shared across services. The
 * test belongs with what it tests, not with any one service.
 *
 * What it does:
 *   1. Creates two scratch tenants (A, B) with random phone_number_ids.
 *   2. Through tenantClient(A): inserts a user + conversation + message +
 *      template + campaign + campaign_recipient + consent_event +
 *      billing_ledger_entry.
 *   3. Through tenantClient(B): runs the same selects.
 *   4. Asserts B sees zero rows from A's data on every table.
 *   5. Verifies the counter trigger fired (campaigns.total_recipients=1).
 *   6. Asserts the wrapper overrides a caller-supplied tenant_id (anti-spoof).
 *   7. Cleans up.
 *
 * Run from the monorepo root:
 *   npx tsx scripts/test-tenant-isolation.ts
 *
 * Env: requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. The script will
 * auto-load them from .env.local — searches the cwd, then walks up, then
 * falls back to known service-local .env.local files.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import crypto from "node:crypto";

const KNOWN_ENV_LOCATIONS = [
  "services/backend/service_automation/saloon_automation/.env.local",
];

function findEnvFile(): string {
  // 1) walk up from cwd
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(dir, ".env.local");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // 2) check known service-local fallbacks relative to cwd
  for (const rel of KNOWN_ENV_LOCATIONS) {
    const candidate = resolve(process.cwd(), rel);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    ".env.local not found. Run from a directory containing it, or from the monorepo root (auto-falls-back to services/backend/service_automation/saloon_automation/.env.local).",
  );
}

function loadEnv(): void {
  const path = findEnvFile();
  const text = readFileSync(path, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    value = value.replace(/^["']|["']$/g, "");
    const commentIdx = value.indexOf(" #");
    if (commentIdx !== -1) value = value.slice(0, commentIdx).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}
loadEnv();

const fail = (msg: string) => { console.error(`✗ ${msg}`); process.exit(1); };
const ok   = (msg: string) => console.log(`✓ ${msg}`);

// Import AFTER env is loaded — the wapi-db module reads env on first use.
type WapiDb = typeof import("@whatsapp-saas/wapi-db");
let mod: WapiDb;
let sb: ReturnType<WapiDb["supabase"]>;

async function createScratchTenant(label: string) {
  const phone = `TEST_${label}_${crypto.randomUUID().slice(0, 8)}`;
  const { data, error } = await sb
    .from("tenants")
    .insert({
      name: `iso-test-${label}`,
      segment: "salon",
      config: {},
      phone_number_id: phone,
    })
    .select("id, phone_number_id")
    .single();
  if (error) throw new Error(`scratch tenant ${label}: ${error.message}`);
  return data as { id: string; phone_number_id: string };
}

async function deleteTenant(id: string) {
  await sb.from("tenants").delete().eq("id", id);
}

async function main() {
  mod = await import("@whatsapp-saas/wapi-db");
  sb = mod.supabase();

  console.log("Creating two scratch tenants…");
  const A = await createScratchTenant("A");
  const B = await createScratchTenant("B");
  ok(`A=${A.id}  B=${B.id}`);

  const tcA = mod.tenantClient(A.id);
  const tcB = mod.tenantClient(B.id);

  try {
    // 1. Insert A's user + conversation + message via tcA.
    const userA = await tcA.from("users").insert({
      wa_id: `iso-A-${Date.now()}`, name: "A-user",
    }).select("id").single();
    if (userA.error) fail(`insert userA: ${userA.error.message}`);

    const convA = await tcA.from("conversations").insert({
      user_id: (userA.data as { id: string }).id, status: "active",
    }).select("id").single();
    if (convA.error) fail(`insert convA: ${convA.error.message}`);

    const msgA = await tcA.from("messages").insert({
      conversation_id: (convA.data as { id: string }).id,
      wa_message_id: `iso-A-${crypto.randomUUID()}`,
      direction: "in", sender_type: "user", content_type: "text",
      text: "hello from A",
    }).select("id").single();
    if (msgA.error) fail(`insert msgA: ${msgA.error.message}`);

    ok("inserted user/conv/msg as A");

    // 2. Through tcB: same selects, expect zero rows.
    const usersAsB = await tcB.from("users").select("id");
    if (usersAsB.error) fail(`select users as B: ${usersAsB.error.message}`);
    const usersAsBCount = (usersAsB.data ?? []).length;
    if (usersAsBCount !== 0) fail(`B sees ${usersAsBCount} users (expected 0) — LEAK`);
    ok("B sees zero users");

    const convsAsB = await tcB.from("conversations").select("id");
    if (convsAsB.error) fail(`select convs as B: ${convsAsB.error.message}`);
    if ((convsAsB.data ?? []).length !== 0) fail(`B sees ${(convsAsB.data ?? []).length} conversations — LEAK`);
    ok("B sees zero conversations");

    const msgsAsB = await tcB.from("messages").select("id");
    if (msgsAsB.error) fail(`select msgs as B: ${msgsAsB.error.message}`);
    if ((msgsAsB.data ?? []).length !== 0) fail(`B sees ${(msgsAsB.data ?? []).length} messages — LEAK`);
    ok("B sees zero messages");

    // 3. Verify A can still see A's data.
    const usersAsA = await tcA.from("users").select("id");
    if ((usersAsA.data ?? []).length === 0) fail("A sees zero users — wrapper too aggressive?");
    ok(`A sees ${(usersAsA.data ?? []).length} of its users`);

    // 4. Sanity: raw client (admin) sees both rows.
    const allUsers = await sb.from("users").select("id, tenant_id")
      .in("tenant_id", [A.id, B.id]);
    if (allUsers.error) fail(`raw select: ${allUsers.error.message}`);
    if ((allUsers.data ?? []).length !== 1) fail(`raw client sees ${(allUsers.data ?? []).length} test users (expected 1)`);
    ok("raw client sees the row (escape hatch works)");

    // 5. Tenant-id injection on insert: prove wrapper overrides a wrong id.
    const sneak = await tcB.from("users").insert({
      wa_id: `iso-sneak-${Date.now()}`, name: "sneak",
      tenant_id: A.id, // attempt to write into A from tcB
    }).select("tenant_id").single();
    if (sneak.error) fail(`sneak insert: ${sneak.error.message}`);
    const writtenTenant = (sneak.data as { tenant_id: string }).tenant_id;
    if (writtenTenant !== B.id) fail(`wrapper let a foreign tenant_id through: wrote ${writtenTenant}, expected ${B.id}`);
    ok("wrapper overrides caller-supplied tenant_id");

    // ─── Campaign tables (migrations 0009–0017) ──────────────────────────────

    // 6. templates
    const tplA = await tcA.from("templates").insert({
      meta_template_name: `iso_tpl_${Date.now()}`,
      language: "en_US",
      category: "MARKETING",
      status: "draft",
      body_text: "Hi {{1}}, test template",
      created_by: "iso-test",
    }).select("id").single();
    if (tplA.error) fail(`insert templateA: ${tplA.error.message}`);
    const tplAId = (tplA.data as { id: string }).id;
    ok("inserted template as A");

    const tplsAsB = await tcB.from("templates").select("id");
    if (tplsAsB.error) fail(`select templates as B: ${tplsAsB.error.message}`);
    if ((tplsAsB.data ?? []).length !== 0) fail(`B sees ${(tplsAsB.data ?? []).length} templates — LEAK`);
    ok("B sees zero templates");

    // 7. campaigns
    const campA = await tcA.from("campaigns").insert({
      template_id: tplAId,
      name: "iso-test-campaign",
      audience_definition: { kind: "filter", filter: {} },
      variable_mapping: { "1": "$user.name" },
      timezone: "Asia/Kolkata",
      created_by: "iso-test",
    }).select("id").single();
    if (campA.error) fail(`insert campaignA: ${campA.error.message}`);
    const campAId = (campA.data as { id: string }).id;
    ok("inserted campaign as A");

    const campsAsB = await tcB.from("campaigns").select("id");
    if (campsAsB.error) fail(`select campaigns as B: ${campsAsB.error.message}`);
    if ((campsAsB.data ?? []).length !== 0) fail(`B sees ${(campsAsB.data ?? []).length} campaigns — LEAK`);
    ok("B sees zero campaigns");

    // 8. campaign_recipients
    const recipA = await tcA.from("campaign_recipients").insert({
      campaign_id: campAId,
      wa_id: `iso-recip-${Date.now()}`,
      template_vars: { "1": "A-user" },
      status: "pending",
    }).select("id").single();
    if (recipA.error) fail(`insert campaign_recipientA: ${recipA.error.message}`);
    ok("inserted campaign_recipient as A");

    const recipsAsB = await tcB.from("campaign_recipients").select("id");
    if (recipsAsB.error) fail(`select campaign_recipients as B: ${recipsAsB.error.message}`);
    if ((recipsAsB.data ?? []).length !== 0) fail(`B sees ${(recipsAsB.data ?? []).length} campaign_recipients — LEAK`);
    ok("B sees zero campaign_recipients");

    // 9. consent_events
    const consentA = await tcA.from("consent_events").insert({
      wa_id: `iso-consent-${Date.now()}`,
      event_type: "opt_in",
      category: "marketing",
      source: "iso_test",
      source_payload: { test: true },
      business_name_shown: "iso-test-A",
    }).select("id").single();
    if (consentA.error) fail(`insert consent_eventA: ${consentA.error.message}`);
    ok("inserted consent_event as A");

    const consentsAsB = await tcB.from("consent_events").select("id");
    if (consentsAsB.error) fail(`select consent_events as B: ${consentsAsB.error.message}`);
    if ((consentsAsB.data ?? []).length !== 0) fail(`B sees ${(consentsAsB.data ?? []).length} consent_events — LEAK`);
    ok("B sees zero consent_events");

    // 10. billing_ledger_entries
    const ledgerA = await tcA.from("billing_ledger_entries").insert({
      campaign_id: campAId,
      type: "reservation",
      amount_cents: 12000,
      currency: "INR",
      status: "pending",
      description: "iso-test",
    }).select("id").single();
    if (ledgerA.error) fail(`insert billing_ledger_entryA: ${ledgerA.error.message}`);
    ok("inserted billing_ledger_entry as A");

    const ledgersAsB = await tcB.from("billing_ledger_entries").select("id");
    if (ledgersAsB.error) fail(`select billing_ledger_entries as B: ${ledgersAsB.error.message}`);
    if ((ledgersAsB.data ?? []).length !== 0) fail(`B sees ${(ledgersAsB.data ?? []).length} billing_ledger_entries — LEAK`);
    ok("B sees zero billing_ledger_entries");

    // 11. Sanity: trigger fired — campaigns.total_recipients should be 1.
    const counterCheck = await tcA.from("campaigns").select("total_recipients").eq("id", campAId).single();
    if (counterCheck.error) fail(`select campaign counter: ${counterCheck.error.message}`);
    const total = (counterCheck.data as { total_recipients: number }).total_recipients;
    if (total !== 1) fail(`expected total_recipients=1 after one recipient insert, got ${total}`);
    ok("campaign_counters_apply trigger fired (total_recipients=1)");

    console.log("");
    console.log("All isolation assertions passed.");
  } finally {
    console.log("");
    console.log("Cleaning up scratch tenants…");
    // CASCADE on tenants → wipes users → wipes conversations → wipes messages.
    await deleteTenant(A.id);
    await deleteTenant(B.id);
    ok("cleaned up");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
