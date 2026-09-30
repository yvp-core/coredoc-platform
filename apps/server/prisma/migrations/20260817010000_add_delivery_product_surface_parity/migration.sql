-- Product-surface parity: additive nullable columns only, with no default, so no
-- existing row is rewritten and each ALTER is a catalog-only change.
--
-- It is still NOT lock-free: ADD COLUMN takes an ACCESS EXCLUSIVE lock on the table.
-- The lock is held only for the catalog update, but acquiring it queues behind any
-- in-flight long read on a busy table — and every subsequent query queues behind the
-- waiting ALTER. Set a lock_timeout at deploy time (e.g. SET lock_timeout = '3s') so a
-- blocked migration fails fast and is retried instead of stalling reads.

ALTER TABLE "delivery_tasks"
ADD COLUMN "title" VARCHAR(512);

ALTER TABLE "delivery_code_changes"
ADD COLUMN "external_url" VARCHAR(2048),
ADD COLUMN "review_count" INTEGER,
ADD COLUMN "comment_count" INTEGER;
