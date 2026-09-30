-- Bounded post-merge retries (BR-6). Additive columns; rollback = drop both columns.
ALTER TABLE intent_handoffs
  ADD COLUMN delivery_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN mapping_attempts integer NOT NULL DEFAULT 0;

-- One-shot requeue of rows stuck under rules that no longer exist: `stale_handoff`
-- (a push after save, BR-4) and per-repository `release_out_of_order` (now per item,
-- BR-6). Idempotent: touches only these named reasons, so recorded/applied halves
-- and every other needs_attention row stay as they are.
UPDATE intent_handoffs
SET mapping_state = 'pending', mapping_reason = NULL, mapping_attempts = 0, next_attempt_at = now()
WHERE mapping_state = 'needs_attention' AND mapping_reason = 'stale_handoff';

UPDATE intent_handoffs
SET delivery_state = 'pending', delivery_reason = NULL, delivery_attempts = 0, next_attempt_at = now()
WHERE delivery_state = 'needs_attention' AND delivery_reason IN ('stale_handoff', 'release_out_of_order');
