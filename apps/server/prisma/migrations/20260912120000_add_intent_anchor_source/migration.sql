-- Origin of an anchor row: `manual` (a maintainer anchored it in a user session)
-- or `ci` (the bindings sync wrote it from a PR's binding manifest).
-- Additive and defaulted: every existing row is `manual`, which is exactly what
-- it was — anchor writes have been user-session-only until now — so the CI
-- sync's "touch only my own anchors" rule holds from the first sync onward.
-- Rollback: ALTER TABLE "intent_anchors" DROP COLUMN "source";
ALTER TABLE "intent_anchors" ADD COLUMN "source" VARCHAR(16) NOT NULL DEFAULT 'manual';
