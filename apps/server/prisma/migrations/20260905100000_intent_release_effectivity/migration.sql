CREATE TABLE "intent_release_events" (
  "workspace_id" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "seq" INTEGER NOT NULL CHECK ("seq" > 0),
  "kind" VARCHAR(16) NOT NULL CHECK ("kind" IN ('baseline','release','rollback','plan','withdraw','reinstate')),
  "idempotency_key" VARCHAR(200) NOT NULL,
  "request_hash" VARCHAR(64) NOT NULL,
  "recorded_by" VARCHAR(256) NOT NULL,
  "recorded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "delivered_ref" VARCHAR(256),
  "reason" VARCHAR(2000) NOT NULL,
  "data" JSONB NOT NULL,
  "response" JSONB NOT NULL,
  PRIMARY KEY ("workspace_id", "seq"),
  UNIQUE ("workspace_id", "idempotency_key")
);
CREATE INDEX "intent_release_events_workspace_id_delivered_ref_idx"
  ON "intent_release_events" ("workspace_id", "delivered_ref");
