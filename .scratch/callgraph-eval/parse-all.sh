#!/usr/bin/env bash
# Parse the three eval repos with this worktree's CLI.
#   ./parse-all.sh <coredoc.config.json>
set -uo pipefail
cli="$(cd "$(dirname "$0")/../.." && pwd)/packages/cli/dist/index.js"
config="$1"
node "$cli" parse -c "$config" -r oitchau-schedules -p dayio --no-pretty 2>&1 | grep -E "call resolution|✗|Error"
node "$cli" parse -c "$config" -r day-core -p dayio --no-pretty 2>&1 | grep -E "call resolution|✗|Error"
COREDOC_SCIP_PROJECT_CONCURRENCY=2 node --max-old-space-size=16384 "$cli" parse -c "$config" -r coredoc-platform -p cd --no-pretty 2>&1 |
  grep -E "call resolution|✗|degraded|Error"
