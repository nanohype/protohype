-- Chorus Database Migration 002: Linear + push-based sources
--
-- Replaces Zendesk/Delighted/Gong/Productboard with Slack Events +
-- generic webhook for ingestion and Linear for backlog management.
BEGIN;

ALTER TABLE backlog_entries RENAME COLUMN productboard_id TO linear_id;

ALTER TABLE feedback_items DROP CONSTRAINT IF EXISTS feedback_items_source_check;
ALTER TABLE feedback_items ADD CONSTRAINT feedback_items_source_check
  CHECK (source IN ('slack', 'webhook'));

COMMIT;
