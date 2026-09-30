# @coredoc/desktop

Electron desktop app for Coredoc. Provides a GUI for parsing repos, generating documentation, managing MCP connections, and chatting with an AI agent about your codebase.

## Prerequisites

- Node.js 20+
- pnpm 9+
- All workspace packages built (`pnpm build` from monorepo root)
- Codex CLI with `app-server` support when the Codex harness is selected; authenticate it with `codex login`

## Development

### Quick start

```bash
# From monorepo root
pnpm install
pnpm build

# Start dev server + Electron
cd apps/desktop
npm run dev:electron
```

This runs Vite dev server on `http://localhost:5173` and launches Electron pointing at it. Hot module replacement is active for renderer code.

### Dev mode details

- **Renderer**: Vite dev server with HMR (`npm run dev`)
- **Main process**: electron-vite bundles `src/main/index.ts`, `src/main/sdk-worker.ts`, and
  `src/main/sdk-parse-child.ts` into `dist/main/`
- **Preload**: tsc compiles `src/preload/` into `dist/preload/`
- **Workspace root**: Resolved from the compiled file location up to the monorepo root (no `process.cwd()` dependency)

### Environment variables

Create a `.env` file in your workspace root (the directory containing `coredoc.config.json`):

```env
COREDOC_HARNESS_PROVIDER=claude-code   # claude-code (default) or codex
COREDOC_HARNESS_AUTH_MODE=subscription # subscription (default) or api-token
COREDOC_DB_BACKEND=sqlite              # sqlite (default) or neo4j
```

Harness settings are normally managed from the desktop Settings page. Subscription mode uses the selected CLI's
saved login. API-token mode stores the selected provider's token in this workspace `.env`; the desktop masks it in the
renderer and passes it only to that provider's runs.

Graph databases are per project and resolved automatically at
`<workspace>/coredoc.db.d/<projectId>.db` — there is nothing to configure.
The desktop derives this path from the loaded config and stable project id;
ambient SQLite URL overrides are ignored.

The desktop app loads `.env` from the active workspace on startup.

## Build

### Full build

```bash
npm run build
```

This runs the following steps in order:

1. **Package builds** — `@coredoc/cli`, `@coredoc/mcp`, `@coredoc/profile-parser`
2. **Runtime bundles** — `copy-runtime-bundles.mjs` copies CLI, MCP, and their dependencies to `dist/runtime/` (symlink-free, for packaged app)
3. **Main process typecheck** — `tsc -p tsconfig.main.json --noEmit` (type checking only, no emit)
4. **Main process bundle** — electron-vite builds `dist/main/index.js`, `dist/main/sdk-worker.js`, and
   `dist/main/sdk-parse-child.js`
5. **Preload** — `tsc -p tsconfig.preload.json` compiles to `dist/preload/`
6. **Renderer** — `vite build` compiles React app to `dist/renderer/`

### Individual build steps

```bash
npm run build:main:typecheck # tsc type-check for main process (no emit)
npm run build:main:esbuild   # esbuild bundle (main + worker)
npm run build:preload        # tsc compile preload scripts
npm run build:renderer       # vite build renderer
```

### Type checking

```bash
npm run typecheck            # All three tsconfigs (renderer, main, preload)
```

### Clean

```bash
npm run clean                # rm -rf dist dist-electron
```

## Packaging

### Build distributable

```bash
npm run build:app            # Full build + electron-builder
npm run build:mac            # macOS only
```

Output goes to `dist-electron/`. The `afterPack` hook (`scripts/after-pack.mjs`) renames `_vendor` to `node_modules` in the ASAR-unpacked directory so Node's ESM resolver works correctly.

### What gets packaged

- `dist/main/` — esbuild-bundled main process + SDK worker + docs-gen templates
- `dist/preload/` — compiled preload scripts
- `dist/renderer/` — built React app
- `dist/runtime/` — CLI, MCP server, and dependencies (ASAR-unpacked for subprocess spawning)
- `node_modules/` — native addons (`@lydell/node-pty`, `tree-sitter*`, `better-sqlite3`, `claude-agent-sdk`)

### ASAR unpacking

Native addons and the runtime bundle are unpacked from ASAR (configured in `package.json` `build.asarUnpack`):

- `dist/runtime/**` — CLI and MCP executables
- `node_modules/@lydell/**` — PTY native addon
- `node_modules/tree-sitter*/**` — tree-sitter native addons
- `**/claude-agent-sdk/**` — Agent SDK binary

## Smoke Tests

Smoke tests verify the build artifacts are correct before and after packaging.

### Pre-packaging smoke test

Run after `npm run build` to verify the build output:

```bash
npm run smoke
```

Checks:
- `dist/runtime/` directory structure exists
- CLI entrypoint exists and executes (`--help`)
- MCP server exists and responds to JSON-RPC `initialize` handshake
- `prompts-dag.json` is loadable from runtime paths
- `_vendor/` directory exists with dependencies
- Critical native module dependencies are present
- esbuild main process output exists

### Post-packaging smoke test

Run after `electron-builder` to verify the packaged app:

```bash
npm run smoke:post
```

Checks:
- ASAR unpacked directory layout
- `_vendor` renamed to `node_modules` by afterPack hook
- Native `.node` module files exist
- Template files present at expected paths

## Architecture

### Process model

```
Electron Main Process (esbuild bundle: dist/main/index.js)
├── IPC Handlers — config, state, commands, MCP, chat, docs, settings
├── SDK Worker Thread (dist/main/sdk-worker.js)
│   └── Runs: summarize, embed, push, docs, call-graph, etc.
├── Sandboxed Parse Child (dist/main/sdk-parse-child.js)
│   └── Imports generated profiles under macOS Seatbelt with no network/provider environment
├── ParserOrchestrator — generate command (in-process, structured events)
├── MCP Bridge — spawns MCP server as subprocess
└── Chat Service — Agent SDK with MCP tools

Renderer (Vite/React: dist/renderer/)
├── ProjectsPage — repo overview with pipeline state
├── ProjectDetailPage — per-repo details, commands, terminal
├── ConnectPage — MCP config for external agents
└── SettingsPage — workspace, API token

Preload (dist/preload/) — contextBridge IPC layer
```

### Command execution

- **`generate`** runs in the main process via `ParserOrchestrator` with structured event streaming (`PARSER_GEN_EVENT` IPC channel)
- **All other commands** (parse, summarize, embed, push, docs, etc.) run in an SDK worker thread for isolation, cancellation (`worker.terminate()`), and main-thread responsiveness
- The worker intercepts `console.log/error` and `process.stdout/stderr.write` to forward output via IPC to the renderer's terminal

### Path resolution

`runtime-paths.ts` is the single source of truth for all path resolution:

- **Dev mode**: monorepo root derived from `import.meta.url` (4 levels up from `dist/main/`)
- **Packaged mode**: persisted workspace path or auto-created default in `app.getPath('userData')/workspace`
- `requireProjectRoot()` — strict getter, throws if not initialized
- `getNodeExec()` — resolves correct Node executable for spawning subprocesses (Electron helper on macOS, system node, or ELECTRON_RUN_AS_NODE fallback)

### esbuild bundling

electron-vite bundles the main process with three entry points:

| Entry | Output | Purpose |
|-------|--------|---------|
| `src/main/index.ts` | `dist/main/index.js` | Electron main process |
| `src/main/sdk-worker.ts` | `dist/main/sdk-worker.js` | Worker thread for CLI operations |
| `src/main/sdk-parse-child.ts` | `dist/main/sdk-parse-child.js` | Sandboxed generated-profile parsing |

External modules (not bundled): `electron`, `@lydell/node-pty`, `better-sqlite3`, `tree-sitter*`, `neo4j-driver`, `@anthropic-ai/claude-agent-sdk`, `typescript`, `ts-morph`.

After bundling, docs-gen templates are copied to `dist/main/templates/` for runtime template loading.

### Runtime bundle

`scripts/copy-runtime-bundles.mjs` creates a symlink-free `dist/runtime/` directory containing:

- `packages/{cli,mcp,core,db,docs-gen}/` — @coredoc packages
- `_vendor/` — all transitive runtime dependencies (renamed to `node_modules` by afterPack)

This is necessary because the MCP server and CLI are spawned as separate Node.js processes and need their full dependency trees on disk.

## MCP for External Agents

The MCP server works standalone without the desktop app running. Configure your AI tool (Cursor, Claude Code, Codex) with:

```json
{
  "mcpServers": {
    "coredoc": {
      "command": "/absolute/path/to/node-or-electron-helper",
      "args": ["/absolute/path/to/packages/mcp/dist/index.js"],
      "env": {
        "ELECTRON_RUN_AS_NODE": "1",
        "COREDOC_DB_BACKEND": "sqlite",
        "MCP_CONFIG_PATH": "/absolute/path/to/coredoc.config.json",
        "COREDOC_SCOPE": "project:<projectId>"
      }
    }
  }
}
```

The desktop app's **Connect** page shows the exact command, args, and project-bound env values for the current runtime. In dev it resolves a launchable Node/Electron binary; in packaged builds it resolves the bundled runtime. Repo context may narrow queries inside the bound project, but it never selects a different database.

## CI

The GitHub Actions workflow (`.github/workflows/desktop-smoke.yml`) runs on pushes and PRs that touch `apps/desktop/` or `packages/`:

1. Install dependencies
2. Build all packages
3. Build desktop main + preload
4. Run pre-packaging smoke test
