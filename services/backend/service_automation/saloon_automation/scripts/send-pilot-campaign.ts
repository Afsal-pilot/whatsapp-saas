/**
 * Send the pilot promotional campaign — template message to each recipient.
 *
 * Flow:
 *   1. Verify the named template is APPROVED on the WABA (else bail loudly).
 *   2. Resolve recipients (CLI arg, OR all non-US users in Supabase).
 *   3. For each recipient, POST a template message to the Cloud API.
 *   4. Print per-recipient result: wa_message_id on success, error code on fail.
 *
 * Meta error codes worth knowing here:
 *   131030  Recipient not in allowed list (test-number allowlist gate)
 *   131026  Receiver incapable (number not on WhatsApp, or invalid)
 *   131047  Re-engagement message — should not happen for templates
 *   131049  Frequency cap (>2 marketing/24h) — only after we've already sent
 *
 * Usage:
 *   npx tsx scripts/send-pilot-campaign.ts                    # all eligible users from DB
 *   npx tsx scripts/send-pilot-campaign.ts --dry-run          # print payloads, send nothing
 *   npx tsx scripts/send-pilot-campaign.ts 919840675929,918148741342
 *
 * Env required: META_ACCESS_TOKEN, META_PHONE_NUMBER_ID, SUPABASE_*
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

function findEnvFile(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(dir, ".env.local");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(".env.local not found");
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

const API_VERSION = process.env.META_GRAPH_API_VERSION ?? "v21.0";
const TOKEN = required("META_ACCESS_TOKEN");
const PHONE_NUMBER_ID = required("META_PHONE_NUMBER_ID");
const SUPA_URL = required("SUPABASE_URL");
const SUPA_KEY = required("SUPABASE_SERVICE_ROLE_KEY");

const TEMPLATE_NAME = "pilot_promo_offer";
const TEMPLATE_LANG = "en_US";
const BUSINESS_NAME = "Glow Hair Studio";
const EXPIRY = "30 Jun 2026";

function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`missing env: ${key}`);
  return v;
}

type Args = { dryRun: boolean; explicitRecipients: string[] | null };
function parseArgs(): Args {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const positional = args.filter((a) => !a.startsWith("--"));
  const explicit = positional[0]?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;
  return { dryRun, explicitRecipients: explicit };
}

type Recipient = { wa_id: string; name: string };
type UserRow = { wa_id: string; name: string | null };

async function supaGet<T>(path: string): Promise<T> {
  const res = await fetch(`${SUPA_URL}/rest/v1${path}`, {
    headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` },
  });
  if (!res.ok) throw new Error(`supabase HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

async function resolveRecipients(explicit: string[] | null): Promise<Recipient[]> {
  if (explicit?.length) {
    const csv = explicit.map(encodeURIComponent).join(",");
    const rows = await supaGet<UserRow[]>(`/users?wa_id=in.(${csv})&select=wa_id,name`);
    const byWa = new Map(rows.map((r) => [r.wa_id, r.name ?? "there"]));
    return explicit.map((wa) => ({ wa_id: wa, name: byWa.get(wa) ?? "there" }));
  }
  const rows = await supaGet<UserRow[]>(`/users?select=wa_id,name&order=last_seen.desc`);
  return rows
    .filter((r) => !r.wa_id.startsWith("1"))
    .filter((r) => !r.wa_id.startsWith("9199999999"))
    .map((r) => ({ wa_id: r.wa_id, name: r.name ?? "there" }));
}

type TemplateStatusRow = { name: string; language: string; status: string; category: string };
async function templateStatus(wabaId: string, name: string): Promise<TemplateStatusRow | null> {
  const url = `https://graph.facebook.com/${API_VERSION}/${wabaId}/message_templates?name=${encodeURIComponent(name)}&fields=name,language,status,category&limit=10`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`list templates HTTP ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { data: TemplateStatusRow[] };
  return body.data.find((t) => t.name === name && t.language === TEMPLATE_LANG) ?? null;
}

async function discoverWabaId(): Promise<string> {
  if (process.env.WABA_ID) return process.env.WABA_ID;
  const rows = await supaGet<Array<{ payload?: { entry?: Array<{ id?: string }> } }>>(
    "/webhook_events?select=payload&order=received_at.desc&limit=10",
  );
  for (const r of rows) {
    const id = r.payload?.entry?.[0]?.id;
    if (id) return id;
  }
  throw new Error("no WABA_ID and no recent webhook_events to discover from");
}

type SendOk = { wa_message_id: string; contact_wa_id?: string };
type SendErr = { code: number; subcode?: number; message: string };
type SendResult =
  | { kind: "ok"; result: SendOk }
  | { kind: "err"; error: SendErr };

function templatePayload(r: Recipient): Record<string, unknown> {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: r.wa_id,
    type: "template",
    template: {
      name: TEMPLATE_NAME,
      language: { code: TEMPLATE_LANG },
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: r.name },
            { type: "text", text: BUSINESS_NAME },
            { type: "text", text: EXPIRY },
          ],
        },
      ],
    },
  };
}

async function sendOne(r: Recipient): Promise<SendResult> {
  const url = `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(templatePayload(r)),
  });
  const json = (await res.json()) as
    | { messages?: Array<{ id?: string }>; contacts?: Array<{ wa_id?: string }> }
    | { error: { code: number; error_subcode?: number; message: string } };
  if (!res.ok || "error" in json) {
    const e = (json as { error: { code: number; error_subcode?: number; message: string } }).error;
    return {
      kind: "err",
      error: { code: e.code, subcode: e.error_subcode, message: e.message },
    };
  }
  const id = json.messages?.[0]?.id;
  if (!id) return { kind: "err", error: { code: -1, message: "no message id returned" } };
  return { kind: "ok", result: { wa_message_id: id, contact_wa_id: json.contacts?.[0]?.wa_id } };
}

async function main(): Promise<void> {
  const args = parseArgs();

  console.log(`Pilot campaign — template "${TEMPLATE_NAME}" (lang=${TEMPLATE_LANG})\n`);
  console.log("Step 1: verify template is APPROVED");
  const wabaId = await discoverWabaId();
  const tpl = await templateStatus(wabaId, TEMPLATE_NAME);
  if (!tpl) throw new Error(`template "${TEMPLATE_NAME}" (${TEMPLATE_LANG}) not found on WABA ${wabaId}`);
  console.log(`  status=${tpl.status}, category=${tpl.category}`);
  if (tpl.status !== "APPROVED") {
    if (args.dryRun) {
      console.log(`  (continuing in dry-run despite status=${tpl.status})`);
    } else {
      throw new Error(`template not APPROVED (status=${tpl.status}). Wait for Meta review, then retry.`);
    }
  }

  console.log("\nStep 2: resolve recipients");
  const recipients = await resolveRecipients(args.explicitRecipients);
  if (!recipients.length) throw new Error("no recipients resolved");
  console.log(`  ${recipients.length} recipient(s):`);
  for (const r of recipients) console.log(`    ${r.wa_id}  ${r.name}`);

  console.log(`\nStep 3: send ${args.dryRun ? "(DRY RUN — nothing sent)" : ""}`);
  let ok = 0;
  let err = 0;
  for (const r of recipients) {
    if (args.dryRun) {
      console.log(`  → ${r.wa_id}  ${r.name}  [payload preview]`);
      console.log(`      ${JSON.stringify(templatePayload(r))}`);
      continue;
    }
    const result = await sendOne(r);
    if (result.kind === "ok") {
      ok++;
      console.log(
        `  ✓ ${r.wa_id}  ${r.name}  wa_message_id=${result.result.wa_message_id}`,
      );
    } else {
      err++;
      console.log(
        `  ✗ ${r.wa_id}  ${r.name}  code=${result.error.code}${result.error.subcode ? `/${result.error.subcode}` : ""}: ${result.error.message}`,
      );
    }
  }

  if (!args.dryRun) {
    console.log(`\nResult: ${ok} sent, ${err} failed`);
    if (err > 0) {
      console.log(
        `Hints: code 131030 = recipient not in test-number allowlist (add them in Meta App Dashboard); code 131026 = number not on WhatsApp.`,
      );
    }
  }
}

main().catch((err) => {
  console.error(`\nERROR: ${(err as Error).message}`);
  process.exit(1);
});
