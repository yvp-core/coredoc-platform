import { IntentReleaseTrigger } from './intent-release-types.js';
import { gitlabCiWorkflow } from './gitlab-ci-workflow.js';

export type CiPlatform = 'github' | 'gitlab';

export function intentCiWorkflow(input: {
  repoName: string;
  intentRepoKey: string | null;
  productionBranch: string | null;
  trigger: IntentReleaseTrigger;
  serverUrl: string;
  platform?: CiPlatform;
}): { graph: string; deploymentStep?: string; deploymentNote?: string } {
  if (input.platform === 'gitlab') return gitlabCiWorkflow(input);
  const graph = `name: Coredoc
on:
  workflow_dispatch:
${input.productionBranch ? `  push:\n    branches: [${JSON.stringify(input.productionBranch)}]\n` : ''}
concurrency:
  group: coredoc-\${{ github.repository }}-\${{ github.ref }}
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
      # This job analyzes trusted repository code. Enhanced compilers may run build scripts
      # with network access; use basic for untrusted code.
      - name: Install root npm dependencies when present
        if: \${{ hashFiles('package-lock.json') != '' }}
        run: npm ci
      # TS/JS: repeat for separate JS workspaces, or use your normal package manager.
      # - run: npm ci
      #   working-directory: client

      # Optional enhanced analysis on Linux needs working bubblewrap namespaces.
      # No privileged Docker mode is enabled by Coredoc.
      # - run: sudo apt-get update && sudo apt-get install -y bubblewrap

      # C#: .NET 10 plus the SDK required by the repo's global.json/targets.
      # - uses: actions/setup-dotnet@v6
      #   with:
      #     dotnet-version: '10.0.x'

      # Go: match the SDK to the repo's go.mod; install scip-go explicitly.
      # - uses: actions/setup-go@v7
      #   with:
      #     go-version-file: go.mod
      # - run: go install github.com/scip-code/scip-go/cmd/scip-go@v0.2.7

      # Rust: use the repo's toolchain, then add its optional components.
      # - run: rustup component add rust-src
      # Install standalone rust-analyzer 0.3.3049 on PATH; see the parser README.

      # Ruby and Python: no language SDK is required by these optional indexers.
      # Their explicit download is selected with install-tools below.
      - uses: yvp-core/coredoc-parser@main
        with:
          repo-name: ${JSON.stringify(input.repoName)}
${input.intentRepoKey ? `          intent-repo-key: ${JSON.stringify(input.intentRepoKey)}\n` : ''}          profile-path: .coredoc/profile.ts
          server-url: ${JSON.stringify(input.serverUrl)}
          workspace-id: \${{ secrets.COREDOC_WORKSPACE_ID }}
          token: \${{ secrets.COREDOC_TOKEN }}
          # Optional downloads, once before the monorepo parse. Remove unused names.
          # install-tools: 'csharp ruby python'
          # The profile selects basic/enhanced per target. Missing prerequisites
          # fall back visibly unless that target sets analysis.fallback: false.
          # TS/JS fallback is not published; install its dependencies above.
          # Optional summaries:
          # llm-api-key: \${{ secrets.OPENROUTER_API_KEY }}
`;
  if (input.trigger !== IntentReleaseTrigger.Deploy) return { graph };
  return {
    graph,
    deploymentStep: `# Insert AFTER the existing successful production-deploy step.
# This job needs contents: read, actions: read and pull-requests: read.
# Bind deployed_sha to the commit your deploy step actually deployed.
- name: Require the deployed revision
  shell: bash
  run: test -n "$DEPLOYED_SHA" || { echo "::error::The deploy step must output deployed_sha"; exit 1; }
  env:
    DEPLOYED_SHA: \${{ steps.deploy.outputs.deployed_sha }}
- uses: yvp-core/coredoc-parser@main
  with:
    repo-name: ${JSON.stringify(input.repoName)}
${input.intentRepoKey ? `    intent-repo-key: ${JSON.stringify(input.intentRepoKey)}\n` : ''}    profile-path: .coredoc/profile.ts
    server-url: ${JSON.stringify(input.serverUrl)}
    workspace-id: \${{ secrets.COREDOC_WORKSPACE_ID }}
    token: \${{ secrets.COREDOC_TOKEN }}
    intent-release: 'true'
    deploy-ref: \${{ steps.deploy.outputs.deployed_sha }}
`,
  };
}
