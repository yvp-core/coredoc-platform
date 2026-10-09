# =============================================================================
# Coredoc agent runner image — the customer-run pod that executes cloud agent
# runs (claims turns over the runner API, runs Claude Code through the Agent
# SDK, commits and pushes as the bot account).
#
# Contents: Node 22, the built runner with production dependencies only, the
# pinned Agent SDK with its linux-x64 (glibc) Claude Code binary, the pinned
# coredoc-workflows plugin, git, and tini as PID 1 to reap the orphans agent
# processes leave behind. Everything is root-owned; the runner runs as an
# unprivileged numeric user with /scratch as its only writable path (a
# read-only root filesystem in the chart).
#
# linux/amd64 with glibc only: the plugin's bundled runtime ships no other
# Linux build. The server image never contains the SDK; see
# scripts/images/check-images.sh.
#
# Customers derive this image to add their repositories' toolchains; see
# derived-image.example.Dockerfile next to this file.
#
# Build context is the repo root:
#   docker buildx build --platform linux/amd64 -f apps/agent-runner/Dockerfile .
# =============================================================================

# =============================================================================
# Stage 1: Build — install the runner's workspace closure and compile it
# =============================================================================
FROM node:22-bookworm-slim AS build

# The plugin's bundled runtime and the checks below are linux/amd64 only.
ARG TARGETARCH
RUN if [ "$TARGETARCH" != "amd64" ]; then echo "the runner image is linux/amd64 only (got $TARGETARCH)" >&2; exit 1; fi

RUN corepack enable && corepack prepare pnpm@9 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json ./packages/core/
COPY apps/agent-runner/package.json ./apps/agent-runner/

RUN pnpm install --frozen-lockfile --filter @coredoc/agent-runner...

COPY packages/core/ ./packages/core/
COPY apps/agent-runner/ ./apps/agent-runner/
COPY tsconfig.json ./

RUN pnpm --filter @coredoc/core build && \
    pnpm --filter @coredoc/agent-runner build

# =============================================================================
# Stage 2: Runtime dependencies — a fresh production-only install of the same
# closure (no TypeScript, no vitest), plus the compiled output
# =============================================================================
FROM node:22-bookworm-slim AS deps

RUN corepack enable && corepack prepare pnpm@9 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json ./packages/core/
COPY apps/agent-runner/package.json ./apps/agent-runner/

# No lifecycle scripts: the workspace root's `prepare` runs husky, a dev
# dependency, and nothing in the runner's production closure needs one.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter @coredoc/agent-runner...

# pnpm installs the workspace root's own dependencies with any filtered install
# (langchain, openai, an older Agent SDK, ...), and the frozen lockfile forbids
# trimming the root manifest. Keep only the store entries pnpm lists for the
# runner's production closure, then drop the root links and any hoisted link
# left dangling.
WORKDIR /app/apps/agent-runner
RUN set -eu; \
    pnpm list --prod --depth Infinity --parseable | \
      sed -n 's|^\(/app/node_modules/\.pnpm/[^/]*\)/.*|\1|p' | sort -u > /tmp/closure; \
    for entry in /app/node_modules/.pnpm/*; do \
      [ "${entry##*/}" = node_modules ] && continue; \
      grep -qxF "$entry" /tmp/closure || rm -rf "$entry"; \
    done; \
    find /app/node_modules -mindepth 1 -maxdepth 1 ! -name .pnpm -exec rm -rf {} +; \
    find /app/node_modules/.pnpm/node_modules -xtype l -delete; \
    rm /tmp/closure

COPY --from=build /app/packages/core/dist /app/packages/core/dist
COPY --from=build /app/apps/agent-runner/dist /app/apps/agent-runner/dist

# The SDK finds its Claude Code binary in an optional platform package, so a
# skipped optional dependency would only fail at the first turn. Require the
# pinned SDK and its glibc binary here, drop the musl twin the lockfile also
# resolves for linux/x64 (the SDK prefers the glibc build on this base).
# Running the binary is left to scripts/images/check-images.sh: it is a Bun
# executable that aborts under QEMU, so an emulated build could not run it.
RUN set -eu; \
    sdk_dir="$(realpath node_modules/@anthropic-ai/claude-agent-sdk)"; \
    test "$(node -p "require('$sdk_dir/package.json').version")" = "0.3.285"; \
    rm -rf /app/node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-linux-x64-musl@*; \
    test -x "$sdk_dir/../claude-agent-sdk-linux-x64/claude"; \
    chown -R root:root /app; \
    chmod -R go-w /app

# =============================================================================
# Stage 3: Plugin — the coredoc-workflows plugin, pinned by commit
# =============================================================================
FROM node:22-bookworm-slim AS plugin

RUN apt-get update && \
    apt-get install -y --no-install-recommends git ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# The plugin has no release tags yet, so it is pinned by full commit; git
# verifies the content against that hash. It is installed at a path without
# spaces (the plugin's file:// entry guard refuses others).
ARG COREDOC_WORKFLOWS_REPOSITORY=https://github.com/yvp-core/coredoc-workflows.git
ARG COREDOC_WORKFLOWS_COMMIT=d88b3e8761a3011352867f38d0815133342c9da5

RUN set -eu; \
    git init -q /src; \
    git -C /src fetch -q --depth 1 "$COREDOC_WORKFLOWS_REPOSITORY" "$COREDOC_WORKFLOWS_COMMIT"; \
    git -C /src checkout -q FETCH_HEAD; \
    test "$(git -C /src rev-parse HEAD)" = "$COREDOC_WORKFLOWS_COMMIT"; \
    cp -a /src/plugins/coredoc-workflows /opt/coredoc-workflows

# Keep only this platform's bundled runtimes, then check the remaining Bun
# binary against the plugin's own provenance file.
WORKDIR /opt/coredoc-workflows
RUN set -eu; \
    find runtime -mindepth 2 -maxdepth 2 -type d -name 'darwin-*' -exec rm -rf {} +; \
    node -e ' \
      const { createHash } = require("crypto"); \
      const { readFileSync } = require("fs"); \
      const pin = JSON.parse(readFileSync("runtime/bun/provenance.json", "utf8")).platforms["linux-x64"]; \
      const actual = createHash("sha256").update(readFileSync("runtime/bun/" + pin.binary)).digest("hex"); \
      if (actual !== pin.sha256) { console.error(`bundled Bun ${actual} does not match provenance ${pin.sha256}`); process.exit(1); }'; \
    chown -R root:root /opt/coredoc-workflows; \
    chmod -R go-w /opt/coredoc-workflows

# =============================================================================
# Stage 4: Production — runtime only
# =============================================================================
FROM node:22-bookworm-slim AS production

# git for clones, commits and pushes (HTTPS only); tini reaps orphans as PID 1.
RUN apt-get update && \
    apt-get install -y --no-install-recommends git ca-certificates tini && \
    rm -rf /var/lib/apt/lists/*

COPY --from=deps /app /opt/coredoc-agent-runner
COPY --from=plugin /opt/coredoc-workflows /opt/coredoc-workflows

# Both trees arrive root-owned and not group- or world-writable (set in their
# stages, so no layer here rewrites every file): a turn cannot leave code
# behind for the next one outside the scratch volume.
RUN groupadd --system --gid 10001 runner && \
    useradd --system --uid 10001 --gid 10001 --home-dir /scratch --no-create-home --shell /usr/sbin/nologin runner && \
    mkdir -p /scratch && chown 10001:10001 /scratch

ENV NODE_ENV=production \
    HOME=/scratch \
    TMPDIR=/scratch \
    COREDOC_RUNNER_SCRATCH=/scratch \
    COREDOC_WORKFLOWS_PLUGIN_PATH=/opt/coredoc-workflows

WORKDIR /scratch
USER 10001:10001

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/opt/coredoc-agent-runner/apps/agent-runner/dist/main.js"]
