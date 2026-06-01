-- ============================================================================
-- campaign_recipients → campaigns counters trigger.
--
-- Atomic counter maintenance via delta apply (decrement OLD bucket, increment
-- NEW bucket on UPDATE; increment NEW bucket on INSERT). This means a
-- 'sent' → 'delivered' transition moves exactly one unit cleanly without
-- compounding errors across concurrent updates.
--
-- A nightly pg_cron reconciliation job recounts from campaign_recipients
-- to fix any drift; treat these counters as approximate for live dashboards
-- but exact for end-of-campaign reporting (after reconcile).
--
-- Required prior migrations: 0010 (campaigns), 0012 (campaign_recipients).
-- ============================================================================

CREATE OR REPLACE FUNCTION campaign_counters_apply()
RETURNS TRIGGER AS $$
DECLARE
  d_total      INT := 0;
  d_sent       INT := 0;
  d_delivered  INT := 0;
  d_read       INT := 0;
  d_failed     INT := 0;
  d_skipped    INT := 0;
BEGIN
  IF TG_OP = 'INSERT' THEN
    d_total := 1;
    IF NEW.status = 'sent'      THEN d_sent      := 1; END IF;
    IF NEW.status = 'delivered' THEN d_delivered := 1; END IF;
    IF NEW.status = 'read'      THEN d_read      := 1; END IF;
    IF NEW.status = 'failed'    THEN d_failed    := 1; END IF;
    IF NEW.status = 'skipped'   THEN d_skipped   := 1; END IF;
  ELSIF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
    -- Decrement old bucket.
    IF OLD.status = 'sent'      THEN d_sent      := d_sent      - 1; END IF;
    IF OLD.status = 'delivered' THEN d_delivered := d_delivered - 1; END IF;
    IF OLD.status = 'read'      THEN d_read      := d_read      - 1; END IF;
    IF OLD.status = 'failed'    THEN d_failed    := d_failed    - 1; END IF;
    IF OLD.status = 'skipped'   THEN d_skipped   := d_skipped   - 1; END IF;
    -- Increment new bucket.
    IF NEW.status = 'sent'      THEN d_sent      := d_sent      + 1; END IF;
    IF NEW.status = 'delivered' THEN d_delivered := d_delivered + 1; END IF;
    IF NEW.status = 'read'      THEN d_read      := d_read      + 1; END IF;
    IF NEW.status = 'failed'    THEN d_failed    := d_failed    + 1; END IF;
    IF NEW.status = 'skipped'   THEN d_skipped   := d_skipped   + 1; END IF;
  END IF;

  IF d_total <> 0 OR d_sent <> 0 OR d_delivered <> 0 OR d_read <> 0
     OR d_failed <> 0 OR d_skipped <> 0 THEN
    UPDATE campaigns
       SET total_recipients = total_recipients + d_total,
           sent_count       = sent_count       + d_sent,
           delivered_count  = delivered_count  + d_delivered,
           read_count       = read_count       + d_read,
           failed_count     = failed_count     + d_failed,
           skipped_count    = skipped_count    + d_skipped
     WHERE id = NEW.campaign_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS campaign_recipients_counters ON campaign_recipients;
CREATE TRIGGER campaign_recipients_counters
AFTER INSERT OR UPDATE OF status ON campaign_recipients
FOR EACH ROW
EXECUTE FUNCTION campaign_counters_apply();
