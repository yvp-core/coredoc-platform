# coredoc-parser eval target — citation log

Truth for `evals/targets/coredoc-parser.json` was curated against:

- Path: the coredoc repository checkout
- Commit: `643dcc4ff04104379a4e61031c9cf9384449e99d` (`main`, "feat(server): per-workspace cypher capability…")
- Graph: local SQLite graph `coredoc.db.d/cd.db`, repo hash prefix `bc00cfcd84ff`, repoKey `coredoc-parser`
- Curated 2026-08-21.
- **Second pass, 2026-08-21:** `entrypointDeepDive`, `dataFlowTrace`, `entityImpact`,
  `typeImpact` and `serviceDependencyMap` were re-curated **from source only** and now carry
  hand-curated `expected*` overrides, so no case falls back to graph truth. Scoring a graph
  against itself is circular: the bar moves with whatever the parser captured, and the known
  holes (anomalies #4, #6, #8, #9, #10) make it an under-count. Every remaining case was already
  source-curated and is untouched.

Two independent checks were run for every subject:

1. **Source grep** at the committed tree (`git show HEAD:<path>` whenever the working tree
   differed — only `evals/` files differ at curation time, and their HEAD content was
   confirmed to carry the cited symbols). Eval agents run in a worktree of `main`, so a
   subject that only exists in uncommitted work would be invisible to them.
2. **Graph presence** in `cd.db`, because the verifier resolves graph-truth cases through
   `@coredoc/db` against the same database. Hand-curated `expected*` lists override graph
   truth, but the subject still has to be findable by the MCP arm for the comparison to
   mean anything.

The standard sqlite probe used throughout:

```sh
sqlite3 coredoc.db.d/cd.db \
  "select name, type, file_path from nodes where name in ('X','Y');"
sqlite3 coredoc.db.d/cd.db \
  "select json_extract(properties,'\$.method'), json_extract(properties,'\$.fullPath'), file_path
     from nodes where type='entrypoint';"
```

---

## Graph anomalies noticed while verifying (parser-gap signals)

These are **not** reflected in the truth sets — they're findings worth triaging separately.

1. **`repository` node metadata is stale.** `nodes.properties` on the single repository node
   still says `gitCommitHash: 50283e93…` / `parsedAt: 2026-08-12`, and every node's
   `created_at`/`updated_at` is `2026-08-12 08:58`, even though the graph clearly contains
   HEAD-only symbols (`cypherCapability`, `graph.service.ts`, committed `2026-08-21`). Push
   updates content but does not refresh repository-level provenance or row timestamps, so
   "how fresh is this graph?" cannot be answered from the graph itself.
2. **A committed source file is entirely missing from the graph.**
   `packages/core/src/utils/coredoc-home.ts` (committed in `4f457765`, exports
   `resolveCoredocHome`, has ~10 call sites across cli/desktop/core) produced **zero** nodes,
   while its siblings in the same directory (`telemetry-config.ts`, `source-flag.ts`,
   `repo-ref.ts`, …) are indexed. This killed the first candidate for
   `transitiveCallersClosure`.
3. **Stale nodes from deleted files are never pruned.** The graph contains
   `evals/bench-graph-dataplane/fixture.ts` (`materialize`, `generateWorkspaceFixture`) —
   that file does not exist at HEAD (`evals/bench-graph-dataplane/` only has `arms/` and
   `container/`). Incremental push appears not to delete nodes for removed files.
4. **Dynamic `await import()` breaks call resolution.**
   `apps/server/src/modules/push/push.service.ts` and `.../push/diff-engine.ts` call
   `transformParsedRepo` via `const { transformParsedRepo } = await import('@coredoc/db')`;
   none of those call sites produced a `CALLS` edge, so the graph's transitive-caller closure
   for `transformParsedRepo` silently omits the entire server push path.
5. **Anonymous Electron IPC handlers get pseudo-names.** Direct callers of `stripSourceCode`
   in `apps/desktop/src/main/workspace-manager.ts` are stored as a function node named
   `ipc:workspace:syncToCloud`; another enclosing arrow in
   `graph-snapshot-artifact.service.ts` is named `components` (after the generator method it
   is passed to). These names can never be matched by the verifier's identifier regex
   (`` /`([A-Za-z_][A-Za-z0-9_.]*)`/ `` — no colons), which is why they were excluded from the
   `transitiveCallersClosure` truth (documented below).
6. **`OPERATES_ON` coverage is thin for Prisma writes inside helper methods.**
   `ControlPlaneService.createPendingInvitation` writes `WorkspaceInvitation` (and is the DB
   sink of the invite flow) but has no `OPERATES_ON` edge; `Workspace` has only 10 consumer
   functions in the graph versus a much larger source-level surface. Graph-truth
   `entityImpact` / `dataFlowTrace` therefore score against an under-counted sink set.
7. **A route node lost its component link.** `routes` rows for `/explorer`, `/roadmap` and the
   dashboard index (`apps/web/src/router.tsx`) carry `componentName` but no `componentId`
   (`isLazy: false`), unlike every other web/desktop route.

8. **`USES_TYPE` misses interface property types.** For
   `packages/core/src/types/output.ts:ExternalCallTarget`, `getTypeUsages` returns only the four
   *functions* that take/return it (`rebuildTargetDescriptor`, `egressAsCall`,
   `lookupEgressByNode`, `sdkMappingToDescriptor`). The four *interfaces* that declare a property
   of that type — `ExternalCallEdge.targetDescriptor` (`output.ts:877`),
   `ExternalCallLike.targetDescriptor` (`descriptor-matcher.ts:33`),
   `SdkMethodNodeLike.egress` (`moniker-resolver.ts:27`), `SdkSymbolEntry.egress`
   (`types.ts:42`) — produce no edge, even though those interfaces are exactly what breaks when
   the type's shape changes. Half the real consumer set is invisible to `find_dependents`.
9. **Entity `OPERATES_ON` has no field granularity.** `getEntityConsumers('Workspace')` returns
   10 functions and **none** of them touch `graphBackend`; the 17 functions that actually read
   the column (see the `entityImpact` section) are absent. Column-level impact questions —
   the most common real form of "who breaks if I change this schema?" — cannot be answered from
   the graph at all.
10. **A raw-SQL column read is invisible.**
    `graph-snapshot-control-plane.service.ts:543` filters on `graph_backend = 'file_snapshot'`
    inside a `$queryRaw`. No entity/field linkage is extracted from raw SQL, so this consumer
    exists only in source.

Everything above is graph-side. HTTP entrypoint paths, by contrast, are stored **correctly**:
`path` is the handler-relative path and `fullPath` carries the `/api/v1` global prefix, with
root-served routes (`/.well-known/oauth-protected-resource`) correctly excluded from the
prefix.

---

## `explainFunction` — `createMetadata`

Definition: `packages/mcp/src/response-formatter.ts:99`
(`export async function createMetadata(`). Present in the graph as
`bc00cfcd84ff:function:packages/mcp/src/response-formatter.ts:createMetadata`.

`expectedCallers` is hand-curated from
`rg -n "createMetadata" packages/mcp/src --type ts | grep -v '\.test\.'`, mapping every call
site to its enclosing top-level function (all MCP tool handlers are declared as
`export async function handleX(` — a check for top-level arrow-declared handlers
(`rg -n "^const [A-Za-z]+ = (async )?\("`) returned nothing, so no caller is missed).

| Caller | File:Line(s) |
|---|---|
| `handleAnalyzeChangeImpact` | `packages/mcp/src/tools/impact/analyze-change-impact.ts:170,377` |
| `handleFindCallers` | `packages/mcp/src/tools/impact/find-callers.ts:83,175` |
| `handleFindDependents` | `packages/mcp/src/tools/impact/find-dependents.ts:74,152` |
| `handleFindEntityUsage` | `packages/mcp/src/tools/impact/find-entity-usage.ts:47,94` |
| `handleListServiceDependencies` | `packages/mcp/src/tools/cross-repo/list-service-dependencies.ts:133,153` |
| `handleTraceCrossRepoCall` | `packages/mcp/src/tools/cross-repo/trace-cross-repo-call.ts:225,236,318,323,400,569,651` |
| `handleExplain` | `packages/mcp/src/tools/understanding/explain.ts:476` |
| `handleExplainFunction` | `packages/mcp/src/tools/understanding/explain-function.ts:89,214` |
| `handleExplainEntrypoint` | `packages/mcp/src/tools/understanding/explain-entrypoint.ts:79,239` |
| `handleDescribeRepository` | `packages/mcp/src/tools/discovery/describe-repository.ts:46,265` |
| `handleDescribeDbSchema` | `packages/mcp/src/tools/discovery/describe-db-schema.ts:61,77,88,107` |
| `handleSearchSymbols` | `packages/mcp/src/tools/discovery/search-symbols.ts:323` |
| `handleSemanticSearch` | `packages/mcp/src/tools/discovery/semantic-search.ts:67,84` |
| `handleRunCypherQuery` | `packages/mcp/src/tools/discovery/run-cypher-query.ts:177` |
| `handleGetExtractionCoverage` | `packages/mcp/src/tools/discovery/get-extraction-coverage.ts:32` |
| `handleListFileSymbols` | `packages/mcp/src/tools/discovery/list-file-symbols.ts:98` |
| `handleListEntrypoints` | `packages/mcp/src/tools/discovery/list-entrypoints.ts:89` |

Test files (`*.test.ts`, which `vi.mock` the formatter) are deliberately excluded — the prompt
asks for invoking functions, and the mocks don't call it.

---

## `blastRadius` — rename `getDirectCallers` → `getCallersOf`

The method is declared on the shared graph repository contract
(`packages/db/src/types.ts:1071`) and implemented by all three backends. Full grep:
`rg -n "getDirectCallers" --type ts -g '!node_modules' -g '!dist'` → 16 files, every one listed
in `expectedTouchedFiles`.

| Kind | File:Line | Evidence |
|---|---|---|
| contract | `packages/db/src/types.ts:1071` | `getDirectCallers(targetId: string, repoHashes: string[]): Promise<CallerInfo[]>;` |
| impl | `packages/db/src/sqlite/repository.ts:1449` | `async getDirectCallers(targetId, repoHashes)` |
| impl | `packages/db/src/ladybug/repository.ts:1303` | `async getDirectCallers(targetId, repoHashes)` |
| impl | `packages/db/src/neo4j/repository.ts:1209` | `async getDirectCallers(targetId, repoHashes)` |
| doc comment | `packages/db/src/transformer.ts:885` | `* variable — see \`getDirectCallers\` in the SQLite repository.` |
| **string allowlist** | `apps/server/src/mcp/workspace-mcp-context.service.ts:82` | `'getDirectCallers',` — a literal in the read-only method allowlist; a pure rename that misses it silently breaks remote MCP. This is the non-obvious ripple the case is meant to reward. |
| caller | `packages/mcp/src/tools/impact/find-callers.ts:106` | `: await repo.getDirectCallers(targetId, scope.repoHashes);` |
| caller | `packages/mcp/src/tools/understanding/explain-function.ts:150-152` | `debug('getDirectCallers', …)` + `await repo.getDirectCallers(func.id, …)` |
| mock | `packages/mcp/src/__tests__/fixtures/mock-repository.ts:67` | `getDirectCallers: vi.fn().mockResolvedValue([]),` |
| caller | `evals/cases/explain-function.ts:49` | `await repo.getDirectCallers(fn.id, [hash])` (verified at HEAD via `git show`) |
| tests | `packages/db/src/contract/repository-contract.test.ts`, `packages/db/src/sqlite/repository.test.ts`, `packages/db/src/ladybug/repository.test.ts`, `packages/mcp/src/tools/impact/find-callers.test.ts`, `packages/mcp/src/tools/impact/analyze-change-impact.test.ts`, `packages/mcp/src/tools/understanding/explain-function.test.ts` | referenced by name |

Deliberate inclusions: test files and the `transformer.ts` doc comment. A rename genuinely has
to touch them, and whether an arm finds test/comment references is exactly the
grep-vs-graph difference this case measures (the graph indexes neither).

`getTransitiveCallers` is a **different** method and is not part of the truth.

---

## `entrypointDeepDive` + `dataFlowTrace` — `POST /api/v1/workspaces/{workspaceId}/members/invites`

Route: `apps/server/src/modules/members/members.controller.ts` —
`@Controller('workspaces/:workspaceId/members')` + `@Post('invites')` with
`@UseGuards(InvitationRateLimitGuard)`, `@WorkspaceRole('admin')` and
`@RequirePermission(TokenPermission.WorkspaceManage)`.

Path form: the verifier matches `e.path === p.path || e.fullPath === p.path`. The graph stores

```
POST | path=/invites | fullPath=/api/v1/workspaces/{workspaceId}/members/invites
```

so the manifest uses the **fullPath** form verbatim. (The old manifest used
`/workspaces/{workspaceId}/members/invites`, which matches neither field — it would have
failed to resolve the entrypoint at all.)

Both cases are left on **graph truth** (no `expected*` override), matching the old manifest's
style. The chain resolves cleanly in the graph:

- entrypoint `bc00cfcd84ff:entrypoint:http:8c49d06c` → handler `MembersController.inviteMember`
- → `MembersService.inviteMember` (`members.service.ts:40`)
- → `assertAllowedEmail`, `ensureWorkosOrganization`, `deliverInvitation`,
  `rollbackPendingInvitation`, `signInUrl`, `invitationExpiresAt`,
  `ControlPlaneService.getWorkspaceById`, `ControlPlaneService.createPendingInvitation`
- → `WorkOSInvitationsService.send/resend/revoke/isEnabled`,
  `ControlPlaneService.markInvitationDelivered`

`field: "email"` is the real request field — `InviteMemberDto.email`, lower-cased at
`members.service.ts:41` (`const normalizedEmail = email.toLowerCase();`) and sent to WorkOS via
`deliverInvitation`. See anomaly #6: the terminal Prisma write on `WorkspaceInvitation` has no
`OPERATES_ON` edge, so graph-derived sinks under-count.

### Re-curated from source (2026-08-21, second pass)

Both cases now carry hand-curated overrides. Graph truth was removed because it is
circular — the verifier bar moved with whatever the parser happened to capture, and
anomalies #4/#6 mean it captures less than the source says.

**`entrypointDeepDive.expectedReachableFunctions`** — hand-traced from the handler to depth 3
(mirroring the prompt's "depth 3 is fine"). `expectedReachableFunctions[0]` is the handler and
`expectedReachableFiles[0]` is the controller, per the verifier's handler/handler-file
convention. `git show HEAD:apps/server/src/modules/members/members.{controller,service}.ts`,
`.../database/control-plane.service.ts`, `.../auth/workos-invitations.service.ts`.

| Depth | Function | Declaration | Call site |
|---|---|---|---|
| 0 | `inviteMember` (handler) | `members.controller.ts:35` (`@Post('invites')`, line 31) | — |
| 1 | `inviteMember` (service, same bare name) | `members.service.ts:40` | `members.controller.ts:40` |
| 2 | `assertAllowedEmail` | `members.service.ts:345` (private) | `members.service.ts:42` |
| 2 | `getWorkspaceById` | `control-plane.service.ts:52` | `members.service.ts:43` |
| 2 | `ensureWorkosOrganization` | `members.service.ts:312` (private) | `members.service.ts:49` |
| 2 | `createPendingInvitation` | `control-plane.service.ts:380` | `members.service.ts:57` |
| 2 | `deliverInvitation` | `members.service.ts:268` (private) | `members.service.ts:59` |
| 2 | `invitationExpiresAt` | `auth/oauth/invitation-eligibility.ts:19` | `members.service.ts:66` |
| 2 | `signInUrl` | `members.service.ts:341` (private) | `members.service.ts:67` |
| 2 | `rollbackPendingInvitation` | `members.service.ts:330` (private) | `members.service.ts:79` |
| 3 | `parseCsv`, `emailDomain` | `auth/oauth/provider-utils.ts:7,22` | `members.service.ts:346,347` |
| 3 | `isEnabled` | `workos-invitations.service.ts:58` | `members.service.ts:277,317` |
| 3 | `getWorkspaceOwnerWorkosIdentity` | `control-plane.service.ts:144` | `members.service.ts:320` |
| 3 | `ensureOrganization` | `workos-invitations.service.ts:62` | `members.service.ts:324` |
| 3 | `ensureOrganizationMembership` | `workos-invitations.service.ts:88` | `members.service.ts:325` |
| 3 | `setWorkspaceWorkosOrganizationId` | `control-plane.service.ts:99` | `members.service.ts:326` |
| 3 | `send` / `resend` | `workos-invitations.service.ts:118,146` | `members.service.ts:290,288` |
| 3 | `markInvitationDelivered` | `control-plane.service.ts:415` | `members.service.ts:295` |
| 3 | `revoke` | `workos-invitations.service.ts:154` | `members.service.ts:299` (compensation branch of `deliverInvitation`) |
| 3 | `removePendingInvitation` | `control-plane.service.ts:435` | `members.service.ts:332` |
| 3 | `serverUrl` | `auth/oauth/server-url.ts:14` | `members.service.ts:342` |

Deliberately **not** in `expectedReachableFunctions`: `InvitationRateLimitGuard.canActivate`,
`AuthGuard`, `WorkspaceRoleGuard`, `PermissionsGuard` — they are boundary guards, not callees of
the handler (the prompt asks about them separately, in item 6). `InviteMemberDto` is a DTO type,
not a function. Only `expectedReachableFiles[0]` is scored (handler-file hit); the remaining
files are the six modules hosting the callees above.

**`dataFlowTrace.expectedSinks`** — end-to-end read of the `email` field:

| Sink | Kind | Evidence |
|---|---|---|
| `WorkspaceMember` | DB write (create) | `control-plane.service.ts:384-386` — `tx.workspaceMember.create({ data: { …, email: normalizedEmail, pending: true } })`; the placeholder PK is literally derived from the email (`pending:${normalizedEmail}`, line 382) |
| `WorkspaceInvitation` | DB write (create, then update) | `control-plane.service.ts:387-390` — `tx.workspaceInvitation.create({ data: { workspaceId, memberUserId } })`, later updated by `markInvitationDelivered` (`:415`) |
| `WorkOS` | external HTTP egress | `members.service.ts:295` (`deliverInvitation` → `workosInvitations.send(invitation.member.email, …)`) → `POST https://api.workos.com/user_management/invitations` with `body: { email, organization_id }` (`workos-invitations.service.ts:118`, base URL `:4`); the recovery path `findPendingInvitation` also sends the email as a query filter |

Transformation along the way: `email.toLowerCase()` (`members.service.ts:41`), then the same
normalized string is used as the member email, as the `pending:<email>` placeholder user id,
and as the WorkOS invitation recipient.

Deliberately excluded: the log sink (`this.logger.log('… invited ${invitation.member.email} …')`,
`members.service.ts:60-63`). It is a real sink, but scoring here is a case-insensitive substring
scan and there is no stable token an agent would reliably emit for it (`logger` / `Logger` /
"logs") — including it would penalize correct answers for phrasing. Called out here so the judge
dimension `completeness` still has it on record.

---

## `entityImpact` — `Workspace.graphBackend`

Entity node: `Workspace` (`apps/server/prisma/schema.prisma`, `@@map("workspaces")`).
Field chosen because it is a **real current column** with genuinely interesting consumers:
`graphBackend String @default("file_snapshot") @map("graph_backend") @db.VarChar(32)`.

The old manifest's `deletedAt` does not exist on the model — verified with
`git show HEAD:apps/server/prisma/schema.prisma`.

### Re-curated from source (2026-08-21, second pass)

Graph truth was removed. `getEntityConsumers('Workspace')` returns 10 functions
(`createWorkspace`, `updateWorkspace`, `setWorkspaceWorkosOrganizationId`, `deleteWorkspace`,
`completeWorkosInvitation`, `DeliveryEnabledGuard.canActivate`, `isDeliveryEnabled`,
`setDeliverySettings`, two `shouldRetainGraphArtifacts`) — and **not one of them touches
`graphBackend`**. It is an entity-level `OPERATES_ON` set, so the case's own field grounding
("we plan to add `graphBackend`") was being scored against consumers of unrelated columns.

`expectedConsumers` is now the enclosing function of every non-test source site that reads or
branches on the column, from
`git grep -n "graphBackend\|graph_backend" HEAD -- '*.ts' '*.tsx' '*.prisma' '*.sql'`:

| Function | File:Line (decl → use) |
|---|---|
| `withContextByWorkspaceId` | `apps/server/src/mcp/workspace-mcp-context.service.ts:206 → 214,220,229,250,262` |
| `buildToolContext` | `apps/server/src/mcp/tools/base-tool.ts:37 → 43,80` |
| `assertCypherCapable` | `apps/server/src/mcp/tools/cypher.tools.ts:63 → 68` |
| `runCypherQuery` | `apps/server/src/mcp/tools/cypher.tools.ts:98 → 114` |
| `assembleCandidate` | `…/graph-snapshot/graph-snapshot-control-plane.service.ts:320 → 329,332` |
| `publishCandidate` | `…/graph-snapshot-control-plane.service.ts:456 → 543 (raw SQL `AND graph_backend = 'file_snapshot'`), 556,558` |
| `cypherPolicyAllows` | `apps/server/src/modules/graph/graph.service.ts:135 → 136` |
| `cypherAvailable` | `apps/server/src/modules/graph/graph.service.ts:142 → 143` |
| `capabilities` | `apps/server/src/modules/graph/graph.service.ts:629 → 636` |
| `runCypher` | `apps/server/src/modules/graph/graph.service.ts:648 → 658,659` |
| `putMapper` | `apps/server/src/modules/mapper/mapper.controller.ts:55 → 78` |
| `sameWorkspaceInput` | `apps/server/src/modules/mapper/resolver.service.ts:116 → 117` |
| `resolveWorkspaceInner` | `apps/server/src/modules/mapper/resolver.service.ts:182 → 193,215` |
| `getWorkspaceGraphBackend` | `apps/server/src/modules/push/push.service.ts:240 → 243` |
| `pushByVersion` | `apps/server/src/modules/push/push.service.ts:405 → 475,481,482` |
| `resolveWorkspace` | `apps/server/src/modules/workspaces/workspaces.controller.ts:96 → 107` |
| `runSync` | `packages/cli/src/sync/index.ts:153 → 243` |

Deliberate exclusions:

- `apps/desktop/src/main/workspace-manager.ts:271` reads `workspace.graphBackend`, but the
  enclosing scope is the anonymous arrow inside `ipcMain.handle('workspace:syncToCloud', …)` —
  same unmatchable-identifier problem as anomaly #5 / the `transitiveCallersClosure` exclusions.
- `packages/cli/src/sync/workspace-api.ts:95` and `apps/desktop/src/main/server-api.ts:96` only
  **declare** `graphBackend?: string` in a return/response type; the read happens in `runSync`
  and in the desktop IPC handler.
- `JobProcessorService.process` (`apps/server/src/modules/jobs/job-processor.service.ts:32`,
  branching at `:48-59,79-92`) consumes the value one hop away via
  `pushService.getWorkspaceGraphBackend`, and never names the column. Truth is kept to
  direct grep sites; `process` is also too generic a token to score fairly.
- `packages/mcp/src/tools/discovery/run-cypher-query.ts:131` is a doc comment.
- Migrations (`20260811000000_…`, `20260811120000_…`, `20260821090000_…`) define the column and
  its CHECK constraints but are not functions.

---

## `typeImpact` — `ExternalCallTarget` (was `ParsedRepo`)

History: `OutputFormat` (the original subject) no longer exists in `@coredoc/core` — the only
`OutputFormat` left is an unrelated MCP-local type alias (`packages/mcp/src/types.ts`) — so the
subject moved to `ParsedRepo` and was scored against the graph (68 `USES_TYPE` edges).

**Subject changed 2026-08-21 (second pass).** `ParsedRepo` cannot be hand-curated honestly:
`git grep -l "ParsedRepo" HEAD -- '*.ts' '*.tsx'` → **125 files**, hundreds of consumers. The
verifier scores this case with F1, so an incomplete truth list turns an agent's *correct*
consumers into false positives; a complete one is infeasible to maintain. The subject is now a
type with a fully enumerable consumer set, keeping `kind: interface` and the same `filePath`
(`packages/core/src/types/output.ts`, decl line 925) so the case still exercises the core
output contract and the `USES_TYPE` extension.

Truth from `git grep -n "\bExternalCallTarget\b" HEAD -- '*.ts' '*.tsx'` (21 hits, 8 non-test
files), reading each site's enclosing declaration:

| Consumer | Kind | File:Line |
|---|---|---|
| `rebuildTargetDescriptor` | return type (+ `ExternalCallTarget['ipc']` / `['protocol']` indexed access at `:58,65`) | `apps/server/src/modules/mapper/adapters/from-turso.ts:24` |
| `egressAsCall` | parameter | `packages/core/src/cross-repo/chain-walker.ts:77` |
| `lookupEgressByNode` | return type | `packages/core/src/cross-repo/chain-walker.ts:196` |
| `sdkMappingToDescriptor` | return type | `packages/core/src/cross-repo/sdk-mapping-fallback.ts:141` |
| `ExternalCallEdge` | property `targetDescriptor?` | `packages/core/src/types/output.ts:844 → 877` |
| `ExternalCallLike` | property `targetDescriptor?` | `packages/core/src/cross-repo/descriptor-matcher.ts:31 → 33` |
| `SdkMethodNodeLike` | property `egress?` | `packages/core/src/cross-repo/moniker-resolver.ts:12 → 27` |
| `SdkSymbolEntry` | property `egress?` | `packages/core/src/cross-repo/types.ts:38 → 42` |

Excluded: `packages/core/src/cross-repo/moniker-resolver.test.ts:9` (test fixture
`const egress: ExternalCallTarget = {…}`) — same test-exclusion policy as `explainFunction`;
and the prose mentions in the `sdk-mapping-fallback.ts` header comment (`:19,136`).

All 8 consumers plus the type itself exist as nodes in `cd.db`, so the MCP arm can resolve the
subject. **Graph-vs-source divergence (new gap, see anomaly #8):** `getTypeUsages` on
`bc00cfcd84ff:interface:packages/core/src/types/output.ts:ExternalCallTarget` returns exactly
the **4 functions** and **none of the 4 interfaces** — `USES_TYPE` is emitted for
parameter/return positions but not for interface *property* types.

---

## `routeDeepDive` + `routeApiSurface` — `/members` → `WorkspaceMembers`

Route node in the graph (`apps/web/src/router.tsx`):
`path=/members`, `componentName=WorkspaceMembers`,
`componentId=bc00cfcd84ff:component:apps/web/src/routes/workspace-members.tsx:WorkspaceMembers`.

`expectedReachableFunctions` is the component subtree of
`apps/web/src/routes/workspace-members.tsx`, read directly:

| Symbol | Line |
|---|---|
| `avatarColor` | 42 |
| `memberInitials` | 51 |
| `MiniAvatar` | 60 |
| `ConfirmButton` | 82 |
| `RoleSelect` | 150 |
| `MemberRow` | 183 |
| `MembersTable` | 296 |
| `InviteRow` | 337 |
| `PendingInvitesSection` | 434 |
| `InviteForm` | 464 |
| `RolesReferencePanel` | 568 |
| `MembersContent` | 583 |
| `WorkspaceMembers` | 653 |

plus its imported data layer: `membersQueryOptions`, `invitesQueryOptions`, `inviteMember`,
`resendInvite`, `revokeInvite`, `removeMember`, `updateMemberRole`
(`apps/web/src/api/queries/members.ts`), `meQueryOptions` (`api/queries/me.ts`), `request`
(`api/client.ts`), `findWorkspace` (`routes/workspace.tsx`), `formatRelativeTime`
(`lib/time.ts`), `hasAdminAccess` (`lib/roles.ts`) — all from the import block at
`workspace-members.tsx:1-25`.

`expectedFiles[0]` is the route file itself, because the verifier scores
"componentFileHit" against `truthFiles[0]`. The remaining files are the imported modules from
that same import block; every path was confirmed present on disk and at HEAD.

`routeApiSurface.expectedEndpoints` is transcribed from the `request(...)` template literals:

| Method | Path | File:Line |
|---|---|---|
| GET | `/api/v1/workspaces/{wsId}/members` | `apps/web/src/api/queries/members.ts:21` |
| GET | `/api/v1/workspaces/{wsId}/members/invites` | `members.ts:28` |
| POST | `/api/v1/workspaces/{wsId}/members/invites` | `members.ts:70` |
| POST | `/api/v1/workspaces/{wsId}/members/invites/{invitationId}/resend` | `members.ts:79` |
| DELETE | `/api/v1/workspaces/{wsId}/members/invites/{invitationId}` | `members.ts:86` |
| DELETE | `/api/v1/workspaces/{wsId}/members/{userId}` | `members.ts:93` |
| PATCH | `/api/v1/workspaces/{wsId}/members/{userId}` | `members.ts:100` |
| GET | `/api/v1/me` | `apps/web/src/api/queries/me.ts:11` |

Note the verifier keys truth paths by *normalized path only* (method is dropped), so the
DELETE/PATCH pair on `.../members/{userId}` collapses into a single truth key — 7 effective
keys. Left as-is: both entries are real.

---

## `componentDecision` — per-repo "last pushed" + re-push action (desktop)

Hand-curated reuse set, all verified in source **and** in the graph
(`select name,type,file_path from nodes where name in (…)`):

| Component / hook | File |
|---|---|
| `WorkspaceGraphPanel` | `apps/desktop/src/renderer/pages/views/completed/panels/WorkspaceGraphPanel.tsx:57` |
| `WorkspaceGraphRepoRow` | `…/panels/WorkspaceGraphRepoRow.tsx:48` (rendered from the panel, `WorkspaceGraphPanel.tsx:9`) |
| `DockedPanelHost` | `…/completed/DockedPanelHost.tsx` — the host that renders `WorkspaceGraphPanel` |
| `CompletedView` | `apps/desktop/src/renderer/pages/views/CompletedView.tsx:84` |
| `StaleGraphBanner` | `…/completed/StaleGraphBanner.tsx` (imported at `CompletedView.tsx:26`) |
| `useCloudSync` | `…/completed/use-cloud-sync.ts:44` (used at `CompletedView.tsx:166`) |
| `useProjectDetailStore` | `apps/desktop/src/renderer/stores/project-detail-store.ts:289` (`WorkflowAction` type is imported by both panels) |
| `useWorkspaceStore` | `apps/desktop/src/renderer/stores/workspace-store.ts:112` |
| `graphStatus` | `apps/desktop/src/renderer/features/explorer/workspace-graph-format.ts` (imported at `WorkspaceGraphPanel.tsx:8`) |
| `Badge`, `Button`, `Spinner`, `Progress` | `apps/desktop/src/renderer/components/ui/*` (imported at `WorkspaceGraphPanel.tsx:3-7`) |
| `DropdownMenu` | `apps/desktop/src/renderer/components/ui/dropdown-menu.tsx` (imported at `WorkspaceGraphRepoRow.tsx:6-12` — the existing per-row action menu) |

Scoring is F-beta with β=2 (recall-weighted), so extra plausible reuses cost little; the list
is intentionally the "must reuse" core rather than every transitively rendered primitive.

---

## `featureImplementationPlan` — Rails Sidekiq/ActiveJob graph substrate

This is a **diagnostic parser-gap task**, not an admitted historical primary. No merged
post-snapshot Coredoc implementation exists: the descendant Coredoc history contains no Ruby/Rails
parser change that can serve as a held-out delivery oracle. The cell is grounded instead in a
read-only source and graph audit of a private Rails monolith from a pilot workspace (not
published): its Sidekiq/ActiveJob job files, `def perform` handlers and `perform_async` /
`perform_in` / `perform_at` enqueue sites had no job/queue entrypoints or producer→handler
bridges in the graph.

The audit attributes this gap to **ENGINE**, not PROFILE. The audited repository's profile already describes
the application’s Rails/Ruby substrate; the current engine’s `rubyQueueFromRoot` path recognizes
Karafka routing only. A correct extension must recognize concrete job classes through
`ApplicationJob`/Sidekiq ancestry and relevant mixins, preserve the actual `perform` function node
and source location as handler identity, and resolve qualified enqueue calls to that handler. It
must not turn every unrelated Ruby method named `perform` into an entrypoint or fabricate an edge
when the job class cannot be resolved.

| Implementation concern | Existing target file | Why it is in diagnostic gold |
|---|---|---|
| parser assembly | `packages/profile-parser/src/substrate/ruby/ruby-parser.ts` | owns Ruby file scanning, function/call assembly, queue entrypoints, and final `RubyParsedRepo` |
| queue/job extraction | `packages/profile-parser/src/substrate/ruby/ruby-queue.ts` | current Karafka-only queue primitive; natural existing boundary for a minimal extension or dispatch to a new helper |
| queue extraction tests | `packages/profile-parser/src/substrate/ruby/ruby-queue.test.ts` | proves job ancestry/mixin positives and unrelated-`perform` negatives |
| enqueue resolution | `packages/profile-parser/src/substrate/ruby/ruby-callgraph.ts` | existing canonical Ruby function identities and conservative call resolution |
| enqueue tests | `packages/profile-parser/src/substrate/ruby/ruby-callgraph.test.ts` | `perform_async` / `perform_in` / `perform_at`, namespacing, and unresolved safety |
| graph adapter/integration | `packages/profile-parser/src/substrate/ruby/ruby-parser.test.ts` | ensures real handler IDs, queue entrypoints, and calls survive into `ParsedRepo` |

The existing `QueueEntrypointDetails`, graph transformer, messaging edges, and MCP consumers already
have a current queue vocabulary. The plan should reuse that path and explicitly say why no new core
schema, MCP tool signature, server route, API, or UI layer is required. A separate
`ruby-jobs.ts` following the existing Ruby helper convention is an acceptable implementation
choice, but it is not placed in `expectedFiles`: exact-revision preflight can validate only files
that exist at Coredoc snapshot `643dcc4ff04104379a4e61031c9cf9384449e99d`.

The visible eval prompt intentionally starts only at the observed product failure — an enqueue call
that Explain/change-impact cannot traverse — and does not name any parser file or extraction layer.
The file table above is held-out verifier evidence, not an agent hint. Finding the correct split
between job recognition, call resolution, parser assembly, and regression coverage is part of the
case.

Because the task has no accepted future implementation diff and the active Coredoc graph revision
does not currently agree with this manifest snapshot, no primary or fresh eval-result claim is
made. Its value is descriptive: it tests whether the planning surface exposes a reproduced Rails
engine gap and routes the proposed facts through the existing graph correctly.

---

## `backendFrontendPair` — `GET /api/v1/workspaces/{workspaceId}/jobs`

Chosen because the **collection** endpoint is consumed only by the web app (the CLI and
desktop hit `…/jobs/{jobId}`, a different route:
`packages/cli/src/sync/workspace-api.ts:247`, `apps/desktop/src/main/server-api.ts:525`), so
the truth set stays tight and precision-scoring stays honest.

| File | Evidence |
|---|---|
| `apps/web/src/api/queries/jobs.ts:18-27` | `jobsQueryOptions` → `request<Job[]>(\`/api/v1/workspaces/${wsId}/jobs?…\`)` |
| `apps/web/src/api/client.ts` | `request()` — the fetch wrapper |
| `apps/web/src/api/types.ts` | `Job`, `JobStatus` |
| `apps/web/src/routes/workspace-jobs.tsx:272` | `...jobsQueryOptions(wsId, status, JOBS_PAGE_LIMIT)` |
| `apps/web/src/routes/workspace-index.tsx:142` | `jobsQueryOptions(wsId, 'failed', 5)` — second consumer page |

Server side: `@Controller('workspaces/:workspaceId/jobs')` +
`@UseGuards(AuthGuard, WorkspaceRoleGuard, PermissionsGuard)`
(`apps/server/src/modules/jobs/jobs.controller.ts:11-13`); graph confirms
`GET /api/v1/workspaces/{workspaceId}/jobs`.

---

## `flagImpactAudit` — `useAuthStore`

Runtime gate: the desktop auth store (`apps/desktop/src/renderer/stores/auth-store.ts:24`,
zustand `create<AuthState>`). It gates every cloud/team surface in the desktop renderer
(`isLoggedIn`, `userId`, `authChangeCount`). Graph node exists as both `state_store` and
`variable`.

Call sites from `rg -n "useAuthStore\(" apps/desktop/src -g '!*.test.*'`, each mapped to its
enclosing component:

| Call site | File:Line | Enclosing (decl line) |
|---|---|---|
| `useAuthStore((state) => state.checkAuthStatus/isLoggedIn/authChangeCount)` | `App.tsx:16-18` | `App` (15) |
| `const { isLoggedIn, userId, authChangeCount } = useAuthStore()` | `components/AppLayout.tsx:19` | `AppLayout` (15) |
| `const { isLoggedIn, login } = useAuthStore()` | `pages/views/CompletedView.tsx:121` | `CompletedView` (84 — no nested declaration in between) |
| `const { userId } = useAuthStore()` | `…/completed/panels/TeamMcpPanel.tsx:49` | `TeamMcpPanel` (40) |
| `const { userId, email: authEmail } = useAuthStore()` | `components/team-mcp/TeamMcpInviteStep.tsx:103` | `TeamMcpInviteStep` (90) |
| `useAuthStore((state) => state.userId)` | `features/observability/ObservabilityPanel.tsx:128` | `ObservabilityPanelInner` (126) |
| `const { logout, loading } = useAuthStore()` | `pages/SettingsPage.tsx:33` | `LogoutDialog` (32) |
| `const { isLoggedIn } = useAuthStore()` | `pages/SettingsPage.tsx:70` | `LogoutButton` (69) |
| `const { isLoggedIn, email, login, loading, error } = useAuthStore()` | `pages/SettingsPage.tsx:84` | `AccountSection` (83) |

---

## `callerIntersection` — `useAuthStore` ∩ `useWorkspaceStore`

Files that use both (`rg -ln` per store, intersected), with the shared enclosing component
confirmed line-by-line:

| Component | auth-store line | workspace-store line |
|---|---|---|
| `AppLayout` (`components/AppLayout.tsx:15`) | 19 | 20 |
| `TeamMcpPanel` (`…/panels/TeamMcpPanel.tsx:40`) | 49 | 48 |
| `TeamMcpInviteStep` (`components/team-mcp/TeamMcpInviteStep.tsx:90`) | 103 | 102 |

`use-cloud-sync.ts`, `ConnectTeamMcpWizard.tsx` and `InvitedUserOnboardingWizard.tsx` use
`useWorkspaceStore` but **not** `useAuthStore`, so they are correctly out of the intersection.

---

## `transitiveCallersClosure` — `stripSourceCode`

Definition: `packages/db/src/strip-source.ts:30`
(`export function stripSourceCode(parsed: ParsedRepo): StripResult`). Present in the graph.

Closure curated by grep + reading enclosing declarations (depth ≤ 3):

| Depth | Function | File:Line | Evidence |
|---|---|---|---|
| 1 | `buildGraphFile` | `packages/db/src/file-builder.ts:431` (decl 408) | `const { parsed } = stripSourceCode(component.parsedRepo);` |
| 1 | `repositoryCounts` | `apps/server/src/modules/graph-snapshot/graph-snapshot-artifact.service.ts:806` (decl 798) | `const strippedParsed = stripSourceCode(component.parsedRepo).parsed;` |
| 1 | `uploadResult` | `packages/cli/src/push/remote.ts:48` (decl 32) | `: stripSourceCode(options.parsedRepo);` |
| 2 | `materialize` | `graph-snapshot-artifact.service.ts:556` | calls `this.repositoryCounts(…)` (586) and `buildGraphFile({…})` (607) |
| 2 | `syncRepo` | `packages/cli/src/sync/repo-sync.ts:134` | `await api.uploadResult({…})` (225); `defaultRepoSyncApi.uploadResult = defaultUploadResult` (65-69, imported from `push/remote.js`) |
| 2 | `runCi` | `packages/cli/src/ci/run.ts:92` | `await uploadResult({ workspaceId, repoName, parsedRepo })` (257) |
| 3 | `executePush` | `apps/server/src/modules/graph-snapshot/graph-snapshot-execution.service.ts:36` | `await this.artifacts.materialize(…)` (85) |
| 3 | `executeResolve` | `…/graph-snapshot-execution.service.ts:148` | `await this.artifacts.materialize(…)` (172) |
| 3 | `runSync` | `packages/cli/src/sync/index.ts:153` | `await syncRepo({…})` (251) |

**Deliberate exclusions** (documented, not oversights):

- `apps/desktop/src/main/workspace-manager.ts:281` and `:479` are direct callers, but they are
  anonymous arrows inside `ipcMain.handle('workspace:syncToCloud'…)` /
  `ipcMain.handle('workspace:checkCloudDelta'…)`. They have no citable identifier — the graph
  names them `ipc:workspace:syncToCloud`, and the verifier's identifier regex rejects colons —
  so including them would be permanently unmatchable truth.
- `packages/cli/src/index.ts:628` calls `uploadResult` inside a Commander `.action()` arrow —
  same reason.
- `evals/bench-graph-dataplane/fixture.ts` appears in the graph closure but the file does not
  exist at HEAD (anomaly #3).

---

## `serviceDependencyMap`

Scoring is case-insensitive substring recall, so each entry is the name an engineer would
actually write.

**Re-derived from source only (2026-08-21, second pass).** The previous list mixed graph
`external_call` evidence with source; it is now grounded exclusively in file:line at HEAD, from
`git grep -nE "https://[a-zA-Z0-9.-]+\.(com|ai|io|dev|org|net)"` over `apps/**` + `packages/**`
plus an SDK-import sweep
(`git grep -nE "from '(@ai-sdk/…|@aws-sdk/…|@libsql/…|posthog-(node|js)…|@anthropic-ai/…)'"`).

| Service | Source evidence at HEAD |
|---|---|
| WorkOS | `apps/server/src/auth/workos-invitations.service.ts:4` (`const WORKOS_API_BASE_URL = 'https://api.workos.com'`), `:259` `fetch(\`${WORKOS_API_BASE_URL}${path}\`…)`; `apps/server/src/auth/web/web-auth.service.ts:37` |
| Turso | `apps/server/src/database/turso-provisioning.service.ts:36` (`apiBase = 'https://api.turso.tech/v1'`), `fetch` at `:137,154,170`; `@libsql/client` at `packages/db/src/sqlite/driver.ts:12` |
| PostHog | `apps/desktop/src/renderer/telemetry.ts:8` (`import posthog from 'posthog-js/…'`), `posthog.init/identify/capture` at `:39,55,77`; `apps/server/src/modules/telemetry/telemetry.service.ts:2` (`import { PostHog } from 'posthog-node'`) |
| Anthropic | `packages/cli/src/ci/llm-config.ts:2,73` (`createAnthropic` from `@ai-sdk/anthropic`); `apps/desktop/src/main/agent-run/claude-adapter.ts:12` and `apps/desktop/src/main/chat-service.ts:17` (`@anthropic-ai/claude-agent-sdk`) |
| OpenAI | `packages/cli/src/ci/llm-config.ts:1,65-68` (`createOpenAI` from `@ai-sdk/openai`, default `api.openai.com` endpoint) |
| OpenRouter | `packages/mcp/src/tools/discovery/query-embedder.ts:19,100` (`POST https://openrouter.ai/api/v1/embeddings`); `packages/cli/src/embed/providers.ts:22,85`; `packages/cli/src/ci/llm-config.ts:57-58` |
| Ollama | `packages/mcp/src/tools/discovery/query-embedder.ts:56,59` (`POST {OLLAMA_BASE_URL\|http://localhost:11434}/api/embed`); `packages/cli/src/embed/providers.ts:21`; `packages/cli/src/ci/llm-config.ts:46-48` |
| S3 | `apps/server/src/database/r2-storage.service.ts:23` (`@aws-sdk/client-s3`), client at `:205` — Cloudflare R2 via the S3 API. "S3" rather than "AWS S3" so "Cloudflare R2 (S3-compatible)" still matches |
| **GitHub** (new) | `apps/server/src/modules/delivery/github-client.ts:60,74` (`baseUrl ?? 'https://api.github.com'` + `fetch`); `apps/server/src/modules/source/source.service.ts:63`; `apps/server/src/auth/oauth/github-allowlist.provider.ts:28` |
| **Jira** (new) | `apps/server/src/modules/delivery/jira-client.ts:89-99` (Atlassian Cloud `baseUrl` + `fetch`), REST calls at `:141` (`POST /rest/api/3/search/jql`), `:158`, `:231`, `:245` |

Corrections made in this pass:

- The old Anthropic citation `apps/server/src/modules/delivery/llm-client.ts:121` **does not
  exist at HEAD** (`git show HEAD:…/llm-client.ts` → `fatal: path … does not exist`). Anthropic
  survives on the two citations above.
- GitHub and Jira were missing entirely even though the whole delivery-intelligence import path
  is built on them.

Deliberately excluded (cannot be grounded as a runtime third-party call):

- `https://api.stripe.com` — appears only in a doc comment example
  (`packages/profile-parser/src/substrate/scip/url-topic-helpers.ts:247`).
- `https://www.figma.com/design/…` — Code Connect metadata constants in
  `apps/desktop/src/renderer/components/ui/*.figma.tsx`, not a call.
- `https://storage.googleapis.com` — an alternative value for `R2_ENDPOINT` in
  `apps/server/.env.example:71` / `ONPREM.md`; the only code reference is the
  `isGoogleCloudStorageEndpoint` branch (`r2-storage.service.ts:117-120`), i.e. still the S3 row.
- `https://github.com/coredoc` — an `HTTP-Referer` header value sent to OpenRouter
  (`packages/cli/src/embed/providers.ts:98`, `query-embedder.ts:106`), not a GitHub call.
- `coredoc-desktop-releases.…workers.dev` (`apps/server/src/auth/web/desktop-release.ts:8`,
  `electron-updater` in `apps/desktop/src/main/update-manager.ts:10`) and the CLI/desktop calls
  to the coredoc server itself — first-party infrastructure.
- `desktop-main` Electron IPC — an internal transport, not an external service.

---

## `entrypointPermissionAudit`

Auth pattern (verbatim source of the hint): NestJS controllers, global prefix `/api/v1` set at
`apps/server/src/main.ts:89` with `exclude: ROOT_ROUTES`
(`apps/server/src/libs/spa-serving.ts:36-46` — `sse`, `messages`, `mcp`, `.well-known/*`,
`authorize`, `callback`, `token`, `revoke`, `register`). `rg -n "APP_GUARD" apps/server/src`
returns **nothing**, so there is no global guard: a route is authenticated iff `AuthGuard`
(`apps/server/src/auth/auth.guard.ts`) appears on the controller or handler.

Scoring is section-aware substring matching over the truth lists, and a listed subset is
sufficient (extra correct routes in the response cost nothing). The lists below are exact and
deliberately bounded, and no unauthenticated path is a substring of an authenticated one.

**Authenticated** — all verified as entrypoints in the graph with these exact `fullPath`s:

| Path | Guard evidence |
|---|---|
| `/api/v1/me` | `web-auth.controller.ts:249-250` — `@Get('me')` + `@UseGuards(AuthGuard)` |
| `/api/v1/cli/bundle` | `cli-bundle.controller.ts:7-12` — `@Controller('cli')` + `@UseGuards(AuthGuard)` |
| `/api/v1/workspaces/{workspaceId}/members` | `members.controller.ts:21-22` — `@UseGuards(AuthGuard, WorkspaceRoleGuard, PermissionsGuard)` |
| `/api/v1/workspaces/{workspaceId}/members/invites` | same controller, `@Post('invites')` |
| `/api/v1/workspaces/{workspaceId}/repos` | `repos.controller.ts:17-18` |
| `/api/v1/workspaces/{workspaceId}/tokens` | `tokens.controller.ts:26-27` |
| `/api/v1/workspaces/{workspaceId}/jobs` | `jobs.controller.ts:11-12` |
| `/api/v1/workspaces/{workspaceId}/mcp-config` | `workspaces.controller.ts:63` under the guarded workspaces controller |
| `/api/v1/workspaces/{workspaceId}/graph/cypher` | `graph.controller.ts:33-34` — `@UseGuards(AuthGuard, WorkspaceRoleGuard, PermissionsGuard, GraphRateLimitGuard)` |

**Unauthenticated** — no `AuthGuard` anywhere in the chain:

| Path | Evidence |
|---|---|
| `/api/v1/health` | `health.controller.ts:5,23` — `@Controller('health')`, `@Get()`, no guards |
| `/api/v1/health/live` | `health.controller.ts:37` |
| `/api/v1/auth/web/login` | `web-auth.controller.ts:52` — the only `@UseGuards` in that controller are at lines 114 and 250 |
| `/api/v1/auth/web/callback` | `web-auth.controller.ts:73` |
| `/api/v1/auth/web/refresh` | `web-auth.controller.ts:201` (refresh-cookie flow, no bearer auth) |
| `/.well-known/oauth-protected-resource` | `apps/server/src/mcp/mcp-discovery.controller.ts:14,23` — root-served via `ROOT_ROUTES` |

---

## `deepChainSideEffects` — `runSync`

`kind: function`, `symbol: runSync`, `filePath: packages/cli/src/sync/index.ts`. The full CLI
cloud-sync pipeline, 6 levels deep, ending in a disk read of the credentials file.

| Depth | Function | File:Line | Side effect (evidence) |
|---|---|---|---|
| 1 | `runSync` | `packages/cli/src/sync/index.ts:153` | HTTP `GET /api/v1/workspaces/{workspaceId}` via `remoteGetWorkspace` (bound 159, called 235; default `getWorkspace`, `sync/workspace-api.ts:93`) + `POST …/resolve` (182); console progress |
| 2 | `syncRepo` | `packages/cli/src/sync/repo-sync.ts:134` | HTTP `POST /api/v1/workspaces/{workspaceId}/repos` (`connectRepo`, 202) and `PATCH …/repos/{repo}` (215), then `pushByVersion` (258); logs each step |
| 3 | `uploadResult` | `packages/cli/src/push/remote.ts:32` | HTTP `POST …/repos/{repoName}/results/upload` with the ParsedRepo JSON body (url 41, `fetch` 63); wired in at `repo-sync.ts:65-69,225` |
| 4 | `stripSourceCode` | `packages/db/src/strip-source.ts:30` | none — pure transform (returns a copy without `sourceCode`) |
| 4 | `getToken` | `packages/cli/src/auth.ts:80` | reads `COREDOC_TOKEN` env, then stored credentials; `console.error` on expiry |
| 5 | `getCredentials` | `packages/cli/src/auth.ts:94` | none — delegation + shape check |
| 6 | `readCredentialsDocument` | `packages/cli/src/auth.ts:53` | `await readFile(credentialsFile(), 'utf-8')` → reads `credentials.json` from the coredoc home dir and JSON-parses it |

All seven functions exist in the graph as `function` nodes (`getToken` also resolves in
`apps/desktop/src/main/telemetry-manager.ts`; `uploadResult` is a name shared with three
server-side methods — the manifest pins the file path, and the prompt embeds it).

---

## `crossRepoTrace` — TBD (intentional)

The `cd` project graph contains exactly one repository node (`coredoc-parser`,
`select count(*) from nodes where type='repository'` → 1). A cross-repo trace has no honest
subject here, so `method` / `path` stay `"TBD"` and `expectedRepos` stays empty; the runner
skips TBD cells.
