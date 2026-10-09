-- Cloud agent run questions: clarifications the agent asks through AskUserQuestion,
-- parked for a person (pause) or answered at once (assume).
-- Additive only; rollback = drop cloud_agent_run_questions.

-- CreateTable
CREATE TABLE "cloud_agent_run_questions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "request_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "kind" VARCHAR(32) NOT NULL,
    "phase" VARCHAR(16) NOT NULL,
    "state" VARCHAR(16) NOT NULL,
    "tool_use_id" VARCHAR(255),
    "questions" JSONB NOT NULL,
    "answers" JSONB,
    "asked_in_turn_id" UUID,
    "resume_turn_id" UUID,
    "asked_at" TIMESTAMPTZ NOT NULL,
    "answered_at" TIMESTAMPTZ,
    "answered_by" VARCHAR(256),

    CONSTRAINT "cloud_agent_run_questions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cloud_agent_run_questions_request_id_key" ON "cloud_agent_run_questions"("request_id");

-- CreateIndex
CREATE INDEX "cloud_agent_run_questions_run_id_asked_at_idx" ON "cloud_agent_run_questions"("run_id", "asked_at");

-- CreateIndex
CREATE INDEX "cloud_agent_run_questions_asked_in_turn_id_idx" ON "cloud_agent_run_questions"("asked_in_turn_id");

-- AddForeignKey
ALTER TABLE "cloud_agent_run_questions" ADD CONSTRAINT "cloud_agent_run_questions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cloud_agent_run_questions" ADD CONSTRAINT "cloud_agent_run_questions_workspace_id_run_id_fkey" FOREIGN KEY ("workspace_id", "run_id") REFERENCES "cloud_agent_runs"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-written: a run parks on one question at a time (see schema.prisma).
CREATE UNIQUE INDEX "cloud_agent_run_questions_one_open_per_run"
  ON "cloud_agent_run_questions"("run_id")
  WHERE "state" = 'open';
