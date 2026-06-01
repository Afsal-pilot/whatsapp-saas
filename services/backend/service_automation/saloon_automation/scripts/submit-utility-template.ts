/**
 * Submit a UTILITY template to the pilot WABA.
 *
 * Utility templates approve much faster than marketing (typically <30 min),
 * letting us test the full sender pipeline end-to-end with a real custom
 * template + variables, instead of being blocked on marketing review.
 *
 * Idempotent: skips submission if a template with the same name already exists.
 *
 * Usage:
 *   npx tsx scripts/submit-utility-template.ts
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
const SUPA_URL = required("SUPABASE_URL");
const SUPA_KEY = required("SUPABASE_SERVICE_ROLE_KEY");

function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`missing env: ${key}`);
  return v;
}

const UTILITY_TEMPLATE = {
  name: "pilot_appointment_reminder",
  category: "UTILITY",
  language: "en_US",
  components: [
    {
      type: "BODY",
      text: "Hi {{1}}, this is a reminder of your appointment at {{2}} on {{3}}. Reply if you need to reschedule.",
      example: {
        body_text: [["Priya", "Glow Hair Studio", "30 Jun 2026, 3:00 PM"]],
      },
    },
  ],
};

async function resolveWabaId(): Promise<string> {
  if (process.env.WABA_ID) return process.env.WABA_ID;
  const res = await fetch(
    `${SUPA_URL}/rest/v1/webhook_events?select=payload&order=received_at.desc&limit=10`,
    { headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` } },
  );
  if (!res.ok) throw new Error(`supabase HTTP ${res.status}: ${await res.text()}`);
  const rows = (await res.json()) as Array<{ payload?: { entry?: Array<{ id?: string }> } }>;
  for (const r of rows) {
    const id = r.payload?.entry?.[0]?.id;
    if (id) return id;
  }
  throw new Error("no WABA_ID and no recent webhook_events");
}

type ListResp<T> = { data: T[] };
type TemplateRow = { name: string; language: string; status: string; category: string };

async function findExisting(wabaId: string, name: string): Promise<TemplateRow | null> {
  const url = `https://graph.facebook.com/${API_VERSION}/${wabaId}/message_templates?name=${encodeURIComponent(name)}&fields=name,language,status,category&limit=10`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`list HTTP ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as ListResp<TemplateRow>;
  return body.data.find((t) => t.name === name) ?? null;
}

async function submit(wabaId: string): Promise<void> {
  const url = `https://graph.facebook.com/${API_VERSION}/${wabaId}/message_templates`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(UTILITY_TEMPLATE),
  });
  const json = (await res.json()) as
    | { id?: string; status?: string; category?: string }
    | { error: { code: number; error_subcode?: number; message: string } };
  if (!res.ok || "error" in json) {
    const e = (json as { error: { code: number; error_subcode?: number; message: string } }).error;
    throw new Error(
      `submit failed: code=${e.code}${e.error_subcode ? `/${e.error_subcode}` : ""} message=${e.message}`,
    );
  }
  console.log(
    `  Submitted: id=${(json as { id: string }).id}, status=${(json as { status: string }).status}, category=${(json as { category: string }).category}`,
  );
}

async function main(): Promise<void> {
  console.log(`Graph API version: ${API_VERSION}`);
  const wabaId = await resolveWabaId();
  console.log(`Target WABA: ${wabaId}\n`);
  console.log(`Template: ${UTILITY_TEMPLATE.name} (${UTILITY_TEMPLATE.category}, ${UTILITY_TEMPLATE.language})`);

  const existing = await findExisting(wabaId, UTILITY_TEMPLATE.name);
  if (existing) {
    console.log(`  Already exists — status=${existing.status}. Skipping submission.`);
    return;
  }
  await submit(wabaId);
  console.log(`\nDone. Re-run scripts/discover-waba.ts to watch PENDING -> APPROVED (usually <30 min for UTILITY).`);
}

main().catch((err) => {
  console.error(`\nERROR: ${(err as Error).message}`);
  process.exit(1);
});
