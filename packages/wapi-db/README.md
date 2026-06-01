# @whatsapp-saas/wapi-db

Shared Supabase client + tenant-scoped wrapper for every WAPI service.

The database schema itself lives at the monorepo root: `supabase/migrations/`.
This package is the canonical Node.js client for that schema — use it
everywhere instead of instantiating Supabase clients per service.

## Usage

```ts
import { supabase, tenantClient } from "@whatsapp-saas/wapi-db";

// raw client — admin / non-tenant tables only
const sb = supabase();
const { data } = await sb.from("tenants").select("*");

// tenant-scoped — auto-injects tenant_id on insert/upsert,
// auto-filters by tenant_id on select/update/delete
const tc = tenantClient(tenantId);
const { data } = await tc.from("users").select("*");
```

## Required env vars

Caller is responsible for loading these into `process.env` before importing:

| Var | Purpose |
|---|---|
| `SUPABASE_URL` | Project URL from Supabase dashboard |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (bypasses RLS — server-only, NEVER ship to browser) |

The package throws a clear error if either is missing on first use.
