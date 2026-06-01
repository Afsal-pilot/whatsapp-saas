-- ============================================================================
-- Bookings — salon booking requests captured by the agent.
--
-- The agent emits a [BOOKING_REQUEST] line in its reply; the worker parses
-- that line and inserts a row here for the salon team to confirm.
-- ============================================================================

CREATE TYPE booking_status AS ENUM (
  'requested',   -- Captured from the chat, not yet acted on
  'confirmed',   -- Salon team confirmed with customer
  'cancelled',
  'completed',
  'no_show'
);

CREATE TABLE bookings (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id   UUID REFERENCES conversations(id) ON DELETE SET NULL,

  customer_name     TEXT NOT NULL,
  service           TEXT NOT NULL,
  preferred_date    DATE,           -- NULL = "flexible"
  preferred_time    TIME,           -- NULL = "flexible"
  stylist           TEXT,
  notes             TEXT,
  status            booking_status NOT NULL DEFAULT 'requested',

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX bookings_tenant_status_idx
  ON bookings (tenant_id, status, created_at DESC);
CREATE INDEX bookings_user_idx ON bookings (user_id, created_at DESC);

ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_bookings ON bookings
  USING (tenant_id::text = (auth.jwt() ->> 'tenant_id'));
