/**
 * Send `hello_world` template to every eligible tester pulled from Supabase.
 *
 * Eligibility filters:
 *   - Real Indian numbers (wa_id starts with `91`)
 *   - Excludes US numbers (rule C3: no marketing to +1)
 *   - Excludes the synthetic `919999999999` smoke-test row
 *
 * Per-recipient outcome is printed. Common error codes:
 *   131030  Recipient not in test-number allowlist (need to add in App Dashboard)
 *   131026  Receiver incapable (number not on WhatsApp)
 *
 * Usage:
 *   npx tsx scripts/send-smoke-test-all.ts
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

function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`missing env: ${key}`);
  return v;
}

type UserRow = { wa_id: string; name: string | null };

async function loadRecipients(): Promise<UserRow[]> {
  const res = await fetch(
    `${SUPA_URL}/rest/v1/users?select=wa_id,name&order=last_seen.desc`,
    { headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` } },
  );
  if (!res.ok) throw new Error(`supabase HTTP ${res.status}: ${await res.text()}`);
  const rows = (await res.json()) as UserRow[];
  return rows
    .filter((r) => r.wa_id.startsWith("91"))
    .filter((r) => !r.wa_id.startsWith("9199999999"));
}

type SendResult =
  | { kind: "ok"; wa_message_id: string }
  | { kind: "err"; code: number; subcode?: number; message: string };

async function sendOne(to: string): Promise<SendResult> {
  const url = `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "template",
    template: { name: "hello_world", language: { code: "en_US" } },
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = (await res.json()) as
    | { messages?: Array<{ id?: string }> }
    | { error: { code: number; error_subcode?: number; message: string } };
  if (!res.ok || "error" in json) {
    const e = (json as { error: { code: number; error_subcode?: number; message: string } }).error;
    return { kind: "err", code: e.code, subcode: e.error_subcode, message: e.message };
  }
  const id = json.messages?.[0]?.id;
  if (!id) return { kind: "err", code: -1, message: "no message id returned" };
  return { kind: "ok", wa_message_id: id };
}

async function main(): Promise<void> {
  console.log(`Loading testers from Supabase...`);
  const recipients = await loadRecipients();
  if (!recipients.length) {
    console.log("No eligible recipients found.");
    return;
  }
  console.log(`Sending hello_world to ${recipients.length} tester(s):\n`);

  let ok = 0;
  let err = 0;
  for (const r of recipients) {
    const result = await sendOne(r.wa_id);
    const name = r.name ?? "(unset)";
    if (result.kind === "ok") {
      ok++;
      console.log(`  ✓ ${r.wa_id}  ${name}  wa_message_id=${result.wa_message_id}`);
    } else {
      err++;
      const codeStr = result.subcode ? `${result.code}/${result.subcode}` : `${result.code}`;
      console.log(`  ✗ ${r.wa_id}  ${name}  code=${codeStr}: ${result.message}`);
    }
  }
  console.log(`\nResult: ${ok} sent, ${err} failed`);
  if (err > 0) {
    console.log(
      `Hint: code 131030 = recipient not in test-number allowlist (Meta App Dashboard → WhatsApp → API Setup → "To" list).`,
    );
  }
}

main().catch((err) => {
  console.error(`\nERROR: ${(err as Error).message}`);
  process.exit(1);
});
