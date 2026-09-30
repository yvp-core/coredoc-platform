#!/usr/bin/env bash
#
# Intent performance smoke (spec §15) — the derivation-cost gate.
#
# Deliberately NOT part of `pnpm test` or `pnpm test:postgres`: it builds a
# multi-thousand-node Ladybug snapshot and issues ~170 real HTTP requests, which
# is minutes, not seconds. The suite itself is env-gated on
# INTENT_PERF_TEST_DATABASE_URL, so it skips everywhere this script does not run
# it, and it is absent from the test-postgres-integration.sh allowlist.
#
#   apps/server/scripts/perf-intent-smoke.sh
#       measure, write apps/server/perf/intent-report.json, and compare the
#       result to the committed baseline (query-count regressions fail).
#
#   INTENT_PERF_UPDATE_BASELINE=1 apps/server/scripts/perf-intent-smoke.sh
#       measure and overwrite apps/server/perf/intent-baseline.json instead.
#       Commit the result, and say in the commit message which machine it was
#       measured on — the latencies are only comparable to themselves.
#
# Its own compose project and port, so it can run beside test-postgres-integration.sh.

set -euo pipefail

server_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="${server_root}/docker-compose.test.yml"
project_name="coredoc-server-intent-perf"
postgres_port="${COREDOC_PERF_POSTGRES_PORT:-55433}"
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

INTENT_PERF_TEST_DATABASE_URL="${database_url}" \
INTENT_PERF_UPDATE_BASELINE="${INTENT_PERF_UPDATE_BASELINE:-}" \
  pnpm exec vitest run \
    src/modules/intent/perf/intent-perf.smoke.test.ts \
    --no-file-parallelism \
    --maxWorkers=1
