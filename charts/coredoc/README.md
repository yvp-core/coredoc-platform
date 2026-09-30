# coredoc Helm chart

Deploys the self-hosted Coredoc server: the NestJS API (OAuth 2.1 server +
MCP endpoint + push API), an in-cluster **Neo4j** graph (data plane, upstream
`neo4j` subchart), and a Prisma migration Job. You bring an external
**Postgres** (control plane) and any **S3-compatible** object store
(artifacts).

```
 AI assistants ──MCP──▶ ┌──────────────────────┐
 CLI / CI ─────push───▶ │  coredoc-server pod  │──▶ Postgres   (external, control plane)
 Browser ──────HTTP───▶ │  (this chart)        │──▶ Neo4j      (subchart, data plane)
                        └──────────────────────┘──▶ S3/GCS/R2  (external, artifacts)
```

## Quickstart

1. Pre-create the four secrets (auth, postgres, neo4j, storage) — copy the
   `kubectl create secret` commands from the top of
   [`values-example.yaml`](./values-example.yaml).

2. Create your values file:

```yaml
# my-values.yaml
server:
  publicUrl: https://coredoc.example.com   # REQUIRED

auth:
  upstream: github                          # or workos
  allowedEmailDomains: [example.com]        # REQUIRED for github upstream
  existingSecret: coredoc-auth              # OAUTH_JWT_SECRET + client id/secret

postgres:
  existingSecret: coredoc-postgres          # key: DATABASE_URL

storage:
  endpoint: https://storage.googleapis.com  # any S3-compatible endpoint
  bucket: coredoc-artifacts
  region: us-east1                          # real region, never "auto"
  existingSecret: coredoc-storage           # R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY

neo4j:
  neo4j:
    passwordFromSecret: coredoc-neo4j-auth  # keys: NEO4J_AUTH + NEO4J_PASSWORD

ingress:
  className: nginx
  host: coredoc.example.com
  tls: { enabled: true, secretName: coredoc-tls }
```

3. Install from the OCI registry:

```bash
helm install coredoc oci://ghcr.io/yvp-core/charts/coredoc \
  --namespace coredoc --create-namespace \
  -f my-values.yaml
```

4. Verify and bootstrap the first workspace — the post-install notes walk
   through it (`helm get notes coredoc -n coredoc`).

The OAuth App callback registered with your identity provider must be
`<server.publicUrl>/callback`.

## Migrations

Prisma migrations are a separate step by design — the server never runs them
on boot (avoids races with multiple replicas). `migrations.hook` controls how:

| Value | Behavior |
|---|---|
| `helm` (default) | `pre-install,pre-upgrade` hook Job; the release waits on it. |
| `argocd` | Job rendered with ArgoCD `PreSync` hook annotations. |
| `manual` | Not rendered. Run yourself: `kubectl run` (or `docker run`) the server image with `DATABASE_URL` set and command `sh -c "cd apps/server && npx prisma migrate deploy"`. |

## Upgrades

```bash
helm upgrade coredoc oci://ghcr.io/yvp-core/charts/coredoc \
  --namespace coredoc -f my-values.yaml
```

With the default `migrations.hook: helm` the new image's migrations run
before the rollout. Migrations are forward-only (`prisma migrate deploy`);
back up Postgres **and** Neo4j before upgrading. A plain
`helm rollback` restores the previous app version but does not undo applied
migrations.

## Air-gapped installs

The GitHub upstream OAuth dance needs egress to `github.com` +
`api.github.com`, so a fully air-gapped install requires `auth.upstream:
workos` with a reachable AuthKit domain — or is not currently supported.

Each release attaches an air-gap kit (`coredoc-onprem-<version>.tar.gz`) whose
`mirror.sh` verifies the kit's checksums, pushes the bundled images into your
registry, and prints the matching values fragment — including the Neo4j
subchart's `image.registry`/`image.repository`/`image.tag` keys under the
`neo4j:` passthrough block. See `docs/onprem/INSTALL.md` §10 (and §3.1 for
cosign signature / SBOM verification).

## Values reference

See the commented [`values.yaml`](./values.yaml). Highlights:

- `image.digest` — optional `sha256:...` pin. When set it **wins over
  `image.tag`** and the container renders as `repository@digest` — the
  immutable shape mirrored/air-gapped installs usually require.
- `server.publicUrl` — **required** (schema-enforced); drives
  `MCP_SERVER_URL` and `CORS_ORIGINS`. Permanent: it is the audience of every
  issued MCP token, so moving it makes all connected MCP clients re-authorize.
- `server.webOrigins` + `ingress.extraHosts` — serve the UI on a **second
  hostname** without touching `publicUrl`: each extra origin gets a registered
  web-login callback so a login started there completes there. `/authorize` and
  the upstream IdP callback stay on `publicUrl` — no identity provider change.
- `auth.allowedEmailDomains` — **required for the github upstream**
  (schema-enforced); the server refuses to boot with an empty login gate.
- `server.env` / `server.extraEnvFrom` — escape hatches for any env var the
  chart does not model (e.g. external Neo4j when `neo4j.enabled=false`:
  set `NEO4J_URI`/`NEO4J_USER` in `server.env` and provide `NEO4J_PASSWORD`
  via `extraEnvFrom`).
- `ingress.annotations` — ships two **load-bearing nginx defaults**:
  `proxy-buffer-size: 16k` (the OAuth `/callback` 302's cookies overflow
  nginx's default upstream-header buffer → 502 without it) and
  `proxy-body-size: 100m` (parser-result uploads reach 100 MB; nginx's 1 MB
  default 413s them before the app's own per-route limits apply).
- `postgres` — external only in v1: the control plane (workspaces, members,
  tokens) belongs on production-grade Postgres with backups/HA, which a
  chart-managed single pod cannot responsibly provide.
