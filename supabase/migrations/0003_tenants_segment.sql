-- ============================================================================
-- Multi-segment support.
--
-- `segment` selects which folder under src/segments/ handles a tenant's logic.
-- `config` is segment-specific JSONB (validated by the segment, not the DB).
-- ============================================================================

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS segment TEXT NOT NULL DEFAULT 'salon',
  ADD COLUMN IF NOT EXISTS config  JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Keep segment values sane. Add new segments to this CHECK as they ship.
ALTER TABLE tenants
  DROP CONSTRAINT IF EXISTS tenants_segment_check;
ALTER TABLE tenants
  ADD CONSTRAINT tenants_segment_check
  CHECK (segment IN ('salon', 'restaurant', 'clinic', 'retail'));

-- Ensure the default tenant exists before configuring it.
INSERT INTO tenants (id, name)
VALUES ('00000000-0000-0000-0000-000000000000', 'default')
ON CONFLICT (id) DO NOTHING;

-- Configure the default tenant as the salon.
UPDATE tenants
SET segment = 'salon',
    config = jsonb_build_object(
      'displayName', 'Glow Salon',
      'hours',       'Tue–Sun, 10am–8pm (closed Mondays)',
      'address',     '123 MG Road, Bangalore',
      'bookingLink', NULL
    )
WHERE id = '00000000-0000-0000-0000-000000000000';
