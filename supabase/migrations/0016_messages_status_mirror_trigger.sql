-- ============================================================================
-- messages → campaign_recipients status mirror trigger.
--
-- When a Meta status webhook (sent/delivered/read/failed) arrives, the
-- existing applyDeliveryStatus() in src/core/messaging/messages.ts patches
-- the messages row by wa_message_id. This trigger fans the same patch into
-- campaign_recipients so the dashboard and counters see it.
--
-- COALESCE per column means we only overwrite when the source has a non-null
-- value — a late-arriving 'sent' webhook can't clobber an already-recorded
-- 'read'.
--
-- Guard: only fires when the message belongs to a campaign AND has a real
-- wa_message_id (skips placeholder 'pending:xxx' ids that exist briefly
-- between insertOutboundPending and markOutboundSent).
--
-- Required prior migrations: 0011 (messages.campaign_id), 0012 (campaign_recipients).
-- ============================================================================

CREATE OR REPLACE FUNCTION mirror_message_status_to_campaign_recipients()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.campaign_id IS NULL OR NEW.wa_message_id IS NULL THEN
    RETURN NEW;
  END IF;

  UPDATE campaign_recipients
     SET status         = COALESCE(NEW.status, status),
         sent_at        = COALESCE(NEW.sent_at, sent_at),
         delivered_at   = COALESCE(NEW.delivered_at, delivered_at),
         read_at        = COALESCE(NEW.read_at, read_at),
         failed_at      = COALESCE(NEW.failed_at, failed_at),
         failure_reason = COALESCE(NEW.failure_reason, failure_reason),
         updated_at     = now()
   WHERE wa_message_id = NEW.wa_message_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS messages_after_update_mirror_campaign ON messages;
CREATE TRIGGER messages_after_update_mirror_campaign
AFTER UPDATE OF status, sent_at, delivered_at, read_at, failed_at, failure_reason
ON messages
FOR EACH ROW
EXECUTE FUNCTION mirror_message_status_to_campaign_recipients();
