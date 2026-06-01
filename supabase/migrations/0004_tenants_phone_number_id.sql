-- ============================================================================
-- Real multi-tenant routing.
--
-- Adds `phone_number_id` to tenants — the Meta-issued id that arrives on every
-- webhook payload at `entry[0].changes[0].value.metadata.phone_number_id`.
-- Resolving by it (instead of a hard-coded DEFAULT_TENANT_ID) is what makes
-- the platform actually multi-tenant.
--
-- After applying this migration, BACKFILL the existing tenant(s):
--
--   npm run backfill:tenant-phone     # reads META_PHONE_NUMBER_ID from .env
--
-- or manually:
--
--   UPDATE tenants
--      SET phone_number_id = '<your META_PHONE_NUMBER_ID>'
--    WHERE id = '00000000-0000-0000-0000-000000000000';
--
-- Until then, resolveTenant() will throw "Unknown tenant for phone_number_id"
-- on every inbound message — by design. We fail loudly instead of silently
-- routing into the default tenant.
-- ============================================================================

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS phone_number_id TEXT;

-- One tenant per Meta phone number. NULLs allowed only during the brief
-- window between this migration and the backfill running.
CREATE UNIQUE INDEX IF NOT EXISTS tenants_phone_number_id_unique
  ON tenants (phone_number_id)
  WHERE phone_number_id IS NOT NULL;

-- Dashboard scope: webhook_events.tenant_id is populated lazily (after the
-- processor resolves the tenant), so this index is partial on non-null.
CREATE INDEX IF NOT EXISTS webhook_events_tenant_idx
  ON webhook_events (tenant_id, received_at DESC)
  WHERE tenant_id IS NOT NULL;
