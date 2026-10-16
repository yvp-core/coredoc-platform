# =============================================================================
# Example: derive the Coredoc agent runner image with your repositories'
# toolchains, so the agent can install dependencies, build and test.
#
#   docker buildx build --platform linux/amd64 \
#     --build-arg RUNNER_IMAGE=registry.example.com/coredoc/coredoc-agent-runner:<version> \
#     --build-arg NODE_VERSIONS="20 22" --build-arg EXTRA_TOOLS="go@1.26" \
#     -f derived-image.example.Dockerfile -t registry.example.com/coredoc/agent-runner-acme:<version> .
#
# Point the chart's agentRunner.image at the result, and rebuild it from every
# new runner release.
#
# Constraints the runner puts on toolchains:
#   - Claude Code gets an explicit environment: PATH from this image, a fresh
#     per-turn HOME and TMPDIR, and nothing else of yours. A tool must work
#     from PATH alone, without variables such as NVM_DIR or a shell profile.
#   - The root filesystem is read-only at run time, so everything is installed
#     here, root-owned. Package caches land in the per-turn HOME and are wiped
#     with the scratch volume after every turn.
#   - Registry credentials are not baked in: the runner writes each turn's
#     user-level registry configuration from COREDOC_PACKAGE_REGISTRIES.
#
# The example uses mise as the version manager: its system-wide installs and
# shims need no per-user state, and its shims pick the version a repository
# pins in .nvmrc, .node-version, .tool-versions or mise.toml. The base image
# already has git and yarn 1 (yarn runs on whichever Node the shim selects).
# =============================================================================
ARG RUNNER_IMAGE=ghcr.io/yvp-core/coredoc-agent-runner:latest
FROM ${RUNNER_IMAGE}

USER root

# mise, pinned and checksum-verified (linux-x64 release binary).
ARG MISE_VERSION=2026.10.4
# From the release's SHASUMS256.txt; change both together.
ARG MISE_SHA256=2b8ce21f550872807bcaabf45b6bc5c64bfbd6dc3bf49dd4e67de700ef3ceb75
ADD --chmod=0755 --checksum=sha256:${MISE_SHA256} \
    https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/mise-v${MISE_VERSION}-linux-x64 /usr/local/bin/mise

# System-wide configuration: read the version files repositories already use,
# default to the newest Node when a repository pins none, and never download a
# missing version at run time (fail clearly instead).
ARG DEFAULT_NODE=22
RUN mkdir -p /etc/mise && printf '%s\n' \
      '[settings]' \
      'idiomatic_version_file_enable_tools = ["node", "go", "ruby", "python"]' \
      'not_found_auto_install = false' \
      '' \
      '[tools]' \
      "node = \"${DEFAULT_NODE}\"" \
      > /etc/mise/config.toml

# Install into /usr/local/share/mise (root-owned) and generate the system shims.
# Pin the exact minors your repositories require when they pin one (a
# repository with `18.20` in .nvmrc needs an 18.20.x install). Each extra tool
# (name@version) also becomes that tool's default, since some version files
# (go.mod, for one) are not read by mise.
ARG NODE_VERSIONS="20 22"
ARG EXTRA_TOOLS=""
RUN set -eu; \
    tools=""; \
    for v in $NODE_VERSIONS; do tools="$tools node@$v"; done; \
    for t in $EXTRA_TOOLS; do printf '%s = "%s"\n' "${t%%@*}" "${t#*@}" >> /etc/mise/config.toml; done; \
    MISE_DATA_DIR=/tmp/mise-build MISE_CACHE_DIR=/tmp/mise-cache \
      mise install --system $tools $EXTRA_TOOLS; \
    rm -rf /tmp/mise-build /tmp/mise-cache; \
    chmod -R go-w /usr/local/share/mise

ENV PATH=/usr/local/share/mise/shims:${PATH}

USER 10001:10001
