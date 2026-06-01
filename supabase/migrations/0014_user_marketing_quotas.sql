-- ============================================================================
-- user_marketing_quotas: Meta's ~2 marketing msgs / user / 24h cap accounting.
--
-- Best-effort soft pre-check before each campaign send. The actual cap is
-- enforced by Meta GLOBALLY (across all businesses sending to the same wa_id)
-- and surfaces as error 131049 on send. We reconcile from those errors.
--
-- Intentionally NOT tenant-scoped — the cap is per recipient across all
-- senders, so the table has no tenant_id column and is service-role-only
-- (no RLS policy; workers access it directly via service role).
--
-- Designed so the production swap to Upstash Redis (atomic INCR + 24h TTL)
-- is a drop-in: callers use `tryReserveMarketingSlot(wa_id)` in app code.
-- The Postgres backing here is sufficient at MVP volumes; Redis becomes
-- worth it once row contention shows up in the dispatch path.
--
-- Cleanup: a nightly cron deletes rows older than 2 days (sliding-window
-- buckets aren't useful beyond the 24h cap window).
--
-- Companion code: src/core/campaigns/quotas.ts
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_marketing_quotas (
  wa_id              TEXT NOT NULL,
  window_start_date  DATE NOT NULL,
  sends_24h          INT  NOT NULL DEFAULT 0,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (wa_id, window_start_date)
);

-- Nightly cleanup query: DELETE WHERE window_start_date < now() - INTERVAL '2 days'.
CREATE INDEX IF NOT EXISTS user_marketing_quotas_window_idx
  ON user_marketing_quotas (window_start_date);
