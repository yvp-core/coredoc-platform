# Coredoc development guide

[AGENTS.md](AGENTS.md) is the canonical instruction file for all agents, including
Claude Code. Follow its defaults: read the nearest analogue, make the smallest
useful change, and add comments only for non-obvious constraints. Do not turn the
reference docs into a mandatory workflow for every task.

## Product and packages

Coredoc turns repositories into a queryable code graph. The **desktop app** is the
primary entry point; the CLI provides the same parsing and publication workflows
for scripting and CI. Claude authors declarative extraction profiles; language
substrates provide syntax and optional semantic facts to the shared engine.

| Area | Responsibility |
| --- | --- |
| `apps/desktop` | Electron + React product UI, local workflows, graph explorer, cloud workspace integration |
| `apps/web` | Cloud web UI (React SPA served by `apps/server`): workspaces, repos, teams, analytics, intent, settings |
| `packages/cli` | Commands, `sdk/` orchestration, profile authoring, summaries, push, headless `ci run` |
| `packages/profile-parser` | Profiles, language providers/substrates, Tree-sitter and SCIP runtime, extraction and scoring |
| `packages/core` | Shared graph/config/intent contracts, stable IDs, cross-repo linking and shared utilities |
| `packages/db` | Graph repositories and backends, snapshot file support, source stripping |
| `packages/mcp` | Local MCP and shared graph tool definitions/handlers |
| `apps/server` | NestJS cloud API, auth, workspaces, artifact/snapshot publication, cloud MCP and product intent |

See [ARCHITECTURE.md](ARCHITECTURE.md) for source locations and ownership. For parser
work, follow an existing provider and the [language guide](docs/ADDING-A-LANGUAGE.md)
or [framework guide](docs/ADDING-A-FRAMEWORK.md). The provider registry in source
is authoritative when a language list in prose is older.

**Ladybug** stores the local graph and immutable hosted-cloud graph files on R2.
**Neo4j is the primary graph database for customer on-prem deployments.**
**SQLite is for local operations/metrics**; PostgreSQL holds the cloud control plane.
**The Turso service is decommissioned.** Historical `turso` backend labels remain in
source and persisted rows; that mutable server path also serves on-prem Neo4j.
See [storage and cloud publication](ARCHITECTURE.md#storage-and-cloud-publication)
before removing it. Standalone local development commands should explicitly select
Ladybug.

## Commands

Node 22+ and the repository's pinned pnpm version are declared in `package.json`.
Builds use Turbo dependency ordering; consumers may need their dependencies built first.

```bash
pnpm install
pnpm build
pnpm desktop
pnpm server:dev
pnpm server:build
pnpm cli --help
pnpm mcp
pnpm mcp:debug

pnpm --filter @coredoc/<pkg> test
pnpm --filter @coredoc/<pkg> typecheck
pnpm typecheck
pnpm test
pnpm check
```

Choose checks from [DoD](DoD.md#4-validation-baseline), not every command above.
`pnpm check` is non-mutating Biome validation. `pnpm check:fix` and `pnpm format`
write files; use fixes only for intentional, scoped edits. For desktop visual work,
read [DESIGN.md](DESIGN.md) and [the design workflow](docs/agents/design-system.md).

## Skills and product intent

- `coredoc-workflows` is external OSS, installed from the marketplace/cache. There
  is no in-repo copy to edit. `vendor/coredoc-workflows-runtime/` contains only the
  pinned capture-contract subset described in its README.
- The in-repo `plugins/coredoc` consumption plugin is maintained here. Canonical
  consumption skills in `skills/` sync through `pnpm sync:plugin-skills`.
- Extraction profiles are authored via the `author-profile` skill and Agent SDK.
  Its model configuration is product behavior, separate from the contributor's
  chosen coding-agent model; do not invent or pin a model ID in these instructions.
- Product intent is cloud-only. Read it through the workspace MCP: `intent_read`
  for product questions, `get_intent_context` for the rules that apply to code.
- Use the intent-capture workflow when asked to record a reviewed product decision.
  Code, comments, and matched anchors do not establish accepted product intent.
- Create an artifact only when the task needs it, and follow an explicitly named
  external task source.

## Agent skills

### Issue tracker

Issues are local markdown files under `.scratch/<feature-slug>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five roles (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`), recorded as `Status:` lines. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `CONTEXT.md` plus `docs/adr/`. See `docs/agents/domain.md`.
