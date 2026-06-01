-- ============================================================================
-- messages.conversation_id: drop NOT NULL.
--
-- Campaign-driven outbound messages live OUTSIDE any conversation thread
-- (they are template sends, not replies in an open service window).
-- The conversation_id stays for normal inbound/agent-reply traffic and remains
-- a foreign key; only the NOT NULL constraint is removed.
--
-- Application contract: callers that insert conversation messages must still
-- pass a non-null conversation_id. Validate in src/core/messaging/messages.ts.
--
-- The messages.campaign_id column + FK is added later in migration 0011, once
-- the campaigns table exists.
-- ============================================================================

ALTER TABLE messages
  ALTER COLUMN conversation_id DROP NOT NULL;
