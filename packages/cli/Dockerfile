# =============================================================================
# Coredoc CLI image — runs `coredoc ci run` in CI/CD.
#
# Ships everything the profile-parser engine needs at runtime that a single-file
# bundle could not:
#   - a real node_modules, so web-tree-sitter + tree-sitter-wasms grammars resolve
#     deterministically (no bundle asset-resolution guesswork)
#   - the `scip-typescript` binary on PATH (the SCIP semantic tier), which the
#     engine shells out to via execFileSync('scip-typescript', ...)
#   - Node 22 (every package requires >=22)
#
# No native toolchain is needed: the parser is WASM (web-tree-sitter) and the only
# native runtime dep (@libsql/client) ships prebuilt platform binaries.
#
# Build context is the repo root. Consumed by action.yml / coredoc.yml via
# `docker run -v <repo>:/workspace -w /workspace <image> ci run -r <repo>`.
# The absolute ENTRYPOINT lets `-w /workspace` set the parse target (process.cwd())
# while the CLI itself loads from /app.
# =============================================================================

# =============================================================================
# Stage 1: Base — install all deps (dev included) for the build
# =============================================================================
FROM node:22-alpine AS base

RUN corepack enable && corepack prepare pnpm@9 --activate

WORKDIR /app

# Copy workspace config + only the manifests the CLI needs
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json ./packages/core/
COPY packages/db/package.json ./packages/db/
COPY packages/mcp/package.json ./packages/mcp/
COPY packages/profile-parser/package.json ./packages/profile-parser/
COPY packages/cli/package.json ./packages/cli/

RUN pnpm install --frozen-lockfile --filter @coredoc/cli...

# =============================================================================
# Stage 2: Build — compile TypeScript in dependency order
# =============================================================================
FROM base AS build

COPY packages/core/ ./packages/core/
COPY packages/db/ ./packages/db/
COPY packages/mcp/ ./packages/mcp/
COPY packages/profile-parser/ ./packages/profile-parser/
COPY packages/cli/ ./packages/cli/
COPY tsconfig.json ./
COPY scripts/gen-build-env.mjs ./scripts/

RUN pnpm --filter @coredoc/core build && \
    pnpm --filter @coredoc/db build && \
    pnpm --filter @coredoc/mcp build && \
    pnpm --filter @coredoc/profile-parser build && \
    pnpm --filter @coredoc/cli build

# =============================================================================
# Stage 3: Production — fresh prod-only install (no dev toolchain) + runtime
# =============================================================================
FROM node:22-alpine AS production

# musl compat for the prebuilt native .node (@libsql); openssl for TLS; git for the engine's commit capture
RUN apk add --no-cache git openssl libstdc++ libgcc

# The mounted repo is owned by the runner's uid, not root — allow git to read it
RUN git config --system --add safe.directory '*'

RUN corepack enable && corepack prepare pnpm@9 --activate

# SCIP semantic indexer, invoked as a bare `scip-typescript` binary by the engine
RUN npm install -g @sourcegraph/scip-typescript@0.4.0

WORKDIR /app
ENV NODE_ENV=production

# Profiles are pulled from the server at parse time (external input). Current profiles
# import only types (erased at transpile), but should a pulled profile carry a bare
# `@coredoc/*` runtime import, the loader rewrites it to this dir — where all four
# @coredoc packages are linked — instead of the parse target's node_modules (which
# has none). No-op for type-only profiles.
ENV COREDOC_RUNTIME_MODULES=/app/packages/cli/node_modules

# Prod-only install — drops the dev toolchain (biome, turbo, vitest, @types, …) that a
# wholesale node_modules copy would otherwise ship. --ignore-scripts skips the
# optional, unused better-sqlite3 native build; @libsql/sharp ship prebuilt binaries that need no install script.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json ./packages/core/
COPY packages/db/package.json ./packages/db/
COPY packages/mcp/package.json ./packages/mcp/
COPY packages/profile-parser/package.json ./packages/profile-parser/
COPY packages/cli/package.json ./packages/cli/
RUN pnpm install --prod --frozen-lockfile --filter @coredoc/cli... --ignore-scripts

# Built output — the install above symlinks @coredoc/* to these dirs.
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/db/dist ./packages/db/dist
COPY --from=build /app/packages/mcp/dist ./packages/mcp/dist
COPY --from=build /app/packages/profile-parser/dist ./packages/profile-parser/dist
COPY --from=build /app/packages/cli/dist ./packages/cli/dist

# claude-agent-sdk is dynamic-only and unused by `ci run` (summarize uses the ai-sdk path).
# Drop ~69MB; fail loudly if the pnpm store layout changes so this never silently no-ops.
RUN set -eu; \
    found="$(find node_modules/.pnpm -maxdepth 1 -type d -name '@anthropic-ai+claude-agent-sdk@*')"; \
    [ -n "$found" ] || { echo 'ERROR: claude-agent-sdk not found for removal — pnpm layout changed' >&2; exit 1; }; \
    printf '%s\n' "$found" | while IFS= read -r d; do rm -rf "$d"; done; \
    rm -rf node_modules/@anthropic-ai/claude-agent-sdk packages/cli/node_modules/@anthropic-ai/claude-agent-sdk

# Absolute path: `docker run -w /workspace` points process.cwd() at the mounted
# repo (the parse target) while Node still loads the CLI + @coredoc/* from /app.
ENTRYPOINT ["node", "/app/packages/cli/dist/index.js"]
