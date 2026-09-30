import { IntentReleaseTrigger } from './intent-release-types.js';

/** Graph sync only: GitLab deployment provenance is not implemented by the release action. */
export function gitlabCiWorkflow(input: {
  repoName: string;
  productionBranch: string | null;
  trigger: IntentReleaseTrigger;
  serverUrl: string;
}): { graph: string; deploymentNote?: string } {
  const trustedRef = input.productionBranch
    ? `$CI_COMMIT_BRANCH == ${JSON.stringify(input.productionBranch)} && $CI_COMMIT_REF_PROTECTED == "true"`
    : '$CI_COMMIT_REF_PROTECTED == "true"';
  const branchRule = input.productionBranch
    ? `    - if: ${JSON.stringify(`$CI_PIPELINE_SOURCE == "push" && ${trustedRef}`)}\n`
    : '';
  const webRule = `    - if: ${JSON.stringify(`$CI_PIPELINE_SOURCE == "web" && ${trustedRef}`)}\n`;
  return {
    deploymentNote:
      input.trigger === IntentReleaseTrigger.Deploy
        ? 'GitLab deployment evidence is not configured by this template. It publishes the graph only; keep intent release confirmation manual until the GitLab deploy integration is available.'
        : undefined,
    graph: `# Standalone .gitlab-ci.yml, or merge these jobs and append both stages below.
# Protect the configured production branch (or the chosen bootstrap ref).
# Set COREDOC_TOKEN masked/protected, with environment scope exactly coredoc-publish, NOT *.
# Set COREDOC_WORKSPACE_ID as a CI/CD variable. Use disposable, isolated job runners.
# Run only on trusted branches; do not expose the token to fork/MR pipelines.
# Enhanced compilers may execute repository build scripts with network access.
stages:
  - coredoc-prepare
  - coredoc
coredoc-dependencies:
  inherit:
    default: false
  stage: coredoc-prepare
  image: node:24-bookworm
  rules:
${branchRule}${webRule}  script:
    - |
      # Stop before package scripts if the token was accidentally scoped to all jobs.
      if [ -n "\${COREDOC_TOKEN:-}" ]; then
        echo 'Set COREDOC_TOKEN environment scope to coredoc-publish before installing dependencies.' >&2
        exit 1
      fi
      if [ -f package-lock.json ]; then npm ci; fi
      # Adapt dependency setup to your package manager and monorepo directories here.
      # - npm --prefix client ci
  artifacts:
    expire_in: 1 day
    paths:
      - node_modules/
      - "**/node_modules/"
coredoc:
  stage: coredoc
  needs:
    - job: coredoc-dependencies
      artifacts: true
  environment:
    name: coredoc-publish
    action: access
  image: node:24-bookworm
  resource_group: coredoc-$CI_PROJECT_ID
  interruptible: false
  variables:
    GIT_DEPTH: "0"
    COREDOC_REPO_NAME: ${JSON.stringify(input.repoName)}
    COREDOC_SERVER_URL: ${JSON.stringify(input.serverUrl)}
    COREDOC_PROFILE_PATH: .coredoc/profile.ts
  rules:
${branchRule}${webRule}      when: manual
  before_script:
    - apt-get update && apt-get install -y --no-install-recommends curl jq ca-certificates
    # Repository dependency scripts belong only in coredoc-dependencies above.

    # Enhanced modes need bubblewrap AND permission to create its namespaces.
    # If the runner denies them, use basic or a runner that supports isolation.
    # - apt-get install -y --no-install-recommends bubblewrap

    # C#: use a CI image with .NET SDK 10 and the repo's required SDK, plus Node 22+.
    # Go: use a CI image with the SDK from go.mod, then install its indexer:
    # - go install github.com/scip-code/scip-go/cmd/scip-go@v0.2.7
    # - export PATH="$(go env GOPATH)/bin:$PATH"
    # Rust: use a CI image with the repo's rustup toolchain, then:
    # - rustup component add rust-src
    # Install standalone rust-analyzer 0.3.3049 on PATH; see the parser README.
    # Ruby/Python indexers below do not require a Ruby/Python SDK.
  script:
    - |
      set -eu
      # Bundle and tool state stay outside the source checkout.
      export COREDOC_HOME="$(mktemp -d)"
      trap 'rm -rf "$COREDOC_HOME"' EXIT
      curl -fsSL "$COREDOC_SERVER_URL/api/v1/cli/bundle?v=latest" \\
        -H "Authorization: Bearer $COREDOC_TOKEN" -o "$COREDOC_HOME/bundle.json"
      CLI_URL=$(jq -er '.url' "$COREDOC_HOME/bundle.json")
      RUNTIME_URL=$(jq -er '.runtimeModulesUrl' "$COREDOC_HOME/bundle.json")
      CLI_SHA=$(jq -er '.sha256' "$COREDOC_HOME/bundle.json")
      RUNTIME_SHA=$(jq -er '.runtimeSha256' "$COREDOC_HOME/bundle.json")
      COREDOC_CLI_VERSION=$(jq -er '.version' "$COREDOC_HOME/bundle.json")
      export COREDOC_CLI_VERSION
      curl -fsSL "$CLI_URL" -o "$COREDOC_HOME/cli.mjs"
      curl -fsSL "$RUNTIME_URL" -o "$COREDOC_HOME/runtime.tar.gz"
      printf '%s  %s\\n' "$CLI_SHA" "$COREDOC_HOME/cli.mjs" | sha256sum --check --status
      printf '%s  %s\\n' "$RUNTIME_SHA" "$COREDOC_HOME/runtime.tar.gz" | sha256sum --check --status
      tar -xzf "$COREDOC_HOME/runtime.tar.gz" -C "$COREDOC_HOME"
      export COREDOC_RUNTIME_MODULES="$COREDOC_HOME/runtime-modules/node_modules"
      export NODE_PATH="$COREDOC_RUNTIME_MODULES"

      # Optional downloads: uncomment only the languages in this monorepo.
      # node "$COREDOC_HOME/cli.mjs" tools install csharp || echo 'C# setup failed; using profile fallback policy'
      # node "$COREDOC_HOME/cli.mjs" tools install ruby || echo 'Ruby setup failed; using profile fallback policy'
      # node "$COREDOC_HOME/cli.mjs" tools install python || echo 'Python setup failed; using profile fallback policy'

      # One parse applies the profile to every language target. Missing enhanced
      # prerequisites fall back visibly unless the target sets analysis.fallback: false.
      # TS/JS fallback with no resolved call/external-call edges is not published.
      # Add --dry-run to inspect results without publishing.
      node "$COREDOC_HOME/cli.mjs" ci run --repo "$COREDOC_REPO_NAME"
`,
  };
}
