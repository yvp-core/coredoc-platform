#!/usr/bin/env bash
# Evaluate one parse run of the three repos.
#   SNAP=<snapshots> OUT=<eval out dir> TSMORPH=<ts-morph path> ./eval-run.sh <parse out dir> <tag>
# coredoc-platform is evaluated against the `cdp-tree` clone it was parsed from.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
parsed="$1"
tag="$2"
for pair in "oitchau-schedules:oitchau-schedules:dayio" "day-core:day-core:dayio" "coredoc-platform:cdp-tree:cd"; do
  IFS=: read -r name snap project <<<"$pair"
  node --max-old-space-size=16384 "$here/eval.cjs" "$SNAP/$snap" "$parsed/$project/$name.json" "$OUT/$name.$tag.json" >/dev/null 2>&1
  node "$here/show.cjs" "$OUT/$name.$tag.json" | sed -n '1p;/missBucket/,/calleeCoverage/p'
done
