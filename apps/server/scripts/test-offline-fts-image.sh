#!/usr/bin/env bash
set -euo pipefail

image_name="${1:-coredoc-server-phase2-fts-test}"

docker build --pull --no-cache --target offline-fts-test -t "${image_name}" -f apps/server/Dockerfile .
docker run --rm --network none --user 1000:1000 --entrypoint node "${image_name}" \
  apps/server/scripts/verify-ladybug-fts-offline.mjs /app/fts-smoke/offline.graph
docker image inspect "${image_name}" --format '{{.Id}}'
