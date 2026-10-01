# =============================================================================
# Stage 1: Base - Install dependencies (server-only: byte-for-byte pre-B1-2
# semantics). The web dependency graph (vite, rollup, esbuild, react,
# tailwind, happy-dom, testing-library — ~43MB + CVE-scanner noise) must never
# land in this stage's node_modules, because the production stage copies that
# node_modules wholesale (see below). The web UI is built in its own isolated
# `web-build` stage below; only its dist crosses into production.
# =============================================================================
FROM node:22-bookworm-slim AS base

# Ladybug's pinned prebuilt is glibc. Keep the compiler fallback and Prisma's
# OpenSSL dependency in the build image, but do not introduce a musl shim.
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ openssl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9 --activate

WORKDIR /app

# Copy workspace config
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json ./packages/core/
COPY packages/db/package.json ./packages/db/
COPY packages/mcp/package.json ./packages/mcp/
COPY apps/server/package.json ./apps/server/

# Install server and its workspace dependencies only.
RUN pnpm install --frozen-lockfile --filter @coredoc/server...

# =============================================================================
# Stage 2: Build - Compile TypeScript (server-only)
# =============================================================================
FROM base AS build

# Copy source
COPY packages/core/ ./packages/core/
COPY packages/db/ ./packages/db/
COPY packages/mcp/ ./packages/mcp/
COPY apps/server/ ./apps/server/
COPY tsconfig.json ./

# Generate Prisma v7 client (outputs to apps/server/src/generated/prisma/)
RUN cd apps/server && npx prisma generate

# Build in dependency order.
RUN pnpm --filter @coredoc/core build && \
    pnpm --filter @coredoc/db build && \
    pnpm --filter @coredoc/mcp build && \
    pnpm --filter @coredoc/server build

# Provision FTS while the build has network access, then build and query a real
# Ladybug graph artifact. Any install/load/index/query failure is fatal. The
# selected Ladybug release uses ~/.lbdb/extension; the alternate cache path is
# copied too if a future pinned release adopts it.
RUN mkdir -p /app/fts-smoke /app/fts-smoke/work && \
    node apps/server/scripts/provision-ladybug-fts.mjs \
      /app/fts-smoke/offline.graph /app/fts-smoke/work && \
    rm -rf /app/fts-smoke/work && \
    mkdir -p /app/ladybug-home && \
    if [ -d /root/.lbdb/extension ]; then cp -a /root/.lbdb /app/ladybug-home/; fi && \
    if [ -d /root/.lbug/extensions ]; then cp -a /root/.lbug /app/ladybug-home/; fi && \
    test -n "$(find /app/ladybug-home -type f -print -quit)"

# Prune unambiguous dev tooling from node_modules that the runtime never loads
# (biome + turbo + vitest + @swc/core ≈ 190MB — the server builds with tsc, so swc is
# vitest-only). This must run in the build stage — before the production stage copies
# node_modules — so the bytes are actually gone: an `rm` in a layer after the COPY only
# writes a whiteout and leaves the image size unchanged. Prisma is untouched:
# @prisma/client (WASM query compiler), the generated client in dist, and the `prisma`
# migrate CLI (used by the ArgoCD PreSync hook) all remain. @swc+core* is matched
# narrowly so @swc/helpers (a possible runtime dep) is preserved.
RUN cd /app/node_modules/.pnpm && rm -rf @biomejs+* turbo@* turbo-* @vitest+* vitest@* @swc+core*

# =============================================================================
# Web build — isolated stage. Own install + own node_modules; only
# apps/web/dist crosses into the production stage, so the web dependency
# graph (vite/rollup/esbuild/react/tailwind/happy-dom/testing-library) never
# lands in the runtime node_modules. The SPA is served single-origin by the
# server (apps/server/src/libs/spa-serving.ts). @coredoc/core is a web
# devDependency (types only, not value-imported), so it needs no build here.
# =============================================================================
FROM node:22-bookworm-slim AS web-build

RUN corepack enable && corepack prepare pnpm@9 --activate

WORKDIR /app

# Copy workspace config (package.json copies before source for layer-cache
# friendliness, same convention as the base stage above).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json ./packages/core/
COPY apps/web/package.json ./apps/web/

RUN pnpm install --frozen-lockfile --filter @coredoc/web...

COPY packages/core/ ./packages/core/
COPY apps/web/ ./apps/web/

RUN pnpm --filter @coredoc/web build

# =============================================================================
# Stage 3: Production - Minimal runtime
# =============================================================================
FROM node:22-bookworm-slim AS production

# Runtime libraries for Prisma and TLS-backed control-plane clients.
RUN apt-get update && \
    apt-get install -y --no-install-recommends openssl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9 --activate

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOME=/opt/ladybug

# Copy built artifacts and node_modules.
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/core/package.json ./packages/core/
COPY --from=build /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=build /app/packages/db/dist ./packages/db/dist
COPY --from=build /app/packages/db/package.json ./packages/db/
COPY --from=build /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=build /app/packages/mcp/dist ./packages/mcp/dist
COPY --from=build /app/packages/mcp/package.json ./packages/mcp/
COPY --from=build /app/packages/mcp/node_modules ./packages/mcp/node_modules
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/server/package.json ./apps/server/
COPY --from=build /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=build /app/apps/server/prisma ./apps/server/prisma
COPY --from=build /app/apps/server/prisma.config.ts ./apps/server/

# This is a fresh stage: copy the image-provisioned native extension cache
# into the fixed runtime home, then make it traversable and readable by an
# arbitrary non-root UID. Runtime opens remain load-only.
COPY --from=build /app/ladybug-home/ /opt/ladybug/
RUN chmod -R a+rX /opt/ladybug

# Built SPA. registerSpaServing resolves apps/web/dist relative to
# apps/server/dist/main.js (two hops up, then web/dist) — see main.ts.
COPY --from=web-build /app/apps/web/dist ./apps/web/dist

EXPOSE 3000

# Start the server. Migrations run separately via the ArgoCD PreSync hook, not on boot.
CMD ["node", "apps/server/dist/main.js"]

# Production-derived verification target. The fixture and verifier stay out of
# the deployable production image while exercising its exact runtime layers.
FROM production AS offline-fts-test
COPY --from=build /app/fts-smoke ./fts-smoke
COPY --from=build /app/apps/server/scripts/offline-fts-smoke.mjs ./apps/server/scripts/
COPY --from=build /app/apps/server/scripts/verify-ladybug-fts-offline.mjs ./apps/server/scripts/
