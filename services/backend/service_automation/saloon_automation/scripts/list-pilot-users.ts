/**
 * List users (wa_id contacts) the pilot has already conversed with.
 *
 * These are candidates for the first promotional campaign blast — they've
 * messaged us before, so we have an established conversation. (Real opt-in
 * compliance is a separate gate; this is for pilot testing only.)
 *
 * Usage:
 *   npx tsx scripts/list-pilot-users.ts
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

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPA_URL || !SUPA_KEY) throw new Error("missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");

type UserRow = {
  id: string;
  tenant_id: string;
  wa_id: string;
  name: string | null;
  first_seen: string;
  last_seen: string;
};

async function main(): Promise<void> {
  const url = `${SUPA_URL}/rest/v1/users?select=id,tenant_id,wa_id,name,first_seen,last_seen&order=last_seen.desc&limit=50`;
  const res = await fetch(url, {
    headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` },
  });
  if (!res.ok) throw new Error(`supabase HTTP ${res.status}: ${await res.text()}`);
  const rows = (await res.json()) as UserRow[];

  if (!rows.length) {
    console.log(
      "No users in DB yet. Either no one has messaged the pilot, OR the 5 testers are only in Meta's recipient allowlist (not in Supabase).",
    );
    console.log("In that case, you'll need to provide the 5 wa_ids manually.");
    return;
  }

  const widthWa = Math.max(5, ...rows.map((r) => r.wa_id.length));
  const widthName = Math.max(4, ...rows.map((r) => (r.name ?? "(unset)").length));
  console.log(`${rows.length} user(s) found in Supabase:\n`);
  console.log(
    `  ${"wa_id".padEnd(widthWa)}  ${"name".padEnd(widthName)}  first_seen           last_seen`,
  );
  console.log(
    `  ${"-".repeat(widthWa)}  ${"-".repeat(widthName)}  -------------------  -------------------`,
  );
  for (const r of rows) {
    console.log(
      `  ${r.wa_id.padEnd(widthWa)}  ${(r.name ?? "(unset)").padEnd(widthName)}  ${r.first_seen.slice(0, 19)}  ${r.last_seen.slice(0, 19)}`,
    );
  }
}

main().catch((err) => {
  console.error(`\nERROR: ${(err as Error).message}`);
  process.exit(1);
});
