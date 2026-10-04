# CI/CD Integration Guide

Automatically parse and push code graph data to your Coredoc workspace whenever code changes. This eliminates the need to manually run `parse` + `push --remote` after every change.

## How It Works

```
push to main → GitHub Action triggers → fetch parser from R2 → parse checkout → summarize (optional) → push results to workspace DB
```

1. **Parser Storage (Cloudflare R2)**: Extraction profiles are stored as `.tar.gz` archives in Cloudflare R2 (S3-compatible). This lets CI runners fetch them without access to your local machine.
2. **CI Run**: A single CLI command (`coredoc ci run`) orchestrates the entire flow — fetch parser, parse code, push results.
3. **Service Tokens**: Scoped tokens (`cdt_...`) with granular permissions authenticate CI requests without exposing user credentials.

The CLI reaches your runner through one of two channels, both shipping the tree-sitter grammars and the `scip-typescript` binary the engine needs — no local install or version pinning:

| Channel | Who it's for | How the download is gated |
|---|---|---|
| **Bundle** (default) | Coredoc cloud | Nothing extra. The server resolves the bundle on the public GitHub Release, and the action verifies the published SHA-256 before running it. No registry, no second credential. |
| **Docker image** | On-prem | Your registry pull credential — the same one that gets you the server image and Helm chart. Set the `image` input to select it. |

## Prerequisites

- A Coredoc cloud workspace
- A checked-in extraction profile (see the TS/JS starter in [Intent Loop Setup](intent-loop-setup.md)), or an existing cloud parser
- The default `ci` service token (graph publishing and explicit automatic intent permissions)
- (Optional) An LLM API key for AI summarization (e.g., [OpenRouter](https://openrouter.ai))

## Setup

### 1. Create a Service Token

Using an admin/owner user session in workspace settings or the API, mint the default `ci` token.
It includes parser/result read-write, repo:push, intent:bindings and intent:release; there is no separate intent token.
A token:manage service token cannot mint or reveal credentials. The permission and scope tables below list the exact grants.

### 2. Choose the parser source

For fresh setup, commit `.coredoc/profile.ts` and pass `profile-path: .coredoc/profile.ts`
to the action (`coredoc ci run --profile .coredoc/profile.ts`, or `COREDOC_PROFILE_PATH`).
CI validates and runs this source directly, without a prior cloud parser or local
Coredoc installation. The [setup guide](intent-loop-setup.md) includes a TS/JS starter.

If you already manage a cloud parser, omit `profile-path` to keep downloading it.
The existing local authoring path can publish that artifact with:

```bash
coredoc parser push -r <repo-name>
```

This creates a `.tar.gz` archive of the parser artifact (`profile.ts`, or a legacy `parser.ts` + `metadata.json`) and uploads it to R2. The CLI computes a SHA-256 hash and skips the upload if the remote version matches.

### 3. Configure GitHub Actions

Add the workflow file to your repository:

```yaml
# .github/workflows/coredoc.yml
name: Coredoc

on:
  push:
    branches: [main]

permissions:
  contents: read
  pull-requests: read

concurrency:
  group: coredoc-${{ github.repository }}-${{ github.ref }}
  cancel-in-progress: false

jobs:
  coredoc:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: '22'

      # scip-typescript resolves types from your repo's node_modules
      - run: npm ci

      - uses: yvp-core/coredoc-parser@main
        with:
          repo-name: my-backend
          workspace-id: ${{ secrets.COREDOC_WORKSPACE_ID }}
          token: ${{ secrets.COREDOC_TOKEN }}
```

The `@main` examples target the current pilot. Pin the tested published release or commit before customer rollout.

> **Prerequisites:** the job must (1) check out the repo, (2) install its dependencies (`npm ci` / `pnpm install`) before the step, and (3) have Node 22+ available. The runner also needs `curl`, `jq` and `tar` — standard on GitHub-hosted runners.

> **SCIP tier:** the bundle ships its own pinned `scip-typescript` and puts it on `PATH`, so there is nothing to install — and no npm call at parse time. A copy already on the runner's `PATH` wins, so you can override the pinned one. Without any indexer the engine still parses, but component and call edges resolve to nothing, and the push endpoint refuses that snapshot rather than overwriting a good one.

**On-prem** — add the `image` input to run the CLI from your registry instead of downloading the bundle:

```yaml
    # Runner must be authenticated to pull the Coredoc CLI image (e.g. a self-hosted org runner)
    runs-on: self-hosted
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - run: npm ci

      - uses: yvp-core/coredoc-parser@main
        with:
          repo-name: my-backend
          workspace-id: ${{ secrets.COREDOC_WORKSPACE_ID }}
          token: ${{ secrets.COREDOC_TOKEN }}
          image: ${{ vars.COREDOC_CLI_IMAGE }}   # e.g. ghcr.io/yvp-core/coredoc-cli:latest
          server-url: ${{ vars.COREDOC_SERVER_URL }}
```

Add these repository secrets in GitHub (Settings → Secrets and variables → Actions):

| Secret | Required | Description |
|--------|----------|-------------|
| `COREDOC_TOKEN` | Yes | Service token (`cdt_...`) |
| `COREDOC_WORKSPACE_ID` | Yes | Your workspace UUID |
| `OPENROUTER_API_KEY` | No | OpenRouter API key (enables AI summarization) |

### Optional Inputs

| Input | Default | Description |
|-------|---------|-------------|
| `image` | — | Run the CLI from this Docker image instead of the bundle (on-prem), e.g. `ghcr.io/yvp-core/coredoc-cli:latest`. The runner must be authenticated to pull it. |
| `cli-version` | `latest` | Bundle mode only. Pin the CLI bundle to a release: `latest` or `v<semver>`. |
| `server-url` | `https://api.coredoc.ai` | Coredoc server URL — set your own host for on-prem |
| `dry-run` | `false` | Parse without pushing (for testing) |
| `llm-api-key` | — | API key for LLM summarization. If not provided, summarization is skipped. |
| `llm-provider` | `openrouter` | LLM provider: `openrouter`, `openai`, `anthropic`, or a custom OpenAI-compatible URL |
| `llm-model` | `anthropic/claude-haiku-4-5-20251001` | Model to use for summarization |
| `push-timeout` | `15` | Minutes to wait for the server-side push job. The push is enqueued and polled — no long-lived HTTP connection — so on timeout the job keeps running server-side; the step fails only so you notice, and a later run picks up the published graph. |

### 4. Enable AI Summarization (Optional)

AI summarization generates function-level, repository-level, and package-level summaries during CI. These summaries power cross-repo understanding in the MCP server and desktop app — without them, AI tools must re-read raw code to understand what services do.

Add an LLM API key to your repository secrets and pass it to the action:

```yaml
- uses: yvp-core/coredoc-parser@main
  with:
    repo-name: my-backend
    workspace-id: ${{ secrets.COREDOC_WORKSPACE_ID }}
    token: ${{ secrets.COREDOC_TOKEN }}
    llm-api-key: ${{ secrets.OPENROUTER_API_KEY }}
```

**Default provider is [OpenRouter](https://openrouter.ai)** — it routes to any model (Claude, GPT, Llama, etc.) through a single API key. The default model is `anthropic/claude-haiku-4-5-20251001` which is fast and cheap (~$0.01–0.10 per CI run for most repos).

**Corporate / self-hosted LLMs** — pass a custom OpenAI-compatible endpoint:

```yaml
- uses: yvp-core/coredoc-parser@main
  with:
    repo-name: my-backend
    workspace-id: ${{ secrets.COREDOC_WORKSPACE_ID }}
    token: ${{ secrets.COREDOC_TOKEN }}
    llm-api-key: ${{ secrets.CORPORATE_LLM_KEY }}
    llm-provider: https://llm.internal.corp.com/v1
    llm-model: gpt-4o-mini
```

**How it works:**

1. Fetches previous summaries from R2 (if any exist)
2. Topologically sorts functions (leaf functions first, callers after callees)
3. Summarizes only changed functions (cache by `versionedId` — content hash)
4. Passes callee summaries as context when summarizing callers
5. Regenerates repository and package summaries when any function changed
6. Uploads new summaries to R2 and includes them in the push

If the LLM is unreachable or fails, the CI run continues without summaries — parsed data is still pushed.

## CLI Commands

### `coredoc ci run`

Full CI orchestration command. Fetches parser → parses repo → pushes results.

```bash
# Using environment variables
COREDOC_TOKEN=cdt_xxx COREDOC_WORKSPACE_ID=abc coredoc ci run -r backend

# Using flags
coredoc ci run -r backend --workspace-id abc

# Dry run (parse only, no push)
coredoc ci run -r backend --dry-run
```

**Environment variables** (loaded from `.env` in cwd or `~/.coredoc/.env`):

| Variable | Required | Description |
|----------|----------|-------------|
| `COREDOC_TOKEN` | Yes | Service token |
| `COREDOC_WORKSPACE_ID` | Yes | Target workspace |
| `COREDOC_SERVER_URL` | No | Server URL (default: `https://api.coredoc.ai`) |
| `COREDOC_LLM_API_KEY` | No | API key for LLM summarization (enables summarize step) |
| `COREDOC_LLM_PROVIDER` | No | LLM provider (default: `openrouter`) |
| `COREDOC_LLM_MODEL` | No | Model identifier (default: `anthropic/claude-haiku-4-5-20251001`) |

**Output**: JSON to stdout with parse results:
```json
{
  "status": "success",
  "repo": "backend",
  "nodes": 142,
  "edges": 87,
  "files": 35,
  "functions": 98,
  "parserVersion": "a1b2c3d4e5f67890",
  "summaryStats": {
    "summarized": 12,
    "cached": 86,
    "failed": 0
  }
}
```

The `summaryStats` field is only present when `COREDOC_LLM_API_KEY` is set.

### `coredoc parser push`

Upload a local parser to the cloud workspace.

```bash
coredoc parser push -r <repo-name> [--parser-dir ./coredoc-parsers]
```

Skips upload if the remote version hash matches the local archive.

### `coredoc parser pull`

Download a parser from the cloud workspace.

```bash
coredoc parser pull -r <repo-name> [--target-dir ./parsers]
```

### `coredoc parser list`

List all parsers stored in the workspace.

```bash
coredoc parser list
```

## Architecture

### Parser Artifact Storage

```
┌─────────────┐     tar.gz      ┌──────────────┐
│  Local Dev   │ ──parser push──→│ Cloudflare R2│
│  profile.ts  │                 │  (S3-compat) │
└─────────────┘                 └──────┬───────┘
                                        │ parser pull / ci run
                                        ▼
                                ┌──────────────┐
                                │  CI Runner   │
                                │  (GitHub)    │
                                └──────┬───────┘
                                       │ push results
                                       ▼
                                ┌──────────────────┐
                                │ Workspace graph  │
                                │ (Ladybug snapshot│
                                │  file on R2)     │
                                └──────────────────┘
```

**R2 key format**: `{workspaceId}/{repoName}/parser.tar.gz`

**Prisma metadata** (`ParserArtifact` model):
- `workspaceId` + `repoName` (unique pair)
- `sha256` — content hash for version comparison
- `sizeBytes`, `uploadedBy`, `uploadedAt`
- `r2Key` — reference to the R2 object

### Service Token Permissions

Tokens are prefixed with `cdt_` and carry a set of permission strings:

| Permission | Grants |
|-----------|--------|
| `parser:read` | Download parser artifacts |
| `parser:write` | Upload/delete parser artifacts |
| `repo:push` | Push parsed data to workspace |
| `result:read` | Download parsed results and summaries from R2 |
| `result:write` | Upload parsed results and summaries to R2 |
| `intent:release` | Record an intent release (`kind: release`) after a production deploy |
| `intent:bindings` | Apply a PR's intent anchor mapping to the published snapshot, with per-repo progress; no manifest or intent text read |
| `*` | Wildcard — all permissions except the intent ones below |

The `PermissionsGuard` enforces permissions declared via `@RequirePermission()` decorators on controller endpoints.

Intent permissions (`intent:read`, `intent:propose`, `intent:release`, `intent:bindings`) are exempt from the `*`
wildcard: a legacy grant-all token never gains them. Each comes from a deliberate scope minted by
an admin **from a user session** — a service token cannot mint one:

| Scope | Permissions | Use |
|-------|-------------|-----|
| `ci` (default) | `parser:read`, `parser:write`, `result:read`, `result:write`, `repo:push`, `intent:release`, `intent:bindings` | One CI/CD token for graph publishing, bindings and deployment releases |
| `intent-agent` | `intent:read`, `intent:propose` | Hosted MCP credential for agents |

Existing standard CI tokens gain `intent:release` and `intent:bindings` through migration
`20260912233000_ci_token_intent_permissions`. Their secret values, hashes and expiry stay unchanged;
there is no token rotation or extra secret to configure. The migration recognizes the exact prior
CI permission set (also tolerating either new permission already present); wildcard, custom,
telemetry and MCP tokens are not upgraded. New CI tokens receive both grants at mint time.
The separate `intent-release` mint scope has been removed; `intent-agent` remains for MCP.
Existing workflows must remove `intent-release-token:` and provide the current `ci` credential via
`token:`. The old input is no longer read. Keep `intent-release: true` only after successful deployment.
Custom/wildcard credentials need an explicitly minted CI token; the migration does not broaden them.

### CI credential trust and rollback

The single CI credential is trusted to publish graphs, reconcile CI-owned bindings and assert
production delivery in a repository whose effective mode is `deploy`. A leaked CI token can
call those APIs directly. `intent-release: 'true'` controls whether the action runs its release
step; leaving it false does not remove the token's API permissions. This intentionally replaces
the former isolation between graph publishing and a separately held release credential.
The token still cannot propose or review rules, change settings, or record a baseline, rollback
or plan. Minting CI/intent-agent credentials, or revealing credentials with explicit intent
permissions, requires an admin user session; a `token:manage` service token cannot use those
operations to obtain intent grants.

Code executed in a credential-bearing job shares that trust: review the workflow and checked-in
parser profile with the code, and use a reviewed, pinned action revision for customer rollout.

Before applying `20260912233000_ci_token_intent_permissions` in production, save the IDs and
permission arrays selected by its UPDATE predicate in a protected deployment backup; no token
plaintext is needed. Reverting the application does not undo the backfill. To roll back grants,
stop upgraded token minting and restore the saved arrays for those IDs, or revoke and replace
the affected credentials. Review tokens minted after the backup separately. Do not remove intent
permissions from every token: some credentials already held those grants before the migration.

For an exact permission rollback, use a protected pre-migration snapshot containing only
`id, permissions`. In a maintenance window (token minting/grant edits paused), export it with
psql `\copy (SELECT id, permissions FROM service_tokens) TO '/protected/ci-token-permissions.csv' CSV HEADER`.
No hashes, ciphertext or plaintext credentials belong in that export. Restore in a transaction:

```sql
BEGIN;
CREATE TEMP TABLE prior_ci_permissions (id uuid PRIMARY KEY, permissions text[]) ON COMMIT DROP;
-- psql command; the CSV is the protected pre-migration snapshot, not a current export.
\copy prior_ci_permissions FROM '/protected/ci-token-permissions.csv' CSV HEADER
UPDATE service_tokens AS token
SET permissions = prior.permissions
FROM prior_ci_permissions AS prior
WHERE token.id = prior.id
  AND prior.permissions @> ARRAY['parser:read','parser:write','result:read','result:write','repo:push']::text[]
  AND prior.permissions <@ ARRAY['parser:read','parser:write','result:read','result:write','repo:push','intent:release','intent:bindings']::text[]
  AND NOT prior.permissions @> ARRAY['intent:release','intent:bindings']::text[]
  AND token.permissions = prior.permissions || ARRAY(
    SELECT permission FROM unnest(ARRAY['intent:release','intent:bindings']::text[]) AS permission
    WHERE NOT permission = ANY(prior.permissions)
  );
COMMIT;
```

The final equality preserves tokens whose grants changed independently after migration. Review
unmatched/new tokens separately and revoke/reissue if needed; this operation cannot reconstruct
a missing backup and does not restore revoked/deleted credentials.

## Recording a Product-Intent Release from CI

Use the same `COREDOC_TOKEN` for graph publishing and deployment evidence. To record production delivery,
run the action after the successful production deploy with `intent-release: 'true'`. The flag defaults
to false, and dry runs never record releases. Set the repository's effective release mode to `deploy`;
other modes refuse the release with `release_mode_forbids`. A workspace with intent turned off refuses
it with `intent_disabled` — the whole automatic intent machinery is inert until the feature is enabled.
While the temporary [`INTENT_ROLES` rollout](intent-loop-setup.md#temporary-role-limited-rollout-intent_roles)
is set, the token's minter must hold a listed role, or the release gets the same `intent_disabled`.

CI cannot propose, accept/reject/supersede rules, change workspace settings, or record a baseline,
rollback or plan. CI and intent-agent token minting requires an admin user session.

### Structured handoff and deploy evidence

The plugin saves bindings and strict delivers/retires through `intent_handoff` in the
user's workspace session. PR-body text is display only. The server verifies the PR
head at merge and uses Compare API against the published graph before applying links.
See [the setup flow](intent-loop-setup.md#per-change-session-handoff).

Run the action after a successful production deployment, with `intent-release: 'true'`
and `deploy-ref` set to the deployed ref. It resolves that ref to a full SHA and reads
`run_started_at` from attempt 1 of the Actions run. It sends only the repo, commit,
`github.run_id` and that original time. Re-run attempts retain the same identity/time.
The server reads declarations from the handoff, never from CI input or a PR body.

```bash
coredoc intent release \
  --workspace-id "$WORKSPACE_ID" --repo my-backend --ref "$DEPLOYED_SHA" \
  --deploy-id "$RUN_ID" --deployed-at "$RUN_STARTED_AT"
```

`--ref` is a full commit SHA. Optional `--handoff-id <uuid>` identifies a specific server
operation; otherwise the server resolves the single associated PR using connector
credentials. Zero/multiple PRs are an explicit refusal. No handoff/declarations returns
no_delivery. An identified stale/unmerged handoff is refused, and CI cannot replace its
declarations. Deployment ID and timestamp have no defaults. Existing strict version,
idempotency and per-repository ordering rules still apply. Mapping failures do not block
truthful delivery, and delivery failures do not block valid mapping.

The deploy step needs `contents: read` and `actions: read` on GITHUB_TOKEN to resolve the
ref and original run time. PR metadata/comparisons use the server connector credentials.
Graph-only jobs do not forward GITHUB_TOKEN into the parser container and need no PR history.

### Cutover

Deploy the additive handoff migration plus API/worker, then CLI/action and plugin. Pause
the old automatic writer while switching. Existing ledger history and active anchors stay;
legacy checkpoint columns and the previously granted intent:bindings permission are retained
but no external mapping route consumes them. Roll back by disabling the new writer and
retaining handoffs for recovery, not by restoring PR-body writes alongside it.

### Server Endpoints

All under `/api/v1/workspaces/:workspaceId/parsers`:

| Method | Path | Permission | Description |
|--------|------|-----------|-------------|
| `GET` | `/` | `parser:read` | List all parsers |
| `POST` | `/:repoName` | `parser:write` | Upload parser (body: tar.gz) |
| `GET` | `/:repoName` | `parser:read` | Download parser (returns tar.gz) |
| `GET` | `/:repoName/meta` | `parser:read` | Get parser metadata/version |
| `DELETE` | `/:repoName` | `parser:write` | Delete parser |

### Push endpoint

| Method | Path | Permission | Description |
|--------|------|-----------|-------------|
| `POST` | `/api/v1/workspaces/:workspaceId/repos/:repoName/push` | `repo:push` | Push parsed repo data |
| `POST` | `/api/v1/workspaces/:workspaceId/repos/:repoName/results/upload` | `result:write` | Upload parsed result to R2 |
| `GET` | `/api/v1/workspaces/:workspaceId/repos/:repoName/summaries/latest` | `result:read` | Get latest summary (presigned R2 URL or inline) |
| `POST` | `/api/v1/workspaces/:workspaceId/repos/:repoName/summaries/upload` | `result:write` | Upload summary to R2 |

## Server Configuration

### R2 Environment Variables

Set these on the server (not the CI runner):

```bash
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=<your-access-key>
R2_SECRET_ACCESS_KEY=<your-secret-key>
R2_BUCKET=coredoc-parsers          # optional, defaults to "coredoc-parsers"
```

When `R2_ENDPOINT` is not set, the server falls back to local filesystem storage in `.r2-local/` (useful for development).

## Troubleshooting

### "No parser found for repo"
You need to push a parser first: `coredoc parser push -r <repo-name>`

### "Service token missing required permission(s)"
Use the workspace settings to mint a standard `ci` token, which includes parser/result access,
`repo:push`, `intent:bindings` and `intent:release`. The creator must remain a workspace member for
anchor apply; after offboarding, an active admin should revoke and replace that credential.
A service-token scope does not replace workspace membership.

### Call/external-call edges are missing (0 edges)
The engine's SCIP tier shells out to `scip-typescript`, which needs the target repo's installed dependencies. Both channels ship `scip-typescript`, but the **checked-out repo** must have its `node_modules` — run `npm ci` / `pnpm install` in the job before the action. Without it, parsing still succeeds but call and external-call edges are incomplete.

### "scip-typescript failed: … JavaScript heap out of memory"
The indexer holds the repo's whole TypeScript program in one V8 heap. The CLI gives it an 8 GB ceiling by default, so this now means the **runner** is short on real memory: give the job (or the Docker host in image mode) at least 8 GB, or lower the ceiling to what the runner actually has with `COREDOC_SCIP_MAX_OLD_SPACE_MB` (in MB; forwarded into the container in image mode). A child killed with `SIGKILL` instead of a V8 OOM is the cgroup limit, not the heap.

### "Failed to get CLI bundle download URL" (bundle mode)
This is usually a `server-url` pointing somewhere that doesn't serve `/api/v1/cli/bundle` (it is off unless `ENABLE_CLI_BUNDLE=true`), a `cli-version` that was never published, or a server that cannot reach GitHub. `latest` always resolves if any bundle exists.

### "CLI bundle SHA-256 mismatch" (bundle mode)
The downloaded file doesn't match the hash the server published for that version — a truncated download or a tampered object. The action refuses to run it. Re-run the job; if it persists, report the version, since it means the release assets and their descriptor disagree.

### Runner can't pull the CLI image (image mode)
`docker run` needs registry access. Use a runner already authenticated to your registry (self-hosted org runners inherit it), or add a `docker login` / `gcloud auth configure-docker` step before the action.

### Large repos time out during push
The push endpoint has an advisory lock per repo. For very large repos (10k+ functions), the push may take several minutes. The CLI sets a 5-minute timeout on push requests.