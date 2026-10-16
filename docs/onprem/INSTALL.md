# Coredoc On-Prem — Installation Guide (Kubernetes / Helm)

Install the Coredoc self-hosted server on Kubernetes with the official Helm
chart, published as an OCI artifact at `oci://ghcr.io/yvp-core/charts/coredoc`.

This is the customer packaging guide. For the underlying architecture, the full
environment-variable reference, and the Docker-Compose (single-VM) topology,
see [`apps/server/ONPREM.md`](../../apps/server/ONPREM.md) — everything the
chart configures maps 1:1 onto the env documented there.

- Upgrades: [UPGRADE.md](UPGRADE.md)
- Resource sizing: [SIZING.md](SIZING.md)
- Cloud agent runs and the agent runner (optional): [AGENT-RUNS.md](AGENT-RUNS.md)

---

## 1. What the chart deploys

- **coredoc-server** (NestJS API + MCP endpoint, port 3000) — Deployment,
  Service, Ingress.
- **Neo4j** (the code-graph data plane) — the upstream Neo4j community chart
  as an in-cluster subchart (`neo4j.enabled=true`, default), or bring your own.
- **Prisma migration Job** — a separate lifecycle-hook Job (never run on
  container boot).
- **Agent runner** (optional, `agentRunner.enabled=false` by default) — a
  separate Deployment for cloud agent runs, with its own image and Secret and
  none of the server's. See [AGENT-RUNS.md](AGENT-RUNS.md).

It does **not** deploy Postgres (control plane) or object storage — those are
external prerequisites by design.

## 2. Prerequisites

| Dependency | Requirement |
|---|---|
| Kubernetes | A cluster you can `helm install` into (Helm 3.8+ for OCI registries) |
| Ingress controller | **ingress-nginx** (the chart's default annotations are tuned for it — see §6.7) |
| **Postgres** (external) | 16+; managed/production-grade (backups, PITR). Holds workspaces, members, tokens. |
| **Object storage** | Any S3-compatible endpoint: GCS interop, Cloudflare R2, MinIO, AWS S3 |
| DNS + TLS | A public hostname for the server (e.g. `coredoc.example.com`) with TLS termination at the ingress |
| Upstream identity provider | A GitHub OAuth App **or** a WorkOS AuthKit application (§4) |

> **It's two databases, not one.** Neo4j is the code-graph data plane; Postgres
> is the control plane. Both are required.

## 3. Registry access (ghcr pull secret)

The server image lives at `ghcr.io/yvp-core/coredoc-server`. If your cluster
cannot pull from ghcr.io anonymously, create a pull secret and reference it in
your values:

```bash
kubectl create secret docker-registry ghcr-pull \
  --docker-server=ghcr.io \
  --docker-username=<github-username> \
  --docker-password=<github-token-with-read:packages> \
  -n coredoc
```

```yaml
image:
  pullSecrets: [ghcr-pull]
```

### 3.1 Verify the signatures and SBOMs (supply chain)

Every released image and the Helm chart are signed **keyless** with
[cosign](https://docs.sigstore.dev/) from the release workflow's GitHub OIDC
identity — there is no public key to distribute. Signatures are made over the
image **digest**, so verify by digest (or by tag, which cosign resolves to the
digest for you):

```bash
COSIGN_IDENTITY='^https://github\.com/yvp-core/coredoc-platform/\.github/workflows/release\.yml@refs/tags/server-v'

cosign verify \
  --certificate-identity-regexp "$COSIGN_IDENTITY" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/yvp-core/coredoc-server:<version>

cosign verify \
  --certificate-identity-regexp "$COSIGN_IDENTITY" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/yvp-core/coredoc-cli:<version>

cosign verify \
  --certificate-identity-regexp "$COSIGN_IDENTITY" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/yvp-core/charts/coredoc:<version>

# Only if you run cloud agent runs (AGENT-RUNS.md): verify the base of your
# derived runner image.
cosign verify \
  --certificate-identity-regexp "$COSIGN_IDENTITY" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/yvp-core/coredoc-agent-runner:<version>
```

A failed verification means the artifact was not produced by this repo's
release workflow — do not deploy it.

> **Post-release smoke (Coredoc maintainers):** immediately after a `v*`
> release finishes, run the three `cosign verify` commands above against the
> new tag — that is the only check that the workflow's real OIDC identity still
> matches the regexp published here.

Each image also carries buildx **provenance** (SLSA, `mode=max`) and an SBOM
attestation:

```bash
cosign download attestation ghcr.io/yvp-core/coredoc-server:<version>
```

For scanners that want a plain file, every GitHub Release attaches standalone
SPDX documents — `coredoc-server-<version>.spdx.json`,
`coredoc-cli-<version>.spdx.json` and `coredoc-agent-runner-<version>.spdx.json`
— and the air-gap kit carries the same files under `sboms/` (§10).

Pin the verified digest in your values so the cluster deploys exactly those
bytes (a digest beats `image.tag` when both are set):

```yaml
image:
  repository: ghcr.io/yvp-core/coredoc-server
  digest: "sha256:<64 hex from cosign/crane digest>"
```

## 4. Upstream OAuth application

The server is its own OAuth 2.1 authorization server; it only needs an
*upstream* identity provider for the login dance. Pick one:

### 4.1 GitHub (default — `auth.upstream: github`)

1. GitHub → Settings → Developer settings → **OAuth Apps** → *New OAuth App*
   (an OAuth App, **not** a GitHub App).
2. **Authorization callback URL**: `<server.publicUrl>/callback`, e.g.
   `https://coredoc.example.com/callback`.
3. Capture the **Client ID** and generate a **Client secret** — they go into
   the auth Secret (§5) as `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`.
4. You MUST set `auth.allowedEmailDomains` (the login gate): a user may sign in
   only if their **verified** GitHub email is in one of these domains. The
   server refuses to boot with an empty gate on the github upstream.

GitHub supplies identity only; Coredoc does not ask GitHub to send workspace
invitation mail. Inviting a member creates pending local access and the admin UI
returns a Coredoc sign-in link to copy through your normal communication
channel. The pending access activates only when the invitee signs in with the
same verified email address and expires 14 days after creation. If it expires,
an admin can renew it with
`POST /api/v1/workspaces/:id/members/invites/:invitationId/resend`; the response
again has `emailSent: false`, a renewed `expiresAt`, and the `signInUrl` to
share. Deployments that require automatic email delivery must use the WorkOS
upstream (or add a separate mail provider integration).

### 4.2 WorkOS AuthKit (`auth.upstream: workos`)

> **Upgrading an existing WorkOS deployment? Set the two new secrets first.**
> `WORKOS_AUTHKIT_CLIENT_ID` and `WORKOS_API_KEY` are now **required** whenever
> `OAUTH_UPSTREAM=workos`. The server validates them at startup and refuses to
> boot without them, so rolling the image before updating the auth Secret gives
> you `CrashLoopBackOff`, not a degraded feature. Update the Secret, then roll.

Uses AuthKit as an OIDC provider (WorkOS Connect):

1. In the WorkOS dashboard, create a **Connect OAuth Application** with redirect
   URI `<server.publicUrl>/callback`. These credentials are used only for the
   WorkOS-as-upstream flow into Coredoc's OAuth server.
2. Set `auth.workos.authkitDomain` to your AuthKit domain, e.g.
   `https://yourco.authkit.app` (required when `upstream: workos`).
3. Put the application's credentials into the auth Secret (§5) as
   `WORKOS_CLIENT_ID` / `WORKOS_CLIENT_SECRET`.
4. Under **Applications**, use the AuthKit Application that should own Coredoc
   invitation emails. Set its default redirect URI to
   `<server.publicUrl>/api/v1/auth/web/workos-invitation-callback`, keep its
   **User invitation URL** on the WorkOS-hosted default, and copy its Client ID
   to `WORKOS_AUTHKIT_CLIENT_ID`.
5. Create `WORKOS_API_KEY` in that AuthKit Application/environment. Coredoc uses
   it both to complete the hosted invitation callback and to manage workspace
   organizations/invitations. API-created invitations preserve the API key's
   AuthKit Application context; a key from the old desktop application sends
   invitees back to its loopback callback. This AuthKit Client ID/API key pair
   is separate from the Connect OAuth Application credentials in step 3.
   After acceptance, Coredoc completes its normal browser login and the API
   server returns a standalone handoff page where the invitee can open Coredoc
   Desktop or download it. This page does not require the optional web app.
   The Desktop action uses the registered `coredoc://login` protocol and always
   connects to the server already configured in Desktop. macOS downloads are
   resolved from the updater manifest of the latest stable Desktop GitHub
   Release. Publish a Desktop release built from this code (via a newer `v*`
   tag) before rolling out the server; older installed builds
   do not understand the invitation login action, so the handoff page leads
   with the latest download.
6. With WorkOS, the AuthKit tenant config (auth methods, SSO connections,
   domain policies) is the **primary** login gate; `auth.allowedEmailDomains`
   becomes an optional extra allowlist (may be left empty). The verified-email
   requirement still always applies.

## 5. Pre-create the Secrets

The chart never writes secrets — it references pre-created ones
(`charts/coredoc/values-example.yaml` carries the same commands):

```bash
# Auth — OAuth credentials + token-signing secret (>= 32 chars).
# github upstream shown; for workos use WORKOS_CLIENT_ID,
# WORKOS_CLIENT_SECRET, WORKOS_AUTHKIT_CLIENT_ID, and WORKOS_API_KEY.
kubectl create secret generic coredoc-auth \
  --from-literal=OAUTH_JWT_SECRET="$(openssl rand -hex 32)" \
  --from-literal=GITHUB_CLIENT_ID="Ov23li..." \
  --from-literal=GITHUB_CLIENT_SECRET="..." \
  --from-literal=SERVER_ENCRYPTION_KEY="$(openssl rand -base64 32)"

# Postgres control plane
kubectl create secret generic coredoc-postgres \
  --from-literal=DATABASE_URL="postgresql://coredoc:CHANGE_ME@postgres-host:5432/coredoc"

# Neo4j password — ONE secret, TWO keys (the upstream neo4j chart reads
# NEO4J_AUTH, the coredoc server reads NEO4J_PASSWORD)
NEO4J_PW="$(openssl rand -hex 16)"
kubectl create secret generic coredoc-neo4j-auth \
  --from-literal=NEO4J_AUTH="neo4j/${NEO4J_PW}" \
  --from-literal=NEO4J_PASSWORD="${NEO4J_PW}"

# Object storage credentials (keys are named R2_* for any S3-compatible store)
kubectl create secret generic coredoc-storage \
  --from-literal=R2_ACCESS_KEY_ID="..." \
  --from-literal=R2_SECRET_ACCESS_KEY="..."

# License file (only if you were issued one — see §6.9). The key MUST be
# named license.json.
kubectl create secret generic coredoc-license \
  --from-file=license.json=./coredoc-license.json
```

## 6. Values walkthrough

Start from `charts/coredoc/values-example.yaml`. Every key below is in the
chart's `values.yaml` with fuller inline comments.

### 6.1 `image`

| Key | Meaning |
|---|---|
| `image.repository` | `ghcr.io/yvp-core/coredoc-server` (override for air-gap, §10) |
| `image.tag` | Defaults to the chart's `appVersion` when empty — normally leave empty |
| `image.digest` | Optional `sha256:...` pin. **Wins over `tag`** — renders `repository@digest` (§3.1, §10) |
| `image.pullPolicy` | `IfNotPresent` |
| `image.pullSecrets` | Names of pre-created pull secrets, e.g. `[ghcr-pull]` (§3) |

### 6.2 `server`

| Key | Meaning |
|---|---|
| `server.publicUrl` | **REQUIRED.** Public `https://` base URL. Drives `MCP_SERVER_URL` (OAuth issuer / MCP discovery) and CORS. The OAuth callback registered upstream must be `<publicUrl>/callback`. Permanent: it is the `aud` of every issued MCP token, so changing it forces all connected MCP clients to re-authorize — to serve the UI on a second hostname use `server.webOrigins`. |
| `server.webOrigins` | Extra public base URLs the UI is served on, e.g. `[https://ai-dashboard.example.com]` → `WEB_ORIGINS`. Each gets a registered web-login callback, so a login started on that host completes there. Add the same hostnames to `ingress.extraHosts`; the identity provider needs no change. |
| `server.replicas` | Default 1. The server is stateless — scale freely; migrations stay a single hook Job. |
| `server.resources` | See [SIZING.md](SIZING.md). |
| `server.env` | Escape hatch: extra plain env vars (map). Rendered last, so it overrides chart-computed env — e.g. `NEO4J_URI` for an external Neo4j. |
| `server.extraEnvFrom` | Extra `secretRef`/`configMapRef` entries appended verbatim. |

### 6.3 `auth`

| Key | Meaning |
|---|---|
| `auth.upstream` | `github` (default) or `workos` (§4). |
| `auth.allowedEmailDomains` | Login gate — verified-email domains, e.g. `[example.com]`. **REQUIRED for github** (boot failure if empty); optional defense-in-depth for workos. |
| `auth.existingSecret` | **REQUIRED.** Pre-created Secret loaded via `envFrom`. Keys: `OAUTH_JWT_SECRET` (≥ 32 chars) plus `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` or `WORKOS_CLIENT_ID`/`WORKOS_CLIENT_SECRET`/`WORKOS_AUTHKIT_CLIENT_ID`/`WORKOS_API_KEY`; optionally `SERVER_ENCRYPTION_KEY` (encrypts CI/service tokens). |
| `auth.workos.authkitDomain` | AuthKit domain, e.g. `https://yourco.authkit.app`. Required when `upstream: workos`. |

### 6.4 `config` (feature flags)

All default **false**; rendered as literal `'true'`/`'false'` env strings:

| Key | Enables |
|---|---|
| `config.allowSourcesInGraph` | Pushes that include source-code bodies (`ALLOW_SOURCES_IN_GRAPH`) |
| `config.enableSourceModule` | `GET /workspaces/:id/source/...` git-provider fetch (`ENABLE_SOURCE_MODULE`) — adds outbound egress to your git host (§11) |
| `config.enableCliBundle` | `GET /cli/bundle` CLI bundle downloads from GitHub Releases (`ENABLE_CLI_BUNDLE`) — adds outbound egress to `github.com` + `api.github.com` (§11) |
| `config.enableSemanticSearch` | Sets `ENABLE_SEMANTIC_SEARCH` on the server. Currently a no-op there: the `semantic_search` tool is registered only by the **local stdio** MCP server (CLI-side), not the cloud/on-prem MCP surface. Leave `false`. |

### 6.5 `storage`

| Key | Meaning |
|---|---|
| `storage.endpoint` | S3-compatible endpoint, e.g. `https://storage.googleapis.com` or `https://<account>.r2.cloudflarestorage.com`. **Empty = container-local disk fallback** (ephemeral; single-node evaluation only). |
| `storage.bucket` | Bucket name (default `coredoc-artifacts`). |
| `storage.region` | The bucket's **real** region (e.g. `us-east1`) — never `auto`; presigned-URL signing fails with a wrong region. |
| `storage.existingSecret` | Pre-created Secret with `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`. |

### 6.6 `postgres` and `neo4j`

| Key | Meaning |
|---|---|
| `postgres.existingSecret` | **REQUIRED.** Pre-created Secret with key `DATABASE_URL` (`postgresql://user:pass@host:5432/coredoc`). The chart deliberately does not run Postgres in-cluster. |
| `neo4j.enabled` | `true` (default) deploys the in-cluster Neo4j subchart. `false` = bring your own: set `NEO4J_URI`/`NEO4J_USER` via `server.env` and `NEO4J_PASSWORD` via `server.extraEnvFrom`. |
| `neo4j.neo4j.passwordFromSecret` | Secret from §5 with `NEO4J_AUTH` + `NEO4J_PASSWORD` keys. Required when `neo4j.enabled`. |
| `neo4j.*` (everything else) | Upstream neo4j chart passthrough (edition, resources, heap env, volumes). Defaults: community edition, APOC + graph-data-science plugins, 2–4G heap, `defaultStorageClass` volume, ClusterIP. See [SIZING.md](SIZING.md). |

### 6.7 `ingress`

| Key | Meaning |
|---|---|
| `ingress.enabled` | Default `true`. |
| `ingress.className` | e.g. `nginx`. |
| `ingress.host` | Public hostname — should match `server.publicUrl`'s host. |
| `ingress.tls.enabled` / `tls.secretName` | Existing TLS secret, or leave empty when cert-manager sets it via annotations. |
| `ingress.extraHosts` | Additional hostnames routed to the same service (TLS + rules), e.g. `[ai-dashboard.example.com]`. Pair with `server.webOrigins` or logins started there finish on `publicUrl`. |
| `ingress.annotations` | Merged with (not replaced by) the **load-bearing** nginx defaults: `proxy-buffer-size: 16k` (the OAuth `/callback` 302 sets cookies that overflow nginx's default buffer → 502 otherwise) and `proxy-body-size: 100m` (parser-result uploads reach 100 MB; the app enforces per-route ceilings itself). |

### 6.8 `migrations` and `telemetry`

| Key | Meaning |
|---|---|
| `migrations.hook` | `helm` (default) — pre-install/pre-upgrade Helm hook Job. `argocd` — the Job renders with ArgoCD PreSync hook annotations. `manual` — no Job rendered; run `prisma migrate deploy` yourself (§8). |
| `telemetry.posthogKey` | Leave empty (default) for an on-prem privacy posture — telemetry is off when unset (§11). |

### 6.9 `license` (offline entitlement)

| Key | Meaning |
|---|---|
| `license.existingSecret` | Name of a Secret with a single key `license.json`. Empty (default) = **no licensing at all**. |

**Getting a license file.** We issue you a `coredoc-license.json`: a small JSON
document with your customer name, an expiry date, a grace period, and an
Ed25519 signature. It is verified entirely offline against a public key baked
into the server image — the deployment never contacts us, and nothing about
your usage leaves the cluster. Put it in a Secret (§5) and set
`license.existingSecret`; the chart mounts it read-only at
`/etc/coredoc/license.json` and points `COREDOC_LICENSE_FILE` at it.

**What expiry does.** Once past `expiresAt` *plus* the grace period, mutating
REST calls under `/api/v1` (pushes, workspace/member/token changes) are refused
with HTTP 403 and `{"code":"LICENSE_EXPIRED"}`. The background worker stops
importing too: it no longer enqueues the hourly connector sync, and no longer claims
queued push, resolve or connector-sync jobs, so no new external data comes in
behind the API's back. A job already running finishes; refused jobs simply wait
as `pending` and drain by themselves when the license is renewed. The one job
type it keeps claiming is `renormalize`, which imports nothing — it only
re-derives records the deployment already holds, and their raw sources are
deleted on a retention schedule that expiry does not pause, so pausing that work
would lose them for good.

**What expiry does NOT do.** Reads keep working, so the graph stays queryable;
MCP clients, OAuth login, and the health probes are never gated; readiness stays
200, so pods are not taken out of rotation; nothing is deleted and no data is
touched. MCP's one write, `submit_session_feedback`, also keeps working on
purpose: it records feedback about the MCP tools themselves, imports no product
data, and is the feedback we most want from a deployment whose license lapsed.

Renew by replacing the Secret's contents and restarting the pods (the server
also re-verifies the file hourly, so a fresh license is picked up within the
hour without a restart; if the file becomes unreadable, the server keeps the
entitlement it last verified but keeps ageing it, so expiry still happens on
schedule).

Check the current state at any time — the route is unauthenticated, like health:

```bash
curl -s https://coredoc.example.com/api/v1/license
# -> {"state":"valid"}
# state is one of: absent | valid | grace | expired
```

The route reports the state and nothing else — the customer name, expiry date
and grace window stay inside the cluster (they are in the license file you
mounted, and in the server's boot log).

> A **corrupt or forged** license file is a boot failure, not a silent
> downgrade: the pod refuses to start and logs the file path and the reason.
> Deployments with no `license.existingSecret` are unaffected by all of this.

## 7. Install

```bash
helm install coredoc oci://ghcr.io/yvp-core/charts/coredoc \
  --version <chart-version> \
  -f my-values.yaml \
  -n coredoc --create-namespace
```

The chart and images are versioned together: chart version == app version ==
image tag (leave `image.tag` empty and it follows the chart's `appVersion`).

## 8. Database migrations

Prisma migrations are a **separate step by design** — the container never runs
them on boot (avoids races with >1 replica).

- `migrations.hook: helm` (default) — the migration Job runs automatically
  before install/upgrade rollout. Nothing to do.
- `migrations.hook: argocd` — ArgoCD runs the Job as a PreSync hook. The new
  Deployment is not applied until migrations succeed, so application code never
  serves against the previous schema.
- `migrations.hook: manual` — run them yourself before rollout:

  ```bash
  kubectl run coredoc-migrate --rm -it --restart=Never \
    --image=ghcr.io/yvp-core/coredoc-server:<version> \
    --env="DATABASE_URL=postgresql://coredoc:...@postgres-host:5432/coredoc" \
    -- sh -c "cd apps/server && npx prisma migrate deploy"
  ```

## 9. First-workspace bootstrap

A user who passes the login gate can sign in but has **no workspace access**
until they are a member. Seed the very first owner directly in Postgres, keyed
by the email that matches their verified identity-provider email:

```sql
-- one-time bootstrap (psql against DATABASE_URL)
INSERT INTO workspaces (name, slug) VALUES ('Acme', 'acme') RETURNING id;
-- use the returned <workspace-id> below
INSERT INTO workspace_members (workspace_id, user_id, email, role, pending)
VALUES ('<workspace-id>', 'pending:admin@example.com', 'admin@example.com', 'owner', true);
```

On that admin's first login the pending row is re-keyed to their real user id;
they then invite the rest via `POST /api/v1/workspaces/:id/members/invites`.
With GitHub or another non-WorkOS upstream, the create response has
`emailSent: false` and includes `signInUrl`; share that link with the invitee.
The pending grant expires after 14 days (see `expiresAt`). To renew an expired
or unshared invite, call
`POST /api/v1/workspaces/:id/members/invites/:invitationId/resend` and share the
returned `signInUrl`; this starts a new 14-day activation window without an
email provider.
WorkOS mode lazily creates a WorkOS organization for the Coredoc workspace,
associates the existing owner, sends an organization-scoped AuthKit invitation,
and returns `emailSent: true`. GitHub and other upstreams never create or modify
WorkOS organizations.

Verify the deployment (see `apps/server/ONPREM.md` §8 for the full checklist):

```bash
curl -fsS https://coredoc.example.com/api/v1/health          # readiness: postgres + neo4j "up"
curl -fsS https://coredoc.example.com/.well-known/oauth-authorization-server
```

Then run a real push from the CLI and confirm nodes land in Neo4j
(`MATCH (n:CodeNode) RETURN count(n)`).

## 10. Air-gapped installation

Each release attaches an air-gap kit to the GitHub Release:
`coredoc-onprem-<version>.tar.gz`, containing:

```
images/  coredoc-server-<version>.tar, coredoc-cli-<version>.tar,
         coredoc-agent-runner-<version>.tar, neo4j-2026.05.0.tar
chart/   coredoc-<version>.tgz, values-example.yaml
docs/    INSTALL.md, UPGRADE.md, SIZING.md, AGENT-RUNS.md
sboms/   coredoc-server-<version>.spdx.json, coredoc-cli-<version>.spdx.json,
         coredoc-agent-runner-<version>.spdx.json
mirror.sh
digests.txt
SHA-256SUMS
```

`digests.txt` records the ghcr.io digest each `images/*.tar` was pulled by —
the release pipeline packs the kit **by digest**, not by tag, so these are the
exact bytes the cosign signatures and the SPDX documents in `sboms/` describe.
Use them as the argument to the `cosign verify` commands in §3.1 when you check
the kit's images from a connected host.

`SHA-256SUMS` covers every file in the kit (including `mirror.sh`,
`digests.txt` and `sboms/`) and `mirror.sh` refuses to run when it does not
match. Treat it as **corruption detection, not tamper evidence**: it travels
inside the same tarball, so anyone who can rewrite the kit can rewrite the
manifest with it. Tamper evidence comes from outside the kit — verify the
tarball against the `coredoc-onprem-<version>.tar.gz.sha256` published with the
GitHub Release assets, fetched over a trusted channel, and verify the images
themselves with `cosign` (§3.1) on a connected host.

1. Unpack and mirror the images into your registry with the bundled script —
   it verifies `SHA-256SUMS` first and refuses to touch anything on a mismatch,
   on a file the manifest does not list, or on a symlink or special file in the
   tree, then pushes every `images/*.tar` under your prefix, keeping each
   image's own name and tag:

   ```bash
   tar -xzf coredoc-onprem-<version>.tar.gz && cd coredoc-onprem-<version>
   ./mirror.sh --dry-run registry.internal   # prints the plan, changes nothing
   ./mirror.sh registry.internal             # or registry.internal/coredoc
   ```

   It uses [`crane`](https://github.com/google/go-containerregistry) when it is
   on `PATH` (no docker daemon needed on a bastion host) and falls back to
   `docker load` / `tag` / `push`; with neither installed it stops with an
   explicit error rather than half-mirroring. Log in to the target registry
   first (`crane auth login` or `docker login`).

   The kit's `sboms/` files are the same SPDX documents attached to the
   release (§3.1) — feed them to your scanner before promoting the images.

2. Point the chart at your registry. `mirror.sh` prints exactly this fragment,
   filled in with your prefix and the mirrored versions:

   ```yaml
   image:
     repository: registry.internal/coredoc-server
     tag: "<version>"
   # Printed only for the optional agent runner; point it at your derived
   # image once you build one (AGENT-RUNS.md §3).
   agentRunner:
     image:
       repository: registry.internal/coredoc-agent-runner
       tag: "<version>"
   neo4j:
     image:
       registry: registry.internal
       repository: neo4j
       tag: "2026.05.0"
   ```

   To deploy by immutable digest instead, replace `tag` with
   `digest: "sha256:..."`. Take that digest from **your** registry
   (`crane digest registry.internal/coredoc-server:<version>`): a kit image is
   re-pushed from a tarball, so its digest — and the cosign signature and
   attestations, which live beside the original manifest on ghcr.io and are
   not carried in the tarball — do not follow it. Verify against ghcr.io
   (§3.1) at the point where you download the kit, on a connected host.

3. Install from the local chart archive (no OCI pull needed):

   ```bash
   helm install coredoc chart/coredoc-<version>.tgz -f my-values.yaml -n coredoc
   ```

> **Auth is the air-gap boundary.** The OAuth login dance needs outbound HTTPS
> to `github.com` + `api.github.com` (github upstream) or your AuthKit domain
> (workos upstream). A fully offline cluster must at minimum allow that egress
> path, e.g. through an authenticated forward proxy.

## 11. Outbound connections

An installed Coredoc server makes exactly these outbound connections:

- **`github.com` + `api.github.com`** (github upstream) **or your WorkOS
  AuthKit domain + `api.workos.com`** (workos upstream) — OAuth plus optional
  workspace organization and invitation management.
- **The configured LLM provider, if any** — only for CLI/CI parse+summarize
  runs you configure (`COREDOC_LLM_*` in your CI); the server itself does not
  call an LLM.
- **Your Jira Cloud site and the GitHub connector's API host**
  (`api.github.com` or your GitHub Enterprise Server host) — only when a
  workspace adds Delivery analytics connectors. Cloud agent runs use the same
  two hosts for their trigger, issue reads, comments and pull request checks.
- **Your git host** — only if you enable `config.enableSourceModule`.
- **`github.com` + `objects.githubusercontent.com`** — the desktop updater
  manifest (`latest-mac.yml`) on the latest stable Desktop GitHub Release of
  `yvp-core/coredoc-platform`, fetched only when someone hits
  `GET /api/v1/auth/web/desktop-download` from the invitation handoff page.
  Blocking it returns 502 on that route and leaves everything else working.
  Set `server.env.DESKTOP_RELEASES_URL` to point at your own mirror of the
  manifest + DMGs if that host is outside your egress allowlist.
- **Nothing else from the server.** No telemetry unless you opt in: the PostHog client
  initializes only when `COREDOC_POSTHOG_KEY` **and** `COREDOC_POSTHOG_HOST`
  are both set (key via `telemetry.posthogKey`, host via `server.env`); with
  the defaults both are unset and no telemetry leaves the cluster.

The optional **agent runner** (cloud agent runs) is the one component that
calls an LLM: it reaches the model API or your gateway, GitHub, your package
registries and the Coredoc API, and sends the file contents the agent reads to
the model API. Its egress list and NetworkPolicy are in
[AGENT-RUNS.md §7](AGENT-RUNS.md#7-egress).

## 12. Desktop fleet configuration (MDM)

There is one universal Coredoc desktop build — no per-customer binaries. It
resolves its server URL at runtime, so an IT admin pins the fleet by dropping a
**managed config file** at a fixed OS path with an MDM profile (Jamf, Intune,
Ansible, …). Users then type nothing, and the app shows the server read-only
with a *"Managed by your organization"* note.

**Path (fixed, one per OS):**

| OS | Path |
|---|---|
| macOS | `/Library/Application Support/Coredoc/managed-config.json` |
| Windows | `C:\ProgramData\Coredoc\managed-config.json` |
| Linux | `/etc/coredoc/managed-config.json` |

**Contents** (both fields optional; the file is read once at app start):

```json
{
  "serverUrl": "https://coredoc.corp.example",
  "updateFeedUrl": "https://mirror.corp.example/coredoc-desktop"
}
```

- `serverUrl` — outranks every other source (session override, environment,
  the user's own saved choice, the build-time default).
- `updateFeedUrl` — points electron-updater at your own mirror of the release
  feed for closed networks. It is read **only** from this file, never from the
  environment or the UI, so a local process cannot redirect updates.
- Both must be `http://` or `https://` URLs. Malformed JSON, a non-object top
  level, a non-string field, or a non-http(s) URL ⇒ the app logs a warning and
  ignores **the whole file**, falling back to the unmanaged behaviour. It never
  refuses to start.

**Required ownership and permissions.** This file outranks everything else and
also pins the update feed, so on macOS and Linux the app refuses to trust it
unless it is:

- owned by **root** (uid 0), and
- **not group- or other-writable** (`0644` or stricter).

```bash
sudo install -o root -g wheel -m 0644 managed-config.json \
  "/Library/Application Support/Coredoc/managed-config.json"   # macOS
sudo install -o root -g root -m 0644 managed-config.json \
  /etc/coredoc/managed-config.json                              # Linux
```

A file that fails those checks is ignored with a warning, exactly like a
malformed one.

> **Windows residual risk.** Windows uses ACLs rather than POSIX
> owner/mode bits, so the app performs **no** ownership check there: it trusts
> `C:\ProgramData\Coredoc\` to be writable by administrators only, which is its
> default ACL. If your image loosens the ACLs on `C:\ProgramData`, restore them
> (or accept that a local non-admin user could repoint the app).

**Packaged builds ignore `COREDOC_MANAGED_CONFIG_PATH`.** That environment
variable is a development-only override of the path above; a packaged (shipped)
app never reads it, and on Windows a packaged app also ignores `%ProgramData%`
in favour of the literal `C:\ProgramData`. Environment variables are
per-process and user-controllable — honouring either in a shipped build would
hand any local process a fleet-wide redirect of both the server and the update
feed.
