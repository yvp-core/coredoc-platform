# Coredoc Server — On-Prem Deployment Guide

> **Customer packaging guide:** the Helm/Kubernetes install, upgrade, and sizing guides for the packaged product live in [`docs/onprem/`](../../docs/onprem/INSTALL.md).

Self-hosted deployment of the Coredoc cloud API (`@coredoc/server`) for a single
organization. This is the **single-tenant on-prem** topology: one Neo4j graph for
the whole company (no per-workspace Turso provisioning), Postgres for the control
plane, and an S3-compatible object store (e.g. Google Cloud Storage) for artifacts.

> **TL;DR for devops.** Build the image, stand up Postgres + Neo4j + a GCS bucket,
> create a **GitHub OAuth App**, **run the DB migrations once**, then start the
> container with the env in [§5](#5-environment-variables). Things easy to miss:
> (1) migrations are a **separate step** — they do not run on container start;
> (2) `COREDOC_DB_BACKEND` must be **exactly `neo4j`** (lowercase) or the server
> silently uses the cloud (Turso) path; (3) auth is now a **self-hosted OAuth 2.1
> server** with a GitHub upstream — it **fails fast at boot** if `OAUTH_JWT_SECRET`
> is `< 32` chars or the login gate (`ALLOWED_EMAIL_DOMAINS`) is empty, so those
> are the auth vars to get right first.

---

## 1. Architecture

```
                         ┌─────────────────────────────┐
   AI assistants ──MCP──▶│                             │
   CLI / CI ─────push───▶│   coredoc-server (Docker)   │
   Browser ──────HTTP───▶│   NestJS, port 3000         │
                         └───┬─────────┬──────────┬────┘
                             │         │          │
                   control   │  data   │ artifacts│   auth
                    plane    │  plane  │          │ (outbound HTTPS)
                             ▼         ▼          ▼          ▼
                        Postgres    Neo4j    GCS bucket    github.com
                       (required)  (graph)  (S3-compat)   (OAuth App)
```

| Concern | Backend | Notes |
|---|---|---|
| **Control plane** | **Postgres** | Workspaces, members, repos, parsers, tokens, push jobs. Always required. |
| **Data plane** (code graph) | **Neo4j** | One shared graph. Selected by `COREDOC_DB_BACKEND=neo4j`. Replaces Turso(sqlite). |
| **Artifacts** (parsed blobs, parsers, mapper.json) | **GCS** (S3-compatible) | Or any S3 endpoint. Falls back to local disk if unset (single-node only). |
| **Auth** | **Self-hosted OAuth server (GitHub upstream)** | The NestJS app *is* the OAuth 2.1 authorization server (no auth SaaS). It needs outbound HTTPS to `github.com` + `api.github.com` for the login dance. Not air-gappable (uses GitHub.com). |

> **It's two databases, not one.** Neo4j replaces *Turso* (the data plane), **not**
> Postgres. Both are required.

---

## 2. Prerequisites

Provision these before deploying. They can all run on the same GCP VM (Docker
Compose example in [§7](#7-start-the-server)) or as managed services.

| Dependency | Minimum | Recommended for prod |
|---|---|---|
| Docker + Docker Compose | Docker 24+ | — |
| **Postgres** | 16+ | Cloud SQL for PostgreSQL, or a pinned `postgres:16` container with a persistent volume |
| **Neo4j** | 5.x | `neo4j:5` (pin a 5.x LTS), 4 GB+ heap, persistent volume; or Neo4j AuraDB |
| **Object storage** | any S3-compatible | A **GCS bucket** + an HMAC key (Settings → Interoperability) |
| **GitHub OAuth App** | — | A GitHub OAuth App (client id + secret), callback `https://<public-host>/callback` |
| Outbound network | — | HTTPS egress to `github.com` + `api.github.com` (auth) and to your git host if pulling private repos |

---

## 3. Provision the dependencies

### 3.1 Postgres
Create an empty database and a user. Capture the connection string for
`DATABASE_URL`:
```
postgresql://coredoc:CHANGE_ME@postgres-host:5432/coredoc
```
The schema is created by migrations in [§6](#6-run-database-migrations) — do **not**
hand-create tables.

### 3.2 Neo4j
Stand up Neo4j 5.x with auth enabled. Note the bolt URI, user, and password.
Mirror the plugin set the project uses in development (APOC; graph-data-science is
also enabled in dev):
```
NEO4J_AUTH=neo4j/CHANGE_ME
NEO4J_PLUGINS=["apoc","graph-data-science"]
NEO4J_server_memory_heap_max__size=4G
```
Bolt port `7687`, browser UI `7474`. The server connects over `bolt://`.

### 3.3 Google Cloud Storage (artifact store)
The server's object-storage client is **S3-compatible and already supports GCS** —
no code change, config only.

1. Create a GCS bucket (e.g. `coredoc-artifacts`).
2. Create an **HMAC key** for a service account: GCS Console → Settings →
   Interoperability → *Create key for a service account*. This yields an
   access-key / secret pair (the S3-style credential GCS exposes).
3. You will set, in [§5](#5-environment-variables):
   ```
   R2_ENDPOINT=https://storage.googleapis.com
   R2_ACCESS_KEY_ID=<HMAC access key>
   R2_SECRET_ACCESS_KEY=<HMAC secret>
   R2_BUCKET=coredoc-artifacts
   R2_REGION=<bucket's real region, e.g. us-east1>     # NOT "auto" — see §10
   ```

> The env vars are named `R2_*` for historical reasons (Cloudflare R2). The client
> is endpoint-agnostic; pointing it at `storage.googleapis.com` targets GCS.

### 3.4 GitHub OAuth App (authentication)
Auth is a **self-hosted OAuth 2.1 authorization server** baked into the app
(`@rekog/mcp-nest`), with **GitHub** as the upstream identity provider and a
**Postgres-backed** token store. There is no auth SaaS and no per-tenant
subscription — but the server still talks to GitHub.com for the login dance.

1. Create a **GitHub OAuth App**: GitHub → Settings → Developer settings →
   *OAuth Apps* → *New OAuth App*. (An *OAuth App*, not a *GitHub App*.)
2. Set **Authorization callback URL** to your public host + `/callback`, e.g.
   `https://coredoc.yourco.com/callback`. (This is the server's callback — the
   root path, **not** `/api/v1/...`. The CLI registers its own loopback redirect
   automatically via dynamic client registration.)
3. Capture the **Client ID** (`GITHUB_CLIENT_ID`) and generate a **Client secret**
   (`GITHUB_CLIENT_SECRET`).
4. Generate a token-signing secret: `openssl rand -hex 32` → `OAUTH_JWT_SECRET`
   (must be ≥ 32 chars; the server refuses to boot otherwise).

**Login gate (who may sign in).** Set `ALLOWED_EMAIL_DOMAINS` — comma-separated
email domains (e.g. `example.com`). A user may sign in only if their
**verified** GitHub primary email is in one of these.

The server **fails fast at boot** if it is empty — it never allows every GitHub
user. Anyone whose verified email is outside the allowed domains cannot obtain a
token. (Org-based access is intentionally disabled in this build.)

**Bootstrap the first admin.** A user who passes the login gate can sign in but
has **no workspace access** until they are a member. Membership is managed
locally (invite by email → a *pending* member that is linked to the real user on
their first login). Seed the very first owner directly in Postgres, keyed by the
email that matches their GitHub verified email:
```sql
-- one-time bootstrap (psql against DATABASE_URL)
INSERT INTO workspaces (name, slug) VALUES ('Acme', 'acme') RETURNING id;
-- use the returned <workspace-id> below
INSERT INTO workspace_members (workspace_id, user_id, email, role, pending)
VALUES ('<workspace-id>', 'pending:admin@example.com', 'admin@example.com', 'owner', true);
```
On that admin's first login the pending row is re-keyed to their real user id;
they then invite the rest via `POST /api/v1/workspaces/:id/members/invites`.

The GitHub upstream authenticates users but does not send Coredoc workspace
invitation mail. The invite endpoint still creates pending local access and
returns `emailSent: false` plus a `signInUrl`; the admin must share that URL
through the company's normal communication channel. Access activates only when
the invitee signs in with the same verified GitHub email. The pending grant
expires 14 days after it is created. If the link was not shared in time, or the
grant expired, renew it with
`POST /api/v1/workspaces/:id/members/invites/:invitationId/resend`; the response
contains `emailSent: false`, the renewed `expiresAt`, and the `signInUrl` to
share for the new 14-day window. Automatic invite email delivery is available
in WorkOS mode, or requires a separate mail-provider integration.

> **Not air-gappable.** The OAuth dance needs `github.com` (authorize/token) and
> `api.github.com` (`/user`, `/user/emails`, `/user/orgs`). GitHub Enterprise
> Server is **not** supported without code changes (the GitHub API base is the
> public `api.github.com`).

---

## 4. Build the image

A production Dockerfile already exists (`apps/server/Dockerfile`) — a 3-stage,
monorepo-aware build. **Build from the repository root** (the build context needs
the whole pnpm workspace):

```bash
docker build -f apps/server/Dockerfile -t coredoc-server:latest .
```

The image compiles `@coredoc/core`, `@coredoc/db`, `@coredoc/mcp`, and the server,
generates the Prisma client, and ships `node apps/server/dist/main.js` as its
entrypoint. The Prisma CLI, schema, and migrations are included in the image (used
in [§6](#6-run-database-migrations)).

---

## 5. Environment variables

### Required (Neo4j on-prem)

| Variable | Example | Notes |
|---|---|---|
| `DATABASE_URL` | `postgresql://coredoc:…@host:5432/coredoc` | Postgres control plane. Must be reachable **and migrated** at boot (see §6 and the push-worker note in §10). |
| `COREDOC_DB_BACKEND` | `neo4j` | **Exactly lowercase `neo4j`.** Any other value → cloud/Turso path → "no database available". |
| `NEO4J_URI` | `bolt://neo4j:7687` | Default `bolt://localhost:7687`. |
| `NEO4J_USER` | `neo4j` | Default `neo4j`. |
| `NEO4J_PASSWORD` | `CHANGE_ME` | **No default.** Missing/incorrect → throws on the *first graph request* (not at boot — see §10). |
| `GITHUB_CLIENT_ID` | `Ov23li…` | GitHub OAuth App client id. **Boot fails if unset.** |
| `GITHUB_CLIENT_SECRET` | `…` | GitHub OAuth App client secret. |
| `OAUTH_JWT_SECRET` | `openssl rand -hex 32` | Signs issued access tokens (HS256). **Must be ≥ 32 chars or the server refuses to boot.** |
| `ALLOWED_EMAIL_DOMAINS` | `example.com` | Login gate (§3.4) — comma-separated verified-email domains. Required, else **boot fails**. |
| `MCP_SERVER_URL` | `https://your-coredoc.example.com` | Public base URL: the OAuth **issuer / resource** (and MCP discovery). Defaults to `http://localhost:3000`; set the real public `https://` host. Treat it as permanent — it is the `aud` of every issued MCP token, so changing it makes all connected MCP clients re-authorize. To serve the UI on another hostname use `WEB_ORIGINS` instead. |
| `WEB_ORIGINS` | `https://ai-dashboard.example.com` | Optional, comma-separated. Extra public base URLs the UI is served on. Each gets a registered web-login callback, so a login started there completes there (without it the callback lands on `MCP_SERVER_URL`, where the host-only PKCE cookie is absent → *"Missing or expired login session"*). `/authorize` and the upstream IdP callback stay on `MCP_SERVER_URL`, so the identity provider needs no change. Requires the hostname to reach this server with its `Host` header intact. |

### Required for object storage (GCS)

| Variable | Example | Notes |
|---|---|---|
| `R2_ENDPOINT` | `https://storage.googleapis.com` | If **unset**, artifacts go to container-local `.r2-local/` (ephemeral; single-node dev only). |
| `R2_ACCESS_KEY_ID` | `GOOG1E…` | GCS HMAC access key. |
| `R2_SECRET_ACCESS_KEY` | `…` | GCS HMAC secret. |
| `R2_BUCKET` | `coredoc-artifacts` | Default `coredoc-parsers`. |
| `R2_REGION` | `us-east1` | Set the bucket's **real** region, not `auto` — needed for presigned-URL signing (§10). |
| `R2_FORCE_PATH_STYLE` | `true` | Optional. Set if virtual-host-style addressing fails. |

### MCP (AI assistants querying the graph)

No extra auth vars are needed: the app **is** the OAuth authorization server, so it
serves `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource`
itself. Just ensure `MCP_SERVER_URL` (above, required) is the public `https://` host —
MCP clients discover `/authorize`, `/token`, and `/register` from it.

### Recommended

| Variable | Example | Notes |
|---|---|---|
| `NODE_ENV` | `production` | Set by the image already. |
| `PORT` | `3000` | Default `3000`. |
| `SERVER_ENCRYPTION_KEY` | `openssl rand -base64 32` | Used to encrypt **CI/service tokens**. Must decode to 32 bytes — `openssl rand -base64 32` (44 chars) or `openssl rand -hex 32` (64 chars); anything else fails at boot. Not needed for the core Neo4j graph path, but set it if you issue auto-sync (CI) tokens. |

### Optional / tuning

| Variable | Default | Notes |
|---|---|---|
| `PROCESS_ROLE` | `all` | `api` starts HTTP only, `worker` starts the standalone queue worker without listening, and `all` starts both for local/single-process deployments. Any other value fails before bootstrap. |
| `PUSH_WORKER_ENABLED` | `true` | Background push-job worker. Hits Postgres at boot (§10). **Mandatory for any workspace that receives remote pushes** — the CLI has no inline path, so `coredoc push --remote`, `coredoc ci run`, and `coredoc sync` are all executed by this worker. `false` is only viable on a server that serves reads/MCP only. |
| `PUSH_WORKER_CONCURRENCY` | `1` | |
| `PUSH_WORKER_POLL_INTERVAL_MS` | `2000` | Min 100. |
| `FILE_SNAPSHOT_SYNC_TIMEOUT_MS` | `270000` | Maximum wait for a file-snapshot `?sync=true` request. May be lowered to any positive integer, but cannot exceed `270000` ms so it remains below the CLI's 5-minute abort. Invalid values fail server bootstrap. |
| `GRAPH_FILE_CACHE_DIR` | `<os tmpdir>/coredoc-graph-cache` | Where a `file_snapshot` workspace's graph files are cached for reading. The default lands on the container's **writable layer**: in production point it at a mounted volume, or the pod is evicted once the cache passes the ephemeral-storage limit. Must not be empty. |
| `GRAPH_FILE_CACHE_MAX_BYTES` | `5368709120` (5 GiB) | Cache capacity for the directory above. Set it **below** the mounted volume's size. Positive safe integer or boot fails. |
| `GRAPH_SNAPSHOT_BUILD_ROOT` | `<os tmpdir>/coredoc-graph-snapshot-builds` | Scratch space where a snapshot is built before upload — same ephemeral-storage risk as the cache dir; mount a volume in production. |
| `OAUTH_ACCESS_TTL` | `1d` | Issued access-token lifetime. |
| `OAUTH_REFRESH_TTL` | `30d` | Issued refresh-token lifetime. |
| `COREDOC_POSTHOG_KEY` / `COREDOC_POSTHOG_HOST` | — | Telemetry. Leave unset for an on-prem privacy posture. |
| `COREDOC_LICENSE_FILE` | — | Path to the signed offline license we issue you (Helm mounts it at `/etc/coredoc/license.json`). **Unset = no licensing at all** — the guard is inert. Set and valid → normal operation; set and unreadable/forged → **boot fails** naming the file and the reason; set and expired past its grace window → mutating `/api/v1` requests return 403 `LICENSE_EXPIRED` while reads, MCP, OAuth, and the health probes keep working. Verified offline (Ed25519, no network) at boot and hourly thereafter — including in the `worker` role, which additionally stops enqueueing connector syncs and narrows its job claim to `renormalize` while expired. Current state at `GET /api/v1/license` and in the `/api/v1/health` payload. |

**What an expired license (past its grace window) stops, and what it does not.**
Stopped: mutating `/api/v1` requests (403 `LICENSE_EXPIRED`), the hourly
connector-sync enqueue, and the worker's claim of `push`, `resolve` and
`connector_sync` jobs — those stay `pending` and drain by themselves once the
license is renewed, and a job already claimed always runs to completion. Not
stopped: every read path, raw-payload retention, health and license probes,
OAuth, and the MCP transport — and, deliberately, the whole renormalize path.
The backfill keeps enqueueing renormalize jobs while expired AND the worker
keeps claiming that one job type: it imports nothing, it re-derives rows the
deployment already holds, and the raw payloads it derives from are hard-deleted
on a retention deadline that does not pause. Refusing those jobs would turn a
lapsed license into permanent loss of every row whose payload ages out before
renewal.

MCP stays fully available on purpose, and that includes its one write —
`submit_session_feedback`. It records feedback telemetry about the tooling
itself (ratings, "this tool was noisy", "this skill was unclear", the user's
review notes on the agent's draft), not product data: it imports
nothing, grows no graph, and is exactly the signal we want from a deployment
whose license lapsed. Product-data intake — pushes, connector syncs — is
already refused at the API guard and the job claim, so exempting the feedback
tool widens nothing. See `license.guard.ts` (route-exemption comment) and issue
`02-server-offline-license.md`.

> ⚠ **Release ops (Coredoc maintainers, not customers).** The Ed25519 public
> key the license verifier trusts lives in
> `apps/server/src/modules/license/license-format.mjs` and is committed as an
> obvious placeholder (`REPLACE_WITH_RELEASE_ED25519_PUBLIC_KEY`) — the
> verifier refuses every license while it is in place. The `server-image` job
> in `.github/workflows/release.yml` fails the release unless the constant
> parses as a real Ed25519 public key — it runs the same
> `assertValidLicensePublicKey()` the server uses, so the placeholder, a
> mis-pasted or truncated PEM, and a wrong-type (e.g. RSA) key are all caught
> before publishing rather than by every customer's crash-looping pod.
> Replacing it with the real release key (private half kept out of
> the repo, see `scripts/license-tool.mjs keygen`, which refuses to write inside
> the repo — following symlinks included — and refuses to overwrite an existing
> key file) is a prerequisite for
> tagging a release that supports licensing. The desktop/MDM counterpart of
> this file-trust story is documented in `docs/onprem/INSTALL.md` §12.

> Not used in Neo4j mode: `TURSO_ORG`, `TURSO_ORG_TOKEN` (per-workspace Turso
> provisioning is never reached), and `ENVIRONMENT` (Turso group only).

---

## 6. Run database migrations

**Migrations are a separate step — the container does not run them on start.**
Against a fresh Postgres, run this once (and again on every upgrade that ships new
migrations), *before* rolling out the app:

```bash
docker run --rm \
  -e DATABASE_URL="postgresql://coredoc:CHANGE_ME@postgres-host:5432/coredoc" \
  coredoc-server:latest \
  sh -c "cd apps/server && npx prisma migrate deploy"
```

This applies all committed migrations (`apps/server/prisma/migrations`, including
the `add_oauth_server` tables that back the auth server) using `prisma.config.ts`,
which reads `DATABASE_URL`. Expect `relation does not exist` errors at runtime if
you skip this.

> Running migrations as a discrete pre-deploy job (rather than on every container
> boot) is the recommended production pattern — it avoids races when scaling to
> more than one server replica.

---

## 7. Start the server

### Option A — `docker run`

```bash
docker run -d --name coredoc-server -p 3000:3000 \
  -e DATABASE_URL="postgresql://coredoc:CHANGE_ME@postgres-host:5432/coredoc" \
  -e COREDOC_DB_BACKEND=neo4j \
  -e NEO4J_URI=bolt://neo4j-host:7687 \
  -e NEO4J_USER=neo4j \
  -e NEO4J_PASSWORD=CHANGE_ME \
  -e GITHUB_CLIENT_ID=Ov23lixxx \
  -e GITHUB_CLIENT_SECRET=xxx \
  -e OAUTH_JWT_SECRET="$(openssl rand -hex 32)" \
  -e ALLOWED_EMAIL_DOMAINS=example.com \
  -e MCP_SERVER_URL=https://your-coredoc.example.com \
  -e R2_ENDPOINT=https://storage.googleapis.com \
  -e R2_ACCESS_KEY_ID=GOOG1Exxx \
  -e R2_SECRET_ACCESS_KEY=xxx \
  -e R2_BUCKET=coredoc-artifacts \
  -e R2_REGION=us-east1 \
  -e SERVER_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  coredoc-server:latest
```

### Option B — production Docker Compose

> The repo's `apps/server/docker-compose.yml` is a **development** harness
> (source mounts, `--watch`, hardcoded creds, and it does **not** set
> `COREDOC_DB_BACKEND`). Do **not** ship it. Use the production compose below
> instead. Build the image first (§4), or set `build:` to the repo root.

```yaml
# docker-compose.prod.yml — run from repo root; put real secrets in an .env file
name: coredoc-onprem

services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: coredoc
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: coredoc
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U coredoc"]
      interval: 10s
      timeout: 5s
      retries: 5

  neo4j:
    image: neo4j:5
    environment:
      NEO4J_AUTH: neo4j/${NEO4J_PASSWORD}
      NEO4J_PLUGINS: '["apoc","graph-data-science"]'
      NEO4J_server_memory_heap_max__size: 4G
    ports:
      - "7474:7474"   # browser UI (optional; restrict in prod)
    volumes:
      - neo4jdata:/data
    healthcheck:
      # cypher-shell ships in the neo4j image; wget does not. Compose substitutes
      # ${NEO4J_PASSWORD} from the .env at parse time.
      test: ["CMD-SHELL", "cypher-shell -u neo4j -p ${NEO4J_PASSWORD} 'RETURN 1' || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 10

  # One-shot: applies Prisma migrations, then exits. App waits on its success.
  migrate:
    image: coredoc-server:latest
    command: sh -c "cd apps/server && npx prisma migrate deploy"
    environment:
      DATABASE_URL: postgresql://coredoc:${POSTGRES_PASSWORD}@postgres:5432/coredoc
    depends_on:
      postgres:
        condition: service_healthy

  server:
    image: coredoc-server:latest
    ports:
      - "3000:3000"
    environment:
      DATABASE_URL: postgresql://coredoc:${POSTGRES_PASSWORD}@postgres:5432/coredoc
      COREDOC_DB_BACKEND: neo4j
      NEO4J_URI: bolt://neo4j:7687
      NEO4J_USER: neo4j
      NEO4J_PASSWORD: ${NEO4J_PASSWORD}
      GITHUB_CLIENT_ID: ${GITHUB_CLIENT_ID}
      GITHUB_CLIENT_SECRET: ${GITHUB_CLIENT_SECRET}
      OAUTH_JWT_SECRET: ${OAUTH_JWT_SECRET}
      ALLOWED_EMAIL_DOMAINS: ${ALLOWED_EMAIL_DOMAINS}
      MCP_SERVER_URL: ${MCP_SERVER_URL}
      R2_ENDPOINT: https://storage.googleapis.com
      R2_ACCESS_KEY_ID: ${GCS_HMAC_KEY}
      R2_SECRET_ACCESS_KEY: ${GCS_HMAC_SECRET}
      R2_BUCKET: ${GCS_BUCKET}
      R2_REGION: ${GCS_REGION}
      SERVER_ENCRYPTION_KEY: ${SERVER_ENCRYPTION_KEY}
    depends_on:
      postgres:
        condition: service_healthy
      neo4j:
        condition: service_healthy
      migrate:
        condition: service_completed_successfully

volumes:
  pgdata:
  neo4jdata:
```

Bring it up:
```bash
docker build -f apps/server/Dockerfile -t coredoc-server:latest .
docker compose -f docker-compose.prod.yml up -d
```

> **TLS:** terminate HTTPS at a reverse proxy (nginx/Caddy/GCP load balancer) in
> front of port 3000. The GitHub OAuth App callback (`<host>/callback`) and
> `MCP_SERVER_URL` must be the public `https://` hostname.

---

## 8. Verify the deployment

```bash
# 1. Readiness — probes Postgres (always) and, when COREDOC_DB_BACKEND=neo4j,
#    Neo4j. Returns 200 with every dependency "up"; 503 if any is unreachable
#    (the `-f` below then makes curl exit non-zero). This is the k8s readiness
#    probe: a 503 takes the pod out of rotation but does NOT restart it.
curl -fsS http://localhost:3000/api/v1/health
# -> {"status":"ok","checks":{"postgres":{"status":"up"},"neo4j":{"status":"up"}},"license":{"state":"absent"}}
#    license.state is reported for information only and never changes the
#    200/503 decision (an expired license must not take pods out of rotation).

#    Liveness is a separate, dependency-free route — it returns 200 whenever the
#    process is serving HTTP, so a transient DB outage can't restart-loop the pod.
curl -fsS http://localhost:3000/api/v1/health/live
# -> {"status":"ok"}

# 2. Auth server — the self-hosted OAuth metadata must resolve (served at root,
#    NOT under /api/v1). If the app booted, these return JSON:
curl -fsS http://localhost:3000/.well-known/oauth-authorization-server   # issuer/authorize/token/register
curl -fsS http://localhost:3000/.well-known/oauth-protected-resource     # authorization_servers: ["<MCP_SERVER_URL>"]
#    Then do a real login from a browser/MCP client and confirm an allowed user
#    (verified email in ALLOWED_EMAIL_DOMAINS) gets a token and a denied
#    user is rejected.

# 3. Real smoke test — exercise the graph data plane end to end:
#    create a workspace, add a repo, run a push, and confirm nodes land in Neo4j.
#    In the Neo4j browser (http://neo4j-host:7474) or cypher-shell:
#       MATCH (n:CodeNode) RETURN count(n);
#    A non-zero count after a push confirms COREDOC_DB_BACKEND=neo4j is active.
```

The health check now surfaces Neo4j **connectivity** failures (503) when
`COREDOC_DB_BACKEND=neo4j`, but it does not exercise writes or vector indexes —
**always run an actual push** as part of go-live to confirm the data plane end to end.

---

## 9. Operations

- **Upgrades:** rebuild the image, run the `migrate` step (§6) against Postgres,
  then restart `server`. Migrations are forward-only (`migrate deploy`).
- **Backups:** back up **both** Postgres (control plane) and Neo4j (the graph).
  Losing Neo4j loses parsed graphs; losing Postgres loses workspaces/members/tokens.
  GCS objects (parsed blobs, parsers) should be retained per your
  policy — they let you re-push without re-parsing.
- **Scaling:** the server is stateless apart from those backends. Run multiple
  replicas behind the proxy; keep migrations as a single pre-deploy job (don't run
  them per replica). One shared Neo4j serves all replicas.
- **Neo4j sizing:** incremental pushes apply a bounded changeset in a single
  transaction; size heap (`NEO4J_server_memory_heap_max__size`) to your largest
  repo. The default 4 GB is a reasonable start.

### Operator-only rollback for a file-snapshot workspace

There is no graph-rollback HTTP route. If an incident requires moving a
`file_snapshot` workspace back by one published version, run this statement
against its Postgres control plane. Supply only the workspace ID and the version
you currently expect to be active; the statement derives the parent from the
stored version history and returns both pointer values atomically:

```sql
\set workspace_id 'replace-with-workspace-uuid'
\set expected_active_version_id 'replace-with-active-version-id'

UPDATE workspaces w
   SET active_graph_version_id = v.parent_version_id
  FROM workspace_graph_versions v
 WHERE w.id = :'workspace_id'::uuid
   AND w.graph_backend = 'file_snapshot'
   AND w.active_graph_version_id = :'expected_active_version_id'
   AND v.workspace_id = w.id
   AND v.version_id = w.active_graph_version_id
RETURNING v.version_id AS rolled_back_from, v.parent_version_id AS rolled_back_to;
```

Exactly one returned row means the rollback succeeded. Zero rows means the
active pointer moved or the backend changed; re-inspect the workspace and do not
force the update. Rolling back the first published version returns
`rolled_back_to = NULL` and clears the active pointer. The file-snapshot version
history still exists, so this does not reopen the transition back to Turso.

For a zero-row result, this read-only diagnostic distinguishes a missing
workspace, backend/pointer drift, and a missing expected version without changing
the rollback precondition:

```sql
SELECT w.graph_backend,
       w.active_graph_version_id,
       EXISTS (
         SELECT 1
           FROM workspace_graph_versions gv
          WHERE gv.workspace_id = w.id
            AND gv.version_id = :'expected_active_version_id'
       ) AS expected_version_exists
  FROM workspaces w
 WHERE w.id = :'workspace_id'::uuid;
```

Do not wait for or require a quiescent job queue before running the statement.
The check would not be atomic with the update. A push that publishes afterward
uses the rolled-back version as its parent and can supersede the rollback by
design.

### Backend cutover (`turso` → `file_snapshot`)

There is no cutover route either: one operator UPDATE flips a workspace, so the
window has to be quiet. Set `\set workspace_id '…'` first (as above).

1. **Coordinate with the client:** they pause CI auto-sync and any manual
   `coredoc sync` / `coredoc mapper push` for the duration.
2. **Preflight — no in-flight graph work.** Must return `0`; `pending`/`running`
   are the non-terminal job statuses:

   ```sql
   SELECT count(*) FROM push_jobs
    WHERE workspace_id = :'workspace_id'::uuid
      AND status IN ('pending', 'running');
   ```

3. **Preflight — no legacy repos.** Must return zero rows. A repo that was pushed
   before versioned artifacts existed has applied-state markers but no selection,
   and the snapshot assembler refuses it (`Legacy repository … has no snapshot
   selections`):

   ```sql
   SELECT repo_name FROM workspace_repos
    WHERE workspace_id = :'workspace_id'::uuid
      AND (last_pushed_at IS NOT NULL OR last_parse_hash IS NOT NULL)
      AND last_parsed_version IS NULL
      AND last_summary_version IS NULL
      AND last_embed_version IS NULL;
   ```

   Fix: have the client run one ordinary push per listed repo (the push writes
   the selection), then re-run this preflight.
4. **Flip both columns in one statement.** The CHECK constraint
   `workspaces_file_snapshot_requires_retention_check` rejects `file_snapshot` with
   `retain_graph_artifacts = false`, so they must move together:

   ```sql
   UPDATE workspaces
      SET graph_backend = 'file_snapshot', retain_graph_artifacts = true
    WHERE id = :'workspace_id'::uuid AND graph_backend = 'turso'
   RETURNING id, graph_backend, retain_graph_artifacts;
   ```

5. **Resume client input.** The first sync after the flip publishes the first
   snapshot and sets `active_graph_version_id`.
6. **Reverse:** `UPDATE workspaces SET graph_backend = 'turso' WHERE id = …` is
   allowed. Readers then serve the retained (possibly stale) Turso state until
   the next ordinary push refreshes it. Leave `retain_graph_artifacts` at `true`
   — a DB trigger rejects clearing it, by design.

---

## 10. Troubleshooting & sharp edges

| Symptom | Cause | Fix |
|---|---|---|
| Every query: `relation "…" does not exist` | Migrations not applied | Run §6 against the Postgres in `DATABASE_URL`. |
| Push/MCP returns "no database available" or empty graph; nothing in Neo4j | `COREDOC_DB_BACKEND` not exactly `neo4j` (typo / wrong case / unset) → server took the Turso path | Set `COREDOC_DB_BACKEND=neo4j` (lowercase). Confirm with a push + `MATCH (n:CodeNode) RETURN count(n)`. |
| First graph request throws `NEO4J_PASSWORD … required` / connection error | Neo4j env missing or unreachable. With `COREDOC_DB_BACKEND=neo4j` the health check now catches this (503, `checks.neo4j.status: "down"`); if health is still **green** yet requests fail, the backend casing is wrong so Neo4j was skipped | Verify `NEO4J_URI/USER/PASSWORD` and bolt reachability (or fix the backend casing); re-run the push smoke test. |
| Container exits at boot before serving | Push worker's `onModuleInit` hits Postgres before the poll loop; if Postgres is unreachable/unmigrated it aborts bootstrap | Ensure Postgres is reachable **and migrated** before starting the server. `PUSH_WORKER_ENABLED=false` only makes sense on a read/MCP-only server — with the worker off, every remote push (`coredoc push --remote`, `coredoc ci run`, `coredoc sync`) stays queued forever. |
| Artifacts vanish on restart / CI push from another host can't find them | `R2_ENDPOINT` unset → local-disk fallback (`.r2-local/`, ephemeral, per-container) | Set the `R2_*` GCS vars (§5). For a single node that's fine, mount a persistent volume. |
| Artifact download fails (`InternalServerError`) on GCS | Presigned-URL (SigV4) signature rejected — usually `R2_REGION=auto` | Set `R2_REGION` to the bucket's real region. Presigned downloads (parser pull, result fetch) hard-fail on a bad signature; smoke-test after pointing at GCS. |
| Server exits at boot: `jwtSecret must be at least 32 characters` | `OAUTH_JWT_SECRET` too short or unset | Set a ≥ 32-char secret (`openssl rand -hex 32`). |
| Server exits at boot: `Login gate is empty` | `ALLOWED_EMAIL_DOMAINS` not set | Set it (§3.4). |
| Login rejected: `not in an allowed email domain` | User's verified GitHub primary email is outside the gate, or their company email is unverified on GitHub | Add their domain to `ALLOWED_EMAIL_DOMAINS`; have them verify that email on GitHub (unverified addresses are ignored). |
| Login fails / no token; redirect errors | Wrong GitHub OAuth App callback, or no egress to `github.com`/`api.github.com` | Callback must be `<MCP_SERVER_URL>/callback`; allow outbound HTTPS to GitHub. |
| Token issued but user can't access any workspace | Authenticated but not a member | Seed the first admin, then invite (§3.4). |
| MCP OAuth discovery 404 / empty | `MCP_SERVER_URL` unset or wrong host | Set `MCP_SERVER_URL` to the public host; the well-knowns are served at `/.well-known/...` (root, not under `/api/v1`). |

> **Mixed env validation.** The **auth** server validates eagerly — a short
> `OAUTH_JWT_SECRET` or an empty login gate **aborts boot** (fail fast). The
> **data-plane** reads are still soft: wrong backend casing or a missing Neo4j
> boots cleanly and fails only at the relevant request. Treat the §8 push smoke
> test as mandatory.

---

## 11. Security checklist

- [ ] Put the server behind TLS (reverse proxy / load balancer); expose only 443.
- [ ] Restrict the Neo4j browser UI (7474) and bolt (7687) to the internal network.
- [ ] Strong, unique `NEO4J_PASSWORD`, Postgres password, and `SERVER_ENCRYPTION_KEY`.
- [ ] Strong `OAUTH_JWT_SECRET` (≥ 32 chars, `openssl rand -hex 32`); rotate to invalidate all issued tokens.
- [ ] Keep the login gate tight (`ALLOWED_EMAIL_DOMAINS`) — never leave it open to all GitHub users.
- [ ] Restrict the GitHub OAuth App callback to the exact public `https://<host>/callback`; keep the client secret out of source.
- [ ] Scope the GCS HMAC key's service account to the artifact bucket only.
- [ ] No CORS to configure — the API is consumed only by non-browser clients (CLI, MCP, CI/CD action), so no cross-origin policy is served. Add a fail-closed allowlist only if you later deploy a browser UI.
- [ ] Disable telemetry (`COREDOC_POSTHOG_*` unset) if data must stay on-prem.
- [ ] Outbound egress allow-list: `github.com` + `api.github.com` (auth) (+ your git host if pulling private repos).

---

## Appendix — minimal `.env` (Neo4j on-prem, GCS)

```dotenv
# Control plane
DATABASE_URL=postgresql://coredoc:CHANGE_ME@postgres:5432/coredoc

# Data plane (Neo4j — must be lowercase 'neo4j')
COREDOC_DB_BACKEND=neo4j
NEO4J_URI=bolt://neo4j:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=CHANGE_ME

# Auth (self-hosted OAuth 2.1 server, GitHub upstream)
GITHUB_CLIENT_ID=Ov23lixxx
GITHUB_CLIENT_SECRET=xxx
OAUTH_JWT_SECRET=generate-with-openssl-rand-hex-32   # >= 32 chars
# Login gate (required) — verified-email domains; server refuses to boot if empty
ALLOWED_EMAIL_DOMAINS=example.com

# Artifacts (Google Cloud Storage via S3-compatible API)
R2_ENDPOINT=https://storage.googleapis.com
R2_ACCESS_KEY_ID=GOOG1Exxx
R2_SECRET_ACCESS_KEY=xxx
R2_BUCKET=coredoc-artifacts
R2_REGION=us-east1

# Public base URL — OAuth issuer/resource (required) and MCP discovery
MCP_SERVER_URL=https://your-coredoc.example.com

# Hardening
NODE_ENV=production
SERVER_ENCRYPTION_KEY=generate-with-openssl-rand-base64-32
```
