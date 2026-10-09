# Coredoc (coredoc-platform)

Coredoc turns repositories into a code graph for developers and AI agents. The
**desktop app is the primary entry point**; CLI, CI, REST API, and MCP support
automated and team workflows. See [the overview](OVERVIEW.md) for the product flow
and [architecture](ARCHITECTURE.md) for package ownership.

**Parse only trusted repositories and trusted branches.** Enhanced language
analysis can execute repository build code and access the network. See the
[parser guide](packages/profile-parser/README.md) for analysis modes and tool requirements.

## Connect an agent

In Claude Code, install the consumption plugin:

```text
/plugin marketplace add yvp-core/coredoc-platform
/plugin install coredoc@coredoc-plugins
/coredoc:setup
```

The plugin supplies navigation skills and local setup helpers. **It does not
register an MCP server**: add the local or workspace-specific MCP configuration
from Coredoc Desktop (server name `coredoc` for the setup helper's permission rule).
The workspace connection determines authentication and available tools; setup
alone does not connect an agent to a graph.

Graph tools include discovery, symbol search, explanation, caller/dependency and
impact analysis, and cross-repo tracing. Cloud workspace connections also expose
their configured intent/workflow tools. A cloud graph consumer does not need a
local parser build or database.

## What It Does

Coredoc uses Claude AI to author a small, declarative **extraction profile** for your codebase, which the generic `@coredoc/profile-parser` engine (`SubstrateProfileEngine`) applies — over a tree-sitter + SCIP substrate — to extract:

- **Code structure** — Functions, classes, methods, interfaces, types, variables
- **Entrypoints** — HTTP routes, GraphQL resolvers, gRPC services, WebSocket handlers, cron jobs, message queues, CLI commands
- **Data layer** — DB entities, ORM models, database operations
- **Dependencies** — Import graphs, function call traces, external SDK calls
- **UI specifics** — Components, routes/pages, state management (frontend/mobile repos)

The parsed data powers the desktop explorer and code understanding through MCP.
The shared engine uses language providers; extraction coverage depends on the
language and available syntax/semantic tooling.

## Development setup

Use Node 22+ and the pnpm version declared in `package.json`. Contributor rules are
in [AGENTS.md](AGENTS.md); choose validation from [DoD.md](DoD.md).

```bash
pnpm install
pnpm build
pnpm desktop
```

For a standalone local CLI/MCP workflow, copy and edit the example configuration,
set the repository paths and project ID, and author/review its extraction profile
before parsing:

```bash
cp coredoc.config.example.json coredoc.config.json
export COREDOC_DB_BACKEND=ladybug
pnpm cli validate
pnpm cli parse -r <repo> --project <id>
pnpm cli push --project <id>
```

The project push includes all available parsed artifacts; repositories without an
artifact are absent from the graph. With no parsed artifacts, it fails and leaves
the existing graph unchanged.

Then configure the MCP client as shown below. The local graph is Ladybug; SQLite
stores local operations/metrics. Explicitly select Ladybug for standalone commands
because some legacy CLI/factory defaults still select the old SQLite graph path.

## Server

NestJS REST API server for team collaboration, workspace management, and cloud features.

```bash
# Development mode
pnpm server:dev

# Build
pnpm server:build
```

### Local stack with Docker Compose

`apps/server/docker-compose.yml` runs Postgres, Neo4j, the server, the web app
and the agent runner. The server, web app and runner run in watch mode.

Prerequisites:

- Docker Desktop. On Apple Silicon, turn on Settings → General → "Use Rosetta
  for x86_64/amd64 emulation on Apple Silicon". The runner image is
  linux/amd64 only, and under qemu the Claude Code binary aborts.
- `apps/server/.env`, filled in from `apps/server/.env.example`. Compose passes
  it to the server and overrides `DATABASE_URL` and `NEO4J_URI` for the
  container network.

```bash
cd apps/server
docker compose up --build        # add -d to run in the background
```

Migrations (`prisma migrate deploy`) run before the server starts.

| URL | Service |
| --- | --- |
| http://localhost:5173 | Web app (Vite with HMR; proxies `/api`, `/mcp` and the OAuth paths to the server) |
| http://localhost:3000 | Server (API, MCP) |
| http://localhost:7474 | Neo4j browser |
| `localhost:5432` | Postgres (`coredoc` / `coredoc`) |

Enable the agent runner:

1. Sign in at http://localhost:5173. Create a runner token in Settings → Agent
   runs. The token is shown only once.
2. Copy the example settings: `cp agent-runner.env.example agent-runner.env`
   (git ignores the copy). Fill in the workspace ID, the runner token, an
   Anthropic API key, the bot's GitHub token and its commit email. To find the
   workspace ID, open http://localhost:5173/api/v1/workspaces while signed in
   and copy the workspace's `id`.
3. Run `docker compose up -d agent-runner`. Compose recreates the runner with
   the new settings.

Until `agent-runner.env` holds a token, the runner logs `not configured` with
the missing variables and waits. It does not exit, so it does not restart in a
loop.

Watch the logs:

```bash
docker compose logs -f                                # every service
docker compose logs -f coredoc-server agent-runner    # a few services
```

`docker compose down` stops the stack. The Postgres and Neo4j data stays in
`apps/server/data`.

Known limits:

- Only edits under `apps/server/src`, `apps/web/src` and `apps/agent-runner/src`
  reload. Changes to `packages/*` (core, db, mcp), a `package.json`, the
  lockfile or a Dockerfile need `docker compose up -d --build <service>`.
  Prisma schema and migration changes apply when the server restarts.
- TypeScript's watcher reacts to content changes, not to a bare `touch`.
- Without Rosetta (qemu), Claude Code aborts. The runner logs `sdk_unusable`
  and claims no turns. With a token, it also reports the problem in
  Settings → Agent runs.
- The runner runs under amd64 emulation on Apple Silicon, so it builds and
  runs slower there.
- The dev runner is not the production image. It has the full dev
  dependencies and a writable root filesystem. Use
  `scripts/images/check-images.sh` to check the production image.
- Neo4j starts with a 4 GB heap. The server uses it only when `.env` sets
  `NEO4J_PASSWORD` (`asd123A!` for this container).

## CLI Usage

For power users and CI pipelines, the CLI is available directly:

```bash
# Parse a repository — applies its extraction profile to produce the code graph.
# Profiles are authored with the `author-profile` skill (not a CLI command).
pnpm cli parse -r <repo>

# List available parsers / profiles
pnpm cli list

# Validate configuration
pnpm cli validate

# Resolve cross-repo references
pnpm cli resolve

# Generate AI summaries
pnpm cli summarize <repo>

# Generate embeddings
pnpm cli embed <repo>

# Push to database
pnpm cli push <repo>

# Operations tracking
pnpm cli ops

# Start MCP server
pnpm cli mcp

# Authentication
pnpm cli login
pnpm cli logout
pnpm cli whoami

# Cross-service mapper (per-project artifact)
pnpm cli mapper discover --project <id>   # auto-build mapper.json from parsed externalCalls
pnpm cli mapper validate --project <id>
pnpm cli mapper status   --project <id>
pnpm cli mapper diff     --project <id>   # vs .mapper.json.bak (snapshot from last discover)
```

## Cross-Service Mapper

For multi-repo projects, `coredoc push` (and `coredoc link`) resolves cross-service edges — e.g. an SDK call in `service-a` resolved to its target HTTP entrypoint in `service-b`. There is **one** resolution pass: the substrate-native workspace linker (`packages/core/src/cross-repo/`). It builds two hop indexes (an entrypoint index for the protocol hop, an SDK symbol index for the moniker hop), walks every external call into a resolved chain, and emits one `RESOLVES_TO` edge per chain carrying the per-hop provenance. Calls it cannot resolve are bucketed with a structured reason, never silently dropped.

`coredoc-parsers/<project>/mapper.json` is an **optional override** fed into that same pass — never a second engine. It supplies the facts the substrate cannot know: canonical service names and their owning repo/target, an SDK-method fallback table, path-rewrite rules, and the infra services that have no code-level entrypoint. Projects without a mapper resolve normally; a mapper that is bad JSON or fails the schema is skipped with a warning and linking continues without the override.

### Authoring a mapper

`coredoc-parsers/<project>/mapper.json`:

```json
{
  "$schemaVersion": 1,
  "project": "my-project",
  "services": [
    { "name": "user-svc", "repo": "user-service", "aliases": ["users", "user-api"] }
  ],
  "sdkMappings": [
    {
      "sdkPackage": "@acme/user-sdk",
      "sdkClass": "user-svc",
      "sdkMethod": "getById",
      "targetService": "user-svc",
      "http": { "method": "GET", "pathTemplate": "/v1/users/:id", "pathParams": ["id"] }
    }
  ],
  "pathRewriteRules": [
    { "match": "^/api/(?<svc>[a-z-]+)/", "targetServiceFrom": "svc" }
  ],
  "unresolvableServices": ["redis", "kafka", "datadog"]
}
```

- **`services`** — canonical service names + owning repo + observed aliases. Replaces inline `camelCase↔kebab` normalisation. Optional `target` (a profile target inside the repo, for multi-target monorepos) and `httpPrefix` (per-service gateway prefix) refine the mapping; using either makes the document `$schemaVersion: 2`.
- **`sdkMappings`** — an optional fallback table, one row per SDK method, for **published-only SDKs whose source is not in the workspace** (in-workspace SDKs resolve through the substrate moniker hop with no declared rows). The resolver indexes by `(sdkPackage, canonical-service-name, sdkMethod)`, so `sdkClass` should be the **canonical service name** (e.g. `"user-svc"`), not the JavaScript class name. `coredoc mapper discover` writes this automatically; hand-authored mappers must follow the same convention or SDK lookups will miss.
- **`pathRewriteRules`** — fallback for calls that have a path but no SDK info. Named-group regex → service name.
- **`unresolvableServices`** — infra services with no code-level entrypoint (redis, kafka, third-party). Excluded from the resolution-rate denominator.

### Validating and inspecting

```bash
# Auto-build mapper.json from parsed externalCalls (no AI). Snapshots the
# previous mapper.json to .mapper.json.bak so re-runs are recoverable.
pnpm cli mapper discover --project my-project

# Schema check (no resolution, no AI)
pnpm cli mapper validate --project my-project

# Counts + last discover timestamp + baseline rate
pnpm cli mapper status --project my-project

# Diff current mapper vs .mapper.json.bak (snapshot from last discover)
pnpm cli mapper diff --project my-project
```

### Baseline and health

`coredoc mapper discover` also writes `mapper.meta.json` with the resolution rate captured at generation time; `mapper status` prints it next to the current counts, so you can tell whether a mapper has fallen behind the code. For a fuller picture of cross-service resolution health — resolved vs unresolved calls and the top unresolved services — run:

```bash
pnpm cli cross-service-report --project my-project
```

## Monorepo Structure

| Package | Description |
|---------|-------------|
| `packages/core` | Core types, ID generator, `OutputFormat` schema, filesystem utilities |
| `packages/cli` | CLI commands (parse, summarize, push, link, mapper, etc.) |
| `packages/profile-parser` | Profile-driven extraction engine — applies a declarative `ExtractionProfile` over a tree-sitter + SCIP substrate to produce the code graph |
| `packages/db` | Ladybug local/cloud graphs, Neo4j on-prem graphs, SQLite operations/metrics |
| `packages/mcp` | MCP server for AI agent integration |
| `apps/server` | NestJS REST API, PostgreSQL control plane, R2 graph snapshots, cloud MCP and intent |
| `apps/desktop` | Primary Electron + React app for local and cloud workflows |
| `apps/web` | Cloud web UI (React SPA served by `apps/server`) |

Per-repo extraction profiles (`profile.ts`) and related artifacts are stored in `coredoc-parsers/<project>/<repoName>/`.

## Configuration

Copy the example config and edit it:

```bash
cp coredoc.config.example.json coredoc.config.json
```

```json
{
  "$schema": "./schema/coredoc.schema.json",
  "version": "2.0",
  "projects": [
    {
      "id": "my-project",
      "name": "My Project",
      "repos": [
        {
          "name": "user-service",
          "path": "./services/user-service",
          "type": "backend"
        },
        {
          "name": "web-app",
          "path": "./apps/web",
          "type": "frontend"
        }
      ]
    }
  ],
  "output": {
    "dir": "./coredoc-output",
    "format": "json",
    "prettyPrint": true
  },
  "parserStorage": "./coredoc-parsers",
  "agentMode": "interactive",
  "exclude": [
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/*.test.ts",
    "**/*.spec.ts"
  ]
}
```

| Option | Type | Description |
|--------|------|-------------|
| `version` | string | Config version (`"2.0"`) |
| `projects` | array | Groups of repos belonging to a project |
| `projects[].id` | string | Stable project identifier used by `--project` and MCP scope |
| `projects[].name` | string | Display name |
| `projects[].repos` | array | Repos within the project |
| `repos[].name` | string | Unique identifier for the repo |
| `repos[].path` | string | Path to repository root |
| `repos[].type` | string | `backend` \| `frontend` \| `mobile` \| `library` \| `monorepo` |
| `output.dir` | string | Output directory for parsed JSON |
| `output.format` | string | Output format (`json`) |
| `output.prettyPrint` | boolean | Pretty-print output JSON |
| `parserStorage` | string | Directory to store per-repo extraction profiles |
| `agentMode` | string | Agent interaction mode (`interactive` \| `auto`) |
| `exclude` | array | Glob patterns to exclude from parsing |

### MCP Server

The MCP server exposes the local Ladybug graph to MCP clients. Use this client
configuration with **absolute** paths and your project ID. Older checked-in example
configs may still select SQLite; use `ladybug` for the current graph.

```json
{
  "mcpServers": {
    "coredoc": {
      "command": "node",
      "args": ["/abs/path/to/coredoc-platform/packages/mcp/dist/index.js"],
      "env": {
        "COREDOC_DB_BACKEND": "ladybug",
        "MCP_CONFIG_PATH": "/abs/path/to/coredoc-platform/coredoc.config.json",
        "COREDOC_SCOPE": "project:my-project",
        "COREDOC_CURRENT_REPO": "user-service"
      }
    }
  }
}
```

| Env var | Required | Description |
|---------|----------|-------------|
| `COREDOC_DB_BACKEND` | yes for standalone setup | Set `ladybug` for the current local graph. |
| `MCP_CONFIG_PATH` | yes | Absolute path to `coredoc.config.json`; combined with project ID, selects the project graph. |
| `COREDOC_SCOPE` | yes | The visible project boundary: `project:<id>`. |
| `COREDOC_CURRENT_REPO` | no | A default/ranking hint within that project; does not narrow access. |

If the project graph has not been built, run
`COREDOC_DB_BACKEND=ladybug coredoc push --project <id>`. Local Ladybug publication
builds the project snapshot from its parsed artifacts, so a rebuild can remove stale
graph data after parser/profile changes. Source and artifact retention settings
remain separate from graph publication.

To publish a linked project to the cloud, use `coredoc push --project <id> --cloud`.
Linking a project to a workspace is `coredoc sync --project <id>`. The current cloud
graph is an immutable Ladybug snapshot on R2, with PostgreSQL as the control plane.
**Neo4j is the primary graph database for customer on-prem deployments. The Turso
service is decommissioned.** Historical `turso` backend labels still appear in the
mutable server path shared with Neo4j; see
[storage and cloud publication](ARCHITECTURE.md#storage-and-cloud-publication).

#### `COREDOC_SCOPE` vs `COREDOC_CURRENT_REPO` — boundary vs vantage

These are two independent axes:

- **`COREDOC_SCOPE` decides what is visible.** Under `project:my-project` the agent can query and cross-reference every repo in the project — this is what makes the cross-repo tools work.
- **`COREDOC_CURRENT_REPO` decides where the agent is standing** within that visible set. It does **not** narrow the boundary. It only:
  - makes single-origin tools (`list_service_dependencies` — "what does *this* repo call") report that repo's own dependencies instead of the whole project's aggregate, and
  - ranks that repo first in `search_symbols` when a symbol name exists in several repos.

  Set it to a repo `name` from `coredoc.config.json`. **Any tool call that passes an explicit `scope` argument overrides it**, so the agent can always widen to the whole project or pivot to a sibling repo. Omit it and every tool stays project-wide (the default).

**Remote / team MCP (cloud server).** The cloud server is multi-tenant, so the vantage can't be a process env var — it's supplied **per request** via the `X-Coredoc-Current-Repo` header instead. The boundary is the workspace (resolved from the auth token); the header names the current repo within it, with identical semantics (hint only; an explicit `scope` arg overrides; ignored if the repo isn't in the workspace). Configure it in the remote MCP client's `headers`:

```json
{
  "mcpServers": {
    "coredoc-cloud": {
      "type": "http",
      "url": "https://<your-coredoc-server>/api/v1/workspaces/<workspaceId>/mcp",
      "headers": {
        "Authorization": "Bearer <service-token>",
        "X-Coredoc-Current-Repo": "user-service"
      }
    }
  }
}
```

Append `?toolset=intent` to that URL to limit a connection to the intent tools and
`submit_session_feedback`, for example for a product manager's agent or a claude.ai
custom connector. Omit it for every tool. See the [plugin README](plugins/coredoc/README.md#install).

> Paths must be **absolute** — MCP clients resolve relative paths against the client's working directory, not this repo.

## Output

Each parsed repo produces a JSON file in `coredoc-output/`:

```
coredoc-output/
├── user-service.json              # Parsed repo structure
├── user-service-summaries.json    # AI-generated summaries
├── user-service-embeddings.json   # Vector embeddings (optional)
└── web-app.json
```

### Output Schema

The authoritative [`ParsedRepo` / `OutputFormat` types](packages/core/src/types/output.ts)
include code nodes, entrypoints, entities, calls, imports, external calls, and
optional frontend/SDK data. See [architecture](ARCHITECTURE.md#shared-output-and-identity)
for the contract and ID rules. `pnpm cli validate` checks workspace configuration,
not a parsed-output file.

## Development

```bash
# Build all packages
pnpm build

# Run all tests
pnpm test

# Lint (Biome)
pnpm lint
pnpm check           # lint + format check

# Format (Biome)
pnpm format

# Type check
pnpm typecheck

# Start MCP server
pnpm mcp

# MCP server with inspector
pnpm mcp:debug

# Clean build artifacts
pnpm clean
```

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
