-- A restricted intent domain is not reached by bindings on the workspace.
ALTER TABLE "intent_domains" ADD COLUMN "restricted" BOOLEAN NOT NULL DEFAULT false;
