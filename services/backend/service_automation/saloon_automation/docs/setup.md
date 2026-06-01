# Setup walkthrough

End-to-end, from zero to a working WhatsApp bot in production. Budget: 60–90 min.

## 0. Prerequisites

- Node 20+, pnpm (or npm), Terraform 1.6+
- A WhatsApp-capable phone number you can verify (test number from Meta is fine)
- Accounts (all have free tiers):
  - GitHub (optional but recommended)
  - Vercel
  - Supabase
  - Upstash
  - Anthropic
  - Meta for Developers
  - Sentry (optional)

## 1. Provision the manual pieces

### 1.1 Meta WhatsApp Business

Follow [setup-meta.md](./setup-meta.md). At the end you'll have:
- App secret
- Permanent system-user access token
- Phone number id
- A verify token (you invent this string)

### 1.2 Supabase

1. Create a project at https://supabase.com
2. Copy from **Project Settings → API**:
   - Project URL → `SUPABASE_URL`
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY`
   - `anon` key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
3. Apply the schema. From the **monorepo root** (migrations live at root-level `supabase/migrations/`, shared across services):
   - CLI (recommended): `cd <repo-root> && supabase link --project-ref <ref> && supabase db push`
   - SQL editor (manual): paste each file from `supabase/migrations/` in numeric order, starting at `0001_init.sql`.
4. Seed a default tenant (one-off):
   ```sql
   INSERT INTO tenants (id, name)
   VALUES ('00000000-0000-0000-0000-000000000000', 'default');
   ```

### 1.3 Upstash QStash

1. https://console.upstash.com/qstash
2. Copy **QStash token**, **Current Signing Key**, **Next Signing Key**.

### 1.4 Anthropic

1. https://console.anthropic.com/settings/keys
2. Create an API key. Copy it.

### 1.5 Vercel access token

1. https://vercel.com/account/tokens
2. Create a token scoped to your account (or team). Copy it.

## 2. Local development

```bash
pnpm install
cp .env.example .env.local
# Fill .env.local with everything from step 1
pnpm dev
```

Test the health endpoint: `curl http://localhost:3000/api/health`

To test the webhook locally you'll need a public tunnel — `ngrok http 3000`,
then point Meta's webhook at the ngrok URL.

## 3. Apply Terraform

```bash
cd terraform
cp terraform.tfvars.example terraform.tfvars
# Fill terraform.tfvars with the same values
terraform init
terraform plan
terraform apply
```

This creates the Vercel project and pushes every secret into Vercel's env vars.

## 4. Deploy

```bash
# From repo root
vercel link --project wapi
vercel --prod
```

Set `APP_BASE_URL` in Vercel to the production URL once you know it
(`terraform apply` again with the corrected `app_base_url`).

## 5. Point Meta at production

In the Meta App dashboard → WhatsApp → Configuration → Webhook:
- Callback URL: `https://<your-app>.vercel.app/api/webhook`
- Verify token: the value you set in `META_VERIFY_TOKEN`
- Subscribe to: `messages`

Send a message to your WhatsApp number. You should get a reply.

## 6. Smoke test

```bash
# Outside the Meta flow, you can poke the worker indirectly by inserting
# a webhook_event row and re-enqueueing via QStash — see docs/scaling.md
# for the replay script.
```

## Troubleshooting

| Symptom                              | Likely cause                                          |
|--------------------------------------|-------------------------------------------------------|
| Webhook 401                          | Wrong `META_APP_SECRET` or body was JSON-parsed twice |
| Worker 401                           | QStash signing keys not in env, or `APP_BASE_URL` mismatch |
| "no message id returned"             | Bad `META_PHONE_NUMBER_ID` or expired access token    |
| Anthropic 401                        | Wrong API key, or workspace mismatch                  |
| Function timeout                     | Hobby plan caps at 10s — upgrade or reduce max_tokens |
