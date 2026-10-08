#!/usr/bin/env bash
set -euo pipefail

server_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="${server_root}/docker-compose.test.yml"
project_name="coredoc-server-postgres-test"
postgres_port="${COREDOC_TEST_POSTGRES_PORT:-55432}"
database_url="postgresql://coredoc_test:coredoc_test@127.0.0.1:${postgres_port}/coredoc_test"
compose=(docker compose --project-name "${project_name}" --file "${compose_file}")

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  "${compose[@]}" down --volumes --remove-orphans || true
  exit "${status}"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

COREDOC_TEST_POSTGRES_PORT="${postgres_port}" \
  "${compose[@]}" up --detach --force-recreate --wait --wait-timeout 60 postgres-test

cd "${server_root}"
pnpm exec prisma generate
DATABASE_URL="${database_url}" pnpm exec prisma migrate deploy

DATABASE_URL="${database_url}" \
CAPTURE_TEST_DATABASE_URL="${database_url}" \
TOKEN_TEST_DATABASE_URL="${database_url}" \
GRAPH_MIGRATION_TEST_DATABASE_URL="${database_url}" \
GRAPH_SNAPSHOT_E2E_DATABASE_URL="${database_url}" \
OAUTH_STORE_TEST_DATABASE_URL="${database_url}" \
PHASE_C_SCHEMA_TEST_DATABASE_URL="${database_url}" \
PHASE_C_MIGRATION_TEST_DATABASE_URL="${database_url}" \
PHASE_D_MIGRATION_TEST_DATABASE_URL="${database_url}" \
CANONICAL_DELIVERY_TEST_DATABASE_URL="${database_url}" \
JIRA_CANONICAL_TEST_DATABASE_URL="${database_url}" \
GITHUB_CANONICAL_TEST_DATABASE_URL="${database_url}" \
PUSH_WORKER_LICENSE_TEST_DATABASE_URL="${database_url}" \
INTENT_SCHEMA_TEST_DATABASE_URL="${database_url}" \
INTENT_MIGRATION_TEST_DATABASE_URL="${database_url}" \
INTENT_MODULE_TEST_DATABASE_URL="${database_url}" \
INTENT_COMMENT_TEST_DATABASE_URL="${database_url}" \
INTENT_REVIEW_TEST_DATABASE_URL="${database_url}" \
INTENT_RELEASE_TEST_DATABASE_URL="${database_url}" \
INTENT_REVIEW_QUEUE_TEST_DATABASE_URL="${database_url}" \
INTENT_ANCHOR_TEST_DATABASE_URL="${database_url}" \
INTENT_CONTEXT_TEST_DATABASE_URL="${database_url}" \
INTENT_BINDINGS_TEST_DATABASE_URL="${database_url}" \
INTENT_TRANSFER_TEST_DATABASE_URL="${database_url}" \
REPOS_IDENTITY_TEST_DATABASE_URL="${database_url}" \
CLOUD_AGENT_RUNS_TEST_DATABASE_URL="${database_url}" \
  pnpm exec vitest run \
    src/modules/capture/capture.postgres.integration.test.ts \
    src/modules/tokens/telemetry-token.postgres.integration.test.ts \
    src/database/ci-token-intent-migration.postgres.integration.test.ts \
    src/modules/capture/capture-retention.postgres.integration.test.ts \
    src/modules/delivery/canonical-delivery.postgres.integration.test.ts \
    src/modules/jobs/push-worker-license-claim.postgres.integration.test.ts \
    src/modules/delivery/canonical-delivery.reads.postgres.integration.test.ts \
    src/modules/delivery/jira-canonical.postgres.integration.test.ts \
    src/modules/delivery/github-canonical.postgres.integration.test.ts \
    src/modules/delivery/github-intent-release.postgres.integration.test.ts \
    src/database/delivery-phase-c-schema.postgres.integration.test.ts \
    src/database/delivery-phase-c-migration.integration.test.ts \
    src/database/delivery-phase-d-migration.integration.test.ts \
    src/database/intent-schema.postgres.integration.test.ts \
    src/database/workspace-repo-intent-identity-migration.postgres.integration.test.ts \
    src/modules/repos/repos-identity.postgres.integration.test.ts \
    src/modules/intent/intent-module.postgres.integration.test.ts \
    src/modules/intent/intent-comment.postgres.integration.test.ts \
    src/modules/intent/intent-review.postgres.integration.test.ts \
    src/modules/intent/intent-release.postgres.integration.test.ts \
    src/modules/intent/intent-review-queue.postgres.integration.test.ts \
    src/modules/intent/intent-anchor.postgres.integration.test.ts \
    src/modules/intent/intent-context.postgres.integration.test.ts \
    src/modules/intent/intent-handoff.postgres.integration.test.ts \
    src/modules/intent/intent-import-export.postgres.integration.test.ts \
    src/modules/intent/intent-read-workspace.postgres.integration.test.ts \
    src/modules/cloud-agent-runs/cloud-agent-runs.postgres.integration.test.ts \
    src/modules/cloud-agent-runs/cloud-agent-runs-scope.postgres.integration.test.ts \
    src/modules/cloud-agent-runs/cloud-agent-run-trigger.postgres.integration.test.ts \
    src/auth/oauth/prisma-oauth.store.test.ts \
    src/database/graph-version-migration.integration.test.ts \
    src/modules/graph-snapshot/graph-snapshot-batch.e2e.integration.test.ts \
    --no-file-parallelism \
    --maxWorkers=1
