/**
 * Discover the WhatsApp Business Account (WABA) attached to META_PHONE_NUMBER_ID,
 * then list every message template that exists on it.
 *
 * Reads credentials from .env.local in-process. Never prints the access token.
 *
 * Usage:
 *   npx tsx scripts/discover-waba.ts
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
const PHONE_NUMBER_ID = required("META_PHONE_NUMBER_ID");
const TOKEN = required("META_ACCESS_TOKEN");

function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`missing env: ${key}`);
  return v;
}

async function graph<T>(path: string): Promise<T> {
  const url = `https://graph.facebook.com/${API_VERSION}${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) {
    throw new Error(`GET ${path} -> ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

type PhoneNumber = {
  id: string;
  display_phone_number?: string;
  verified_name?: string;
  quality_rating?: string;
  code_verification_status?: string;
  messaging_limit_tier?: string;
};

type TemplateRow = {
  name: string;
  language: string;
  status: string;
  category: string;
};

type ListResp<T> = { data: T[]; paging?: { next?: string } };

async function findWabaIdViaGraph(phoneNumberId: string): Promise<string | null> {
  try {
    const wabas = await graph<ListResp<{ id: string; name?: string }>>(
      `/me/whatsapp_business_accounts`,
    );
    for (const waba of wabas.data) {
      const phones = await graph<ListResp<{ id: string }>>(`/${waba.id}/phone_numbers`);
      if (phones.data.some((p) => p.id === phoneNumberId)) return waba.id;
    }
  } catch {
    // fall through
  }
  try {
    const businesses = await graph<ListResp<{ id: string }>>(`/me/businesses`);
    for (const biz of businesses.data) {
      const wabas = await graph<ListResp<{ id: string }>>(
        `/${biz.id}/owned_whatsapp_business_accounts`,
      );
      for (const waba of wabas.data) {
        const phones = await graph<ListResp<{ id: string }>>(`/${waba.id}/phone_numbers`);
        if (phones.data.some((p) => p.id === phoneNumberId)) return waba.id;
      }
    }
  } catch {
    // fall through
  }
  return null;
}

async function findWabaIdViaSupabase(): Promise<string | null> {
  const supaUrl = process.env.SUPABASE_URL;
  const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supaUrl || !supaKey) return null;
  const url = `${supaUrl}/rest/v1/webhook_events?select=payload&order=received_at.desc&limit=10`;
  const res = await fetch(url, {
    headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}` },
  });
  if (!res.ok) return null;
  const rows = (await res.json()) as Array<{ payload?: { entry?: Array<{ id?: string }> } }>;
  for (const r of rows) {
    const id = r.payload?.entry?.[0]?.id;
    if (id) return id;
  }
  return null;
}

async function findWabaId(phoneNumberId: string): Promise<string> {
  const viaGraph = await findWabaIdViaGraph(phoneNumberId);
  if (viaGraph) {
    console.log("  (source: Meta Graph API)");
    return viaGraph;
  }
  const viaSupa = await findWabaIdViaSupabase();
  if (viaSupa) {
    console.log("  (source: most recent webhook_events row in Supabase)");
    return viaSupa;
  }
  throw new Error(
    `could not find a WABA via Graph API (token lacks business_management) or Supabase webhook_events. Fix: either grant business_management to the token, OR ask the pilot to send any inbound WhatsApp message so a webhook row gets persisted.`,
  );
}

async function main(): Promise<void> {
  console.log(`Graph API version: ${API_VERSION}\n`);

  console.log("Step 1: phone number details");
  const phone = await graph<PhoneNumber>(
    `/${PHONE_NUMBER_ID}?fields=display_phone_number,verified_name,quality_rating,code_verification_status,messaging_limit_tier`,
  );
  console.log(`  phone_number_id          = ${phone.id}`);
  console.log(`  display_phone_number     = ${phone.display_phone_number ?? "(unknown)"}`);
  console.log(`  verified_name            = ${phone.verified_name ?? "(unset)"}`);
  console.log(`  code_verification_status = ${phone.code_verification_status ?? "(unknown)"}`);
  console.log(`  quality_rating           = ${phone.quality_rating ?? "(none yet)"}`);
  console.log(`  messaging_limit_tier     = ${phone.messaging_limit_tier ?? "(unknown)"}\n`);

  console.log("Step 2: discover WABA id");
  const wabaId = await findWabaId(PHONE_NUMBER_ID);
  console.log(`  waba_id                  = ${wabaId}\n`);

  console.log("Step 3: existing message templates on this WABA");
  const tpls = await graph<ListResp<TemplateRow>>(
    `/${wabaId}/message_templates?fields=name,language,status,category&limit=100`,
  );
  if (!tpls.data.length) {
    console.log("  (none — WABA has no templates yet)");
  } else {
    const widthName = Math.max(4, ...tpls.data.map((t) => t.name.length));
    const widthLang = Math.max(8, ...tpls.data.map((t) => t.language.length));
    const widthCat = Math.max(8, ...tpls.data.map((t) => t.category.length));
    console.log(
      `  ${"name".padEnd(widthName)}  ${"language".padEnd(widthLang)}  ${"category".padEnd(widthCat)}  status`,
    );
    console.log(
      `  ${"-".repeat(widthName)}  ${"-".repeat(widthLang)}  ${"-".repeat(widthCat)}  ${"-".repeat(8)}`,
    );
    for (const t of tpls.data) {
      console.log(
        `  ${t.name.padEnd(widthName)}  ${t.language.padEnd(widthLang)}  ${t.category.padEnd(widthCat)}  ${t.status}`,
      );
    }
  }
  console.log("");

  console.log("Step 4: subscribed apps (webhook delivery targets)");
  const subs = await graph<ListResp<{ id: string; name?: string }>>(
    `/${wabaId}/subscribed_apps`,
  );
  if (!subs.data.length) {
    console.log("  (none — webhook will not deliver)");
  } else {
    for (const s of subs.data) {
      console.log(`  app_id=${s.id}${s.name ? ` (${s.name})` : ""}`);
    }
  }
  console.log("");

  console.log(`Save this for the next script:  WABA_ID=${wabaId}`);
}

main().catch((err) => {
  console.error(`\nERROR: ${(err as Error).message}`);
  process.exit(1);
});
