# Intent Loop Setup

Pilot setup for the implemented intent loop. A complete installed-plugin/hosted-MCP/GitHub run
and a non-maintainer clean-machine run are still required before customer rollout. The path is
designed for a machine with no desktop app or local parser.

## What you get

The agent reads reviewed rules before editing, captures an already-approved spec,
implements it, and saves a structured `intent_handoff` through hosted MCP. The PR
body is a human summary. CI publishes the graph with its commit; the server verifies
the PR merge/head and ancestry, then applies anchors. Delivery is independent.

| Repo mode | Delivery evidence | Additional CI action |
| --- | --- | --- |
| merge | Verified production-branch PR merge | None |
| deploy | Successful production deployment of a commit containing the PR | `intent-release: true` after deploy |
| manual | Maintainer's explicit ledger action | None |

The existing worker checks due handoffs every minute (batches of 20), with five-minute
retries for missing facts/provider errors. Connector sync and graph publication wake
pending work. Either merge/publish order works; another code push is not required.

## Once: connect the repository

Turn intent on for the workspace first: the REST intent routes answer
`409 intent_disabled` while it is off. To show it to some roles first, see
[role-limited rollout](#temporary-role-limited-rollout-intent_roles).

For a TS/JS repository, ask the agent to add this starter to
`.coredoc/profile.ts` in the setup PR, adjusting `include` to the source roots.
Add `.coredoc-ci/` to `.gitignore` for generated CI artifacts.
No local Coredoc CLI, desktop app, `author-profile` installation, or parser upload
is needed. CI typechecks the profile and runs the existing parser engine.

```ts
import type { ExtractionProfile } from '@coredoc/profile-parser';

const profile: ExtractionProfile = {
  parserId: 'my-backend',
  substrate: {
    language: 'ts',
    include: ['src/**/*.ts', 'src/**/*.tsx'],
    exclude: ['**/*.d.ts', '**/*.test.ts', '**/*.spec.ts'],
  },
  callGraph: { resolveThis: true, resolveDI: true, resolveBare: true },
};
export default profile;
```

Keep the profile self-contained in that one file: CI stages `profile.ts`, not sibling files, so relative runtime imports are unsupported.

The type-only import is resolved by CI's bundled schema; do not add Coredoc as a
project dependency. This starter extracts files, symbols and calls. Framework
routes, entities and other conventions need profile rules when required; it is
not a claim that every framework has been mapped. Other languages need a profile
for their registered language provider. Existing cloud profiles still work when
`profile-path` is omitted. With `profile-path`, the checked-in source is used on
every run; CI does not maintain a second cloud parser artifact.

Mint a `ci` service token in workspace settings → Tokens, scope `ci`
(the default scope). This grants `parser:read`, `parser:write`, `result:read`, `result:write`,
`repo:push`, `intent:bindings`, `intent:release`. It cannot review rules or change workspace settings.

Choose the production branch once. Ask the agent to generate the setup PR from that
branch and the repository delivery mode. The desktop CI/CD panel generates the
corresponding workflow from saved repo settings, including the configured server URL and, in deploy mode, a separate deployment step. The example below uses the default server. With no
production branch yet it emits a manual bootstrap run, never a guessed `main`.
The example below assumes `main`; replace it with the chosen branch. After
merging, every push refreshes the graph automatically. CI checkout/indexing ref,
production merge branch, and the SHA confirmed by a successful deployment are
separate facts; a branch push is not deployment evidence.

```yaml
# .github/workflows/coredoc.yml
name: Coredoc

on:
  workflow_dispatch:
  push:
    branches: [main]

concurrency:
  group: coredoc-${{ github.repository }}-${{ github.ref }}
  cancel-in-progress: false

permissions:
  contents: read
  pull-requests: read

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
      - run: npm ci   # scip-typescript resolves types from node_modules
      - uses: yvp-core/coredoc-parser@main
        with:
          repo-name: my-backend
          intent-repo-key: github.com/your-org/your-repo # use the saved identity for an existing repo
          profile-path: .coredoc/profile.ts
          workspace-id: ${{ secrets.COREDOC_WORKSPACE_ID }}
          token: ${{ secrets.COREDOC_TOKEN }}
```

The `@main` reference is for the current pilot. Pin the published action release or commit when rolling this template out to customers. For optional LLM summaries, pass `llm-api-key: ${{ secrets.OPENROUTER_API_KEY }}` to the action. Without it, parsing and PR anchors still work.

Secrets: `COREDOC_TOKEN` (the `ci` token above) and `COREDOC_WORKSPACE_ID`. The first push
creates the workspace's repo record and sets its `gitUrl` from the pushed data — step 4 below
(the delivery connector) matches PRs to this repo by that `gitUrl`, so this push must land before
delivery connects anything.

## Once: set the release trigger and production branch

Both settings require a **user session**, not a service token:
`workspace:manage` is the permission that gates them and it is never granted to any mintable
service token (`ci` or `intent-agent`) — only a JWT-authenticated admin
request bypasses the permission check. A curl call with `COREDOC_TOKEN` will be refused.

Use the desktop repository settings, or a script running with your own logged-in browser session
(`Authorization` header carrying your session JWT, not a `cdt_...` token):

```bash
# Read connected repositories; use the returned repoKey (graph hash), not repoName.
curl "$COREDOC_SERVER_URL/api/v1/workspaces/$WORKSPACE_ID/repos" \
  -H "Authorization: Bearer $USER_SESSION_JWT"

# Set this repository's delivery mode and production branch — requires a user session
curl -X PATCH "$COREDOC_SERVER_URL/api/v1/workspaces/$WORKSPACE_ID/repos/$REPO_GRAPH_KEY" \
  -H "Authorization: Bearer $USER_SESSION_JWT" -H "Content-Type: application/json" \
  -d '{"productionBranch": "main", "intentReleaseTrigger": "merge"}'
```

The desktop **Intent release trigger** settings offer a workspace default and a
per-repository override. The server resolves `repo.intentReleaseTrigger ??
workspace.intentReleaseTrigger`; `null` restores inheritance, omission preserves
an existing override. Changing one repo does not change other repos. The
connector and the deploy-token guard use this same resolution.

`productionBranch` is tri-state: omit it to leave the stored value, or `null` to fall back to the
default branch the delivery connector reports. In `deploy` mode, use the same CI token and set
`intent-release: 'true'` on the action after the successful production deploy (see
`docs/ci-cd-integration.md`). Leave this flag false for graph-only and merge-mode runs.

## Once: connect GitHub delivery

Connect the delivery connector so Coredoc can see merged PRs on the repo (required for `merge`
mode; also what powers delivery analytics regardless of trigger):

```bash
curl -X POST "$COREDOC_SERVER_URL/api/v1/workspaces/$WORKSPACE_ID/delivery/connectors" \
  -H "Authorization: Bearer $USER_SESSION_JWT" -H "Content-Type: application/json" \
  -d '{
    "provider": "github",
    "token": "<github PAT with read access to the repo'"'"'s PRs>",
    "repos": ["owner/repo"]
  }'
```

Leave `baseUrl` empty for github.com (set it only for a GitHub Enterprise host). The sync runs
automatically every hour. To sync immediately instead of waiting:

```bash
curl -X POST "$COREDOC_SERVER_URL/api/v1/workspaces/$WORKSPACE_ID/delivery/connectors/$CONNECTOR_ID/sync" \
  -H "Authorization: Bearer $USER_SESSION_JWT"
```

This route is also `workspace:manage`-gated — user session only, same as step 3.

## Temporary: role-limited rollout (`INTENT_ROLES`)

While product managers fill in and verify intent, a deployment can limit who sees it
with the server variable `INTENT_ROLES`: a comma-separated list of workspace roles, for
example `owner,admin,product`. It needs no migration and changes no API. It will be
removed once intent is on for everyone. On Helm, set it through `server.env.INTENT_ROLES`.

- Unset or empty: intent follows the workspace's `intentEnabled` flag for every member.
- Set: intent counts as on for a caller only when the workspace has it on and the
  caller's role in that workspace is listed. Everyone else sees intent off: the web
  hides the Intent nav and route, the desktop hides the Intent tab, the MCP intent
  tools are hidden from `tools/list` and refused on `tools/call`, and every intent
  REST route answers `409 intent_disabled`.
- An unknown role name fails server boot.
- A service token resolves to the current role of the member who minted it. A CI
  token minted by a listed admin keeps recording releases; a token whose minter is
  outside the list is refused like its minter. Only admins and owners can mint CI
  and intent-agent tokens, from their own session.
- The automatic machinery has no caller and stays workspace-level: the handoff worker
  and merge-triggered releases run for any workspace with intent on.
- Workspace and repository settings (`intentEnabled`, release triggers,
  `intentRepoKey`) are admin settings outside the list's reach; responses to those
  writes report the stored flag.

## Member access and recovery

Any workspace member can save or repair a handoff from their human MCP session,
including a handoff started by another developer. These declarations can drive
automatic production delivery after the server verifies merge/deploy evidence.
This MVP trusts workspace membership for that operation; it does not require a
second approval or ownership of the GitHub PR. Accepting/superseding intent items
also happens in a member's own session, on a person's explicit approval of the
source document. CI tokens cannot author handoffs.

An access/configuration failure is `needs_attention` (`github_auth_required`,
`github_access_denied`, `github_source_unavailable`, or the named repository/config
reason). Restore access/configuration and sync the connector, or resave the handoff.
Temporary API/rate-limit/network failures and a snapshot that does not yet include
the merge retry automatically. Operations are retained, not silently skipped.

## Per change: session handoff

1. Read `get_intent_context` before editing and carry exact intent IDs/versions.
2. After approved implementation/review, call `intent_handoff` with `action: save`.
   Use a client UUID id, expectedVersion 0, idempotencyKey, repoKey, reviewed headSha,
   bindings, and strict delivers/retires. Bindings use file paths or `path#Name`, with
   explicit prior CI node IDs for replacements. Do not map every contextual constraint.
3. Save before opening the PR if necessary; attach prNumber after creation. Refresh
   headSha and changed locators after code changes using the returned version. Read back
   with get. Another session resumes using list/get; there is no local mapper file.
4. Merge. The server checks the reviewed head against the PR head, production branch,
   and Compare API membership of merge commit in the active graph snapshot.
5. Check `handoffFreshness` in the next task context. A list read returns compact
   `{pending, needsAttention}` counts; `pending` retries automatically. When
   `needsAttention` is above zero, re-read with `mode: "list"` and `includeDiagnostics: true`
   (diagnostics are list-mode only) to get the
   operation ids — stale handoffs, unresolved/ambiguous targets or refused delivery —
   then inspect and correct each through `intent_handoff get` and the same session tool.

Accepted current authority is required for anchors; delivery uses strict named versions.
An anchor is an implementation touchpoint, not proof of correct behavior. Partial mapping
preserves unresolved items' existing links. Manual/disabled anchors are preserved. Explicit
supersedesMappingIds close earlier unresolved mapping only after the replacement succeeds;
an equal itemId never implies replacement. Recorded delivery cannot be rewritten.

## Verify before customer rollout

Run one new task with the installed plugin and hosted MCP: spec approval → capture/accept
once → context before edits → code/review → save without PR → open/attach PR → merge →
CI graph publication → applied anchors/recorded delivery → retrieval by the next task.
Exercise deploy mode separately with a successful production deploy. Save returned operation
IDs and inspect states, exact PR/head/ref and ledger provenance. Fixture tests do not prove
OAuth/classifier behavior, real GitHub credentials, installation or clean-machine onboarding.

## Rollout and retained limits

Deploy migration `20260914120000_intent_handoffs`, API and worker together before updating
the CLI/action and workflow plugin. Disable the old worker during the cutover: there must
be one automatic writer. Old PR-body declarations are ignored; open PRs need their session
agent to save a handoff. Existing active anchors and ledger history are not erased.

No external CI anchor route, checkpoint, manifest, GraphQL or Markdown parser is used.
Legacy checkpoint columns and existing token grants are retained as inert compatibility
data, not reinterpreted. The same CI token publishes graphs and records deploy evidence;
it cannot author a handoff or decide authority. See [credential rollback](ci-cd-integration.md#ci-credential-trust-and-rollback).

The connector needs read access to PR metadata and comparisons on the registered repository.
Configure GHES through the connector's HTTPS base URL. The deploy action's GITHUB_TOKEN
needs contents:read and actions:read, solely to resolve the deployed ref and attempt-1 time;
it is not forwarded into the graph container. Automatic deploy discovery currently requires
one PR for the deployed commit; direct CLI callers may pass --handoff-id to disambiguate,
with the same server merge/head/ancestry checks. Multiple-PR deployment aggregation is not
implemented. Human-maintained multi-PR release trains need explicit handoff calls per change.

Cutover of existing PRs: after installing the compatible server/plugin, resume each open intent-bearing PR once to save its structured handoff. Old body trailers are display only and do not migrate automatically. Existing connector plans are protected from automatic withdraw until the PR that originated each plan has a handoff; syncing an unrelated PR cannot remove them. After that PR joins the handoff flow, an explicit removal or close can withdraw the plan normally. A PR that deployed the handoff API itself needs a separate explicit session handoff if it is to appear in this flow. New-task E2E begins after the rollout.

The merge worker retries at five-minute intervals and checks pending declarations across its batch boundary before recording a newer merge. Stale versions/heads and merges into a non-production branch appear as `needs_attention`. A declaration first submitted after a newer delivery may still be refused by the existing strict ledger ordering; it is never silently backdated.
