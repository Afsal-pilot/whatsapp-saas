/**
 * Send the UTILITY template `pilot_appointment_reminder` to one recipient.
 *
 * Unlike send-pilot-campaign.ts this skips the APPROVED status check, so it
 * will also surface Meta's response if the template is still PENDING — useful
 * to confirm exactly which error code comes back.
 *
 * Usage:
 *   npx tsx scripts/send-utility-test.ts <wa_id> [name]
 *
 * Example:
 *   npx tsx scripts/send-utility-test.ts 919840675929 Afsal
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

function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`missing env: ${key}`);
  return v;
}

async function main(): Promise<void> {
  const to = process.argv[2];
  const name = process.argv[3] ?? "there";
  if (!to) {
    console.error("Usage: npx tsx scripts/send-utility-test.ts <wa_id> [name]");
    process.exit(2);
  }

  const url = `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "template",
    template: {
      name: "pilot_appointment_reminder",
      language: { code: "en_US" },
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: name },
            { type: "text", text: "Glow Hair Studio" },
            { type: "text", text: "30 Jun 2026, 3:00 PM" },
          ],
        },
      ],
    },
  };

  console.log(`POST ${url}`);
  console.log(`  to=${to}, template=pilot_appointment_reminder, lang=en_US`);
  console.log(`  vars: ["${name}", "Glow Hair Studio", "30 Jun 2026, 3:00 PM"]`);

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = (await res.json()) as
    | { messages?: Array<{ id?: string }>; contacts?: Array<{ wa_id?: string }> }
    | { error: { code: number; error_subcode?: number; message: string; error_data?: { details?: string } } };

  if (!res.ok || "error" in json) {
    const e = (json as { error: { code: number; error_subcode?: number; message: string; error_data?: { details?: string } } }).error;
    console.error(`\nFAILED — HTTP ${res.status}`);
    console.error(`  code=${e.code}${e.error_subcode ? `/${e.error_subcode}` : ""}`);
    console.error(`  message=${e.message}`);
    if (e.error_data?.details) console.error(`  details=${e.error_data.details}`);
    console.error(`\nExpected if template is still PENDING: code 132000 or 132001 "Template does not exist" / "not approved".`);
    process.exit(1);
  }

  const id = json.messages?.[0]?.id;
  console.log(`\nSENT (unexpected if template was PENDING!)`);
  console.log(`  wa_message_id = ${id}`);
}

main().catch((err) => {
  console.error(`\nERROR: ${(err as Error).message}`);
  process.exit(1);
});
