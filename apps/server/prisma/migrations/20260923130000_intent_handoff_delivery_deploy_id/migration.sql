-- The deploy that last attempted a handoff's delivery, so a retry of that deploy
-- re-attempts its own failures and never an unrelated handoff. Additive, nullable;
-- rollback = drop the column.
ALTER TABLE intent_handoffs ADD COLUMN delivery_deploy_id text;
