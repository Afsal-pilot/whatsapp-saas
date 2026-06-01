/**
 * Submit a sample MARKETING template to the pilot WABA via Meta Graph API.
 *
 * Why this script exists: the team doesn't have UI access to WhatsApp Manager
 * for the pilot WABA, but the API token with `whatsapp_business_management`
 * permission can create templates directly. Meta reviews + approves in ~1h
 * (same SLA as the UI). Once approved, the template can be sent to the 5
 * registered testers via the existing `messages` endpoint.
 *
 * Idempotent: if a template with the same name already exists, this script
 * exits cleanly with the existing status instead of re-submitting.
 *
 * Usage:
 *   npx tsx scripts/submit-marketing-template.ts
 *
 * Env required: META_ACCESS_TOKEN, META_GRAPH_API_VERSION, plus
 * either WABA_ID or SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY for discovery.
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
  throw new Error(".env.local not found in cwd or any parent directory");
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

function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`missing env: ${key}`);
  return v;
}

async function resolveWabaId(): Promise<string> {
  if (process.env.WABA_ID) return process.env.WABA_ID;
  const supaUrl = process.env.SUPABASE_URL;
  const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supaUrl || !supaKey) {
    throw new Error("WABA_ID not set and SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing");
  }
  const url = `${supaUrl}/rest/v1/webhook_events?select=payload&order=received_at.desc&limit=10`;
  const res = await fetch(url, {
    headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}` },
  });
  if (!res.ok) throw new Error(`supabase HTTP ${res.status}: ${await res.text()}`);
  const rows = (await res.json()) as Array<{ payload?: { entry?: Array<{ id?: string }> } }>;
  for (const r of rows) {
    const id = r.payload?.entry?.[0]?.id;
    if (id) return id;
  }
  throw new Error("no webhook_events rows contain entry[0].id — set WABA_ID env explicitly");
}

type ExistingTemplate = { name: string; language: string; status: string; category: string };
type ListResp<T> = { data: T[] };

async function findExisting(wabaId: string, name: string): Promise<ExistingTemplate | null> {
  const url = `https://graph.facebook.com/${API_VERSION}/${wabaId}/message_templates?name=${encodeURIComponent(name)}&fields=name,language,status,category&limit=10`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`list templates HTTP ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as ListResp<ExistingTemplate>;
  return body.data.find((t) => t.name === name) ?? null;
}

type SubmitResult = {
  id?: string;
  status?: string;
  category?: string;
  error?: { message: string; code: number; error_subcode?: number };
};

async function submitTemplate(wabaId: string, body: unknown): Promise<SubmitResult> {
  const url = `https://graph.facebook.com/${API_VERSION}/${wabaId}/message_templates`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as SubmitResult & { error?: unknown };
  if (!res.ok) {
    // Surface the structured error so the caller can decide whether to fall back.
    return { error: ((json as { error: SubmitResult["error"] }).error ?? null) as SubmitResult["error"] };
  }
  return json;
}

const MARKETING_TEMPLATE = {
  name: "pilot_promo_offer",
  category: "MARKETING",
  language: "en_US",
  components: [
    {
      type: "BODY",
      text: "Hi {{1}}! Exclusive offer: enjoy 20% off your next service at {{2}}. Visit anytime before {{3}} to redeem.",
      example: {
        body_text: [["Priya", "Glow Hair Studio", "30 Jun 2026"]],
      },
    },
    {
      type: "FOOTER",
      text: "Reply STOP to unsubscribe.",
    },
  ],
};

const UTILITY_FALLBACK_TEMPLATE = {
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

async function attempt(wabaId: string, template: typeof MARKETING_TEMPLATE | typeof UTILITY_FALLBACK_TEMPLATE) {
  console.log(`\nAttempting template "${template.name}" (category=${template.category})`);
  const existing = await findExisting(wabaId, template.name);
  if (existing) {
    console.log(
      `  Already exists — status=${existing.status}, language=${existing.language}, category=${existing.category}`,
    );
    return existing;
  }
  const result = await submitTemplate(wabaId, template);
  if (result.error) {
    console.log(`  REJECTED at submission:`);
    console.log(`    code=${result.error.code}${result.error.error_subcode ? `/${result.error.error_subcode}` : ""}`);
    console.log(`    message=${result.error.message}`);
    return null;
  }
  console.log(`  Submitted: id=${result.id}, status=${result.status}, category=${result.category}`);
  return result;
}

async function main(): Promise<void> {
  console.log(`Graph API version: ${API_VERSION}`);
  const wabaId = await resolveWabaId();
  console.log(`Target WABA: ${wabaId}`);

  const marketingResult = await attempt(wabaId, MARKETING_TEMPLATE);
  if (marketingResult) {
    console.log(`\nDone. Marketing template is in the system. Re-run scripts/discover-waba.ts to watch its status flip from PENDING -> APPROVED (usually within ~1 hour).`);
    return;
  }

  console.log(`\nMarketing rejected — likely due to test-number restrictions. Falling back to UTILITY.`);
  const utilityResult = await attempt(wabaId, UTILITY_FALLBACK_TEMPLATE);
  if (utilityResult) {
    console.log(`\nDone. Utility template will validate the end-to-end pipeline. To actually run a promotional campaign you'll need a registered (non-test) phone number.`);
    return;
  }

  throw new Error("Both MARKETING and UTILITY template submissions failed. See errors above.");
}

main().catch((err) => {
  console.error(`\nERROR: ${(err as Error).message}`);
  process.exit(1);
});
