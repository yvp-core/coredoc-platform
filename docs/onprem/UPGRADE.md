# Coredoc On-Prem — Upgrade Guide

Chart, images, and migrations are versioned together: upgrading the chart
upgrades the server image (empty `image.tag` follows the chart `appVersion`)
and applies any new Prisma migrations.

## Before every upgrade: back up Postgres

**Back up Postgres before upgrading — Prisma migrations are forward-only
(`prisma migrate deploy` has no down path). Rollback = restore the Postgres
backup + reinstall the previous chart version.**

Also worth snapshotting when convenient: the Neo4j volume (the graph can be
re-pushed from artifacts, but a snapshot is faster) — see the backup notes in
`apps/server/ONPREM.md` §9.

## Ordering: server first, clients second

Desktop apps and CLIs from the first release that ships `GET /api/v1/meta` (and
every release after it) ask the server for that route — version plus minimum
supported client — after connecting. A server older than that release does not
serve it and answers **404**, and the clients read that 404 as "this server is
older than the oldest version that ships the handshake" — they show a *"your
Coredoc server is older than this app supports"* banner (the CLI prints the
same as a one-line warning before a push).

That is the intended verdict, and it makes the rollout order load-bearing:

1. **Upgrade the server first**, to a version that serves `/api/v1/meta`.
2. **Then roll out the desktop app / CLI** to your users.

Rolling the clients out first is not dangerous — the banner is advisory, no
request is blocked, and it clears itself once the server is upgraded — but
every user will see an alarming banner in the meantime, and support tickets
follow. The same applies to a server rollback: dropping back below the
handshake version brings the banner back until clients are pointed at an
upgraded server.

## Upgrade flow by `migrations.hook` mode

### `helm` (default)

One command — the migration Job runs as a `pre-upgrade` hook before the new
pods roll out, and the upgrade fails (old pods keep serving) if migrations
fail:

```bash
helm upgrade coredoc oci://ghcr.io/yvp-core/charts/coredoc \
  --version <new-version> \
  -f my-values.yaml \
  -n coredoc
```

### `argocd`

Bump the chart `targetRevision` to the new version in your Application. ArgoCD
runs the migration Job as a **PreSync** hook and applies the new workload only
after the schema is ready.

### `manual`

Run migrations yourself **before** rolling out the new image, then upgrade:

```bash
kubectl run coredoc-migrate --rm -it --restart=Never \
  --image=ghcr.io/yvp-core/coredoc-server:<new-version> \
  --env="DATABASE_URL=postgresql://coredoc:...@postgres-host:5432/coredoc" \
  -- sh -c "cd apps/server && npx prisma migrate deploy"

helm upgrade coredoc oci://ghcr.io/yvp-core/charts/coredoc \
  --version <new-version> -f my-values.yaml -n coredoc
```

Keep migrations a single pre-deploy step — never per replica.

## Agent runner (cloud agent runs)

Only if you enabled `agentRunner` ([AGENT-RUNS.md](AGENT-RUNS.md)):

- **Rebuild your derived runner image** from the new release's
  `coredoc-agent-runner` image and point `agentRunner.image` at it. A derived
  image built on an older base keeps the older runner, SDK and plugin.
- **Upgrade the server first, then the runner.** A runner whose protocol
  version the server does not support claims nothing; settings show
  *Refused: this runner version is not supported*.
- **A rollout discards in-flight turns.** The stopped runner skips its pushes
  and does not complete the turn; the turn runs again from its last state
  archive once its lease expires, and **its model spend is repeated**. Roll
  the runner while no turn is in progress if that matters.

## Air-gapped upgrades

Same flow with the new release's air-gap kit: verify `SHA-256SUMS`, load and
re-push the new images to your internal registry, update `image.tag` (and the
neo4j image override if the pinned Neo4j version changed — check the kit's
`images/` directory; and your derived runner image, rebuilt from the kit's
`coredoc-agent-runner` image, if you run agent runs), then `helm upgrade` from
the kit's local `chart/coredoc-<version>.tgz`.

## Verify after upgrading

```bash
kubectl -n coredoc rollout status deploy/coredoc
curl -fsS https://coredoc.example.com/api/v1/health   # postgres + neo4j "up"
```

Then run a push smoke test (see INSTALL.md §9) — data-plane misconfiguration
surfaces on the first graph request, not at boot.

## Rollback

1. Restore the Postgres backup taken before the upgrade (this is the actual
   schema rollback — do not attempt to down-migrate).
2. Reinstall the previous chart version:

   ```bash
   helm upgrade coredoc oci://ghcr.io/yvp-core/charts/coredoc \
     --version <previous-version> -f my-values.yaml -n coredoc
   ```

3. Re-run the health check and a push smoke test.

Note that any pushes accepted between the backup and the rollback are lost
from the control plane; re-push from CI to reconcile the graph.
