-- ============================================================================
-- messages: campaign linkage (forward-ref column from migration 0008).
--
-- Added now that campaigns exists (FK target). When a campaign send creates
-- an outbound message row, campaign_id is set; for normal conversation
-- traffic it stays NULL.
--
-- ON DELETE SET NULL keeps message history even if a campaign is cleaned up.
-- ============================================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS campaign_id UUID
    REFERENCES campaigns(id) ON DELETE SET NULL;

-- Partial index — most messages are conversational and never set this column.
-- Used for "show me all messages sent by campaign X" drill-downs.
CREATE INDEX IF NOT EXISTS messages_campaign_idx
  ON messages (campaign_id, created_at DESC)
  WHERE campaign_id IS NOT NULL;
