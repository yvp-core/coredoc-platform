# Coredoc On-Prem — Cloud Agent Runs (Agent Runner)

Cloud agent runs turn a Jira issue into draft pull requests. A person labels an
issue (or starts a run from the **Agent runs** page). An agent reads the issue
description as the PRD, proposes a scope and a spec, and waits for a person to
accept them. It then implements the change on `coredoc/<ISSUE-KEY>` branches
and opens one draft pull request per repository. Nothing is merged: people
review and merge.

The feature is optional and off by default. It adds one component to the
install: the **agent runner**, a separate Deployment in the same chart that
runs Claude Code against your repositories. This guide covers what to prepare,
how to install the runner, and what it changes about your egress and risk.

- Main install: [INSTALL.md](INSTALL.md)
- Upgrades: [UPGRADE.md](UPGRADE.md) and [§9](#9-upgrades) below
- Sizing: [SIZING.md](SIZING.md) and [§10](#10-sizing) below

> **File contents are sent to the model API.** Your repositories and clones stay
> in your infrastructure, but whatever the agent reads into its context (source
> files, test output, dependency manifests, the issue text) is sent to the model
> API you configure: the Anthropic API, or your own gateway in front of it.

---

## 1. How it fits together

| Component | Does | Holds |
|---|---|---|
| **coredoc-server** | Run state, the Jira trigger and the Jira comments, scope acceptance, run pages, verifying reported pull requests. **Calls no LLM.** | Its existing secrets. The GitHub connector token stays read-only. |
| **agent runner** | Claims one turn at a time over outbound HTTPS, clones the run's repositories, runs Claude Code with the `coredoc-workflows` plugin, pushes `coredoc/**` branches and opens draft pull requests as the bot account. | Only its own Secret: the model key, the bot's GitHub token and the runner token. None of the server's database, storage, Neo4j, encryption, OAuth or license configuration. |

The runner needs no inbound connections. It reaches the Coredoc API (by default
the in-cluster server Service) and the hosts in [§7](#7-egress). One runner
Deployment serves one workspace; install another release for another workspace.

## 2. Prerequisites

Work through this list before you enable anything. Settings show each unmet
server-side condition with its reason (§6).

| # | Prerequisite | Where |
|---|---|---|
| 1 | A dedicated Anthropic API key with a provider-side spend limit | §2.1 |
| 2 | A real object-storage endpoint and `SERVER_ENCRYPTION_KEY` on the server | §2.2 |
| 3 | Delivery analytics with an active Jira connector, its project keys and its user's permissions | §2.3 |
| 4 | An active GitHub connector (on GitHub Enterprise Server, listing the agent-run repositories) | §2.4 |
| 5 | A bot account: Write role, organisation member | §2.5 |
| 6 | The bot's token, with the right permissions and never `workflow` | §2.6 |
| 7 | Branch rulesets: default branch (with latest-push approval), run branches, tags | §2.7 |
| 8 | CI secret handling for `coredoc/**` branches | §2.8 |
| 9 | A derived runner image with your toolchains | §3 |
| 10 | A runner token and the runner Secret | §4 |

### 2.1 A dedicated model API key

Create an Anthropic API key used by nothing else, and set a **spend limit on it
at the provider**. Coredoc's per-run budget (25 USD by default, in settings) is
an estimate the runner reports itself; it limits honest runs, not a
compromised one. The agent can read the key from its own environment, so the
provider-side limit is what bounds spend.

Where the provider allows it, turn off server-side tools (web fetch, web
search, code execution) for the key's organisation, or route the runner
through your gateway (`agentRunner.modelBaseUrl`) and enforce it there. See
[§11](#11-limitations-and-risks).

### 2.2 Server: object storage and encryption key

- `storage.endpoint` must be a real S3-compatible endpoint, not the
  container-local fallback: agent state archives must survive across server
  replicas and restarts.
- `SERVER_ENCRYPTION_KEY` must be set in the auth Secret (INSTALL.md §5). The
  Jira connector's credentials are stored encrypted with it.

### 2.3 Jira connector

Agent runs use the Delivery analytics Jira connector (Jira Cloud only), so
Delivery analytics must be enabled for the workspace.

- Add the connector under **Settings → Delivery** with the **project keys**
  agent runs may start from. The trigger searches only those projects, and a
  run whose issue leaves them fails.
- The connector's Jira user needs, in each of those projects:
  **Browse projects**, **Add comments** and **Transition issues**. Coredoc
  comments on the issue when a run is done or fails, and moves it to the
  optional done status from settings.
- The server reaches the Jira site directly (§7).

### 2.4 GitHub connector

The workspace's GitHub connector (also under **Settings → Delivery**) maps each
repository to its GitHub host, gives the runner its clone URL, and lets the
server verify the pull requests the runner reports. Its token stays read-only;
the runner writes with the bot's own token.

- Every repository an agent may touch must be registered in the workspace with
  its git remote and resolve to exactly one active GitHub connector. Settings
  list each repository with its eligibility and the reason when it is not.
- **On GitHub Enterprise Server**, list the agent-run repositories in the
  connector's **Repositories** field (`owner/name`), and set the connector's
  host to `https://<ghes-host>/api/v3`.

### 2.5 The bot account

Create a dedicated machine account for the agent:

- a **member of the organisation**, not an outside collaborator;
- with the **Write** role on the agent-run repositories, and nothing higher.

The runner refuses to work while the bot is an admin or maintainer of any
repository it can see: at start-up it claims nothing and settings show
*Start-up check failed* with the reason (§6).

Commits are authored as `agentRunner.gitAuthor.name` and
`agentRunner.gitAuthor.email`; use the bot account's no-reply address.

### 2.6 The bot token

Use **one** of these, and never grant `workflow`:

- **A fine-grained token** (preferred), limited to the agent-run repositories,
  with **Contents: read and write**, **Pull requests: read and write** and
  **Metadata: read**. No Workflows and no Administration. Approve it where your
  organisation requires approval of fine-grained tokens.
- **A classic token with `repo` and `read:packages`**, only when the
  repositories install packages from **GitHub Packages**, whose npm registry
  accepts no fine-grained token. The bot account's repository access then
  bounds what the token reaches.

Without the Workflows permission GitHub refuses pushes that change workflow
files. The runner withholds such changes from its commits and offers their
diff to a person on the run page instead.

The token lives only in the runner Secret. Coredoc never stores it.

### 2.7 Branch rules

Contents write lets a token push and merge through the API, so your GitHub
rules, not the runner, keep agent code out of protected branches. Set these up
with rulesets (or classic branch protection where noted) on every agent-run
repository, with the bot account **not** on any bypass list:

1. **Default branch** (required):
   - require a pull request with at least one approval;
   - require **approval of the most recent reviewable push**, so the bot cannot
     push after the approval and merge;
   - block deletions and force pushes.
2. **Merge gate** (recommended): a *Restrict updates* rule on the default
   branch whose bypass list is the teams that merge, or classic "Restrict who
   can push to matching branches" without the bot.
3. **Run branches** (recommended): a branch ruleset targeting all branches
   **except** `coredoc/**` that restricts creations, updates and deletions,
   with your developers' team (not the bot) on the bypass list. The bot can
   then write only to run branches.
4. **Tags** (required wherever a tag starts a release workflow; recommended
   everywhere): a tag ruleset targeting all tags that restricts creations,
   updates and deletions to people. Branch rulesets do not cover tags, and a
   Write-role token can otherwise push a tag that starts a release workflow
   with its secrets.

### 2.8 CI on agent branches

Every push to `coredoc/**` and every draft pull request runs your existing
push and pull-request workflows on agent-written code, on your CI runners,
with the secrets those workflows receive. Same-repository pull requests get
secrets that pull requests from forks do not. Before enabling agent runs:

- keep sensitive secrets in **environments** with required reviewers, or with
  deployment-branch rules limited to protected branches;
- make the default workflow token **read-only** (repository or organisation
  setting *Workflow permissions: read repository contents and packages*);
- exclude `coredoc/**` from workflows that use sensitive secrets or
  self-hosted runners, for example:

  ```yaml
  on:
    push:
      branches-ignore: ['coredoc/**']
  jobs:
    deploy:
      if: ${{ !startsWith(github.head_ref || github.ref_name, 'coredoc/') }}
  ```

- **keep pull-request test workflows running** on `coredoc/**`, without
  sensitive secrets. The runner pod has no Docker, so repositories whose tests
  need `docker compose` (databases, caches) are reported as "not built or
  tested in the runner"; their tests run only in your CI on the draft pull
  request.

## 3. Build the derived runner image

The published image `ghcr.io/yvp-core/coredoc-agent-runner:<version>` holds
Node, the runner, the pinned Agent SDK (which bundles Claude Code), the pinned
`coredoc-workflows` plugin, git, yarn 1 and an init process. It is
**linux/amd64 (glibc) only**, non-root (uid 10001) and runs with a read-only
root filesystem. It does not hold your repositories' toolchains.

Derive your own image that adds them, starting from
[`apps/agent-runner/derived-image.example.Dockerfile`](../../apps/agent-runner/derived-image.example.Dockerfile):

```bash
docker buildx build --platform linux/amd64 \
  --build-arg RUNNER_IMAGE=registry.example.com/coredoc/coredoc-agent-runner:<version> \
  --build-arg NODE_VERSIONS="20 22" --build-arg EXTRA_TOOLS="go@1.26" \
  -f derived-image.example.Dockerfile \
  -t registry.example.com/coredoc/agent-runner-derived:<version> .
```

The example's header lists the constraints: tools must work from `PATH` alone
(Claude Code gets an explicit environment with a fresh per-turn `HOME`), and
everything is installed at build time because the root filesystem is
read-only. Verify the base image like the server's (INSTALL.md §3.1) before you
build on it. Rebuild the derived image from **every** runner release (§9).

## 4. Runner token and Secret

1. In the web app, open **Settings → Agent runs → Runner tokens** and create a
   runner token. You need to be a workspace admin. The token works only on
   this workspace's runner API, is shown once, and stops working if its
   creator leaves the workspace or stops being an admin (settings then say so).
2. Note the workspace ID (the runner's `agentRunner.workspaceId`).
3. Create the runner Secret. Every key becomes a variable in the runner:

   ```bash
   kubectl create secret generic coredoc-agent-runner \
     --from-literal=ANTHROPIC_API_KEY="<dedicated model key>" \
     --from-literal=COREDOC_GITHUB_TOKEN="<bot token>" \
     --from-literal=COREDOC_RUNNER_TOKEN="<runner token, cdt_…>" \
     -n coredoc
   ```

   Add any credential a package registry needs as another key and name it in
   `agentRunner.packageRegistries` (`credential: env:<KEY>`).

Revoking the runner token (same page) stops that runner at its next request.

## 5. Enable the runner in the chart

Add an `agentRunner` block to your values and `helm upgrade`:

```yaml
agentRunner:
  enabled: true
  image:
    repository: registry.example.com/coredoc/agent-runner-derived
    tag: "<version>"
  existingSecret: coredoc-agent-runner
  workspaceId: "<workspace-id>"
  gitAuthor:
    name: "Coredoc agent"
    email: "<bot-id>+<bot-login>@users.noreply.github.com"
```

| Key | Meaning |
|---|---|
| `agentRunner.enabled` | Default `false`. Renders the runner Deployment (and the optional NetworkPolicy). The server Deployment does not change. |
| `agentRunner.image.repository` / `tag` / `digest` / `pullPolicy` | The runner image, normally your derived image. Not tied to the server image; empty `tag` follows the chart `appVersion`; `digest` wins over `tag`. Pull secrets come from `image.pullSecrets`. |
| `agentRunner.replicas` | Default `1`. One turn per replica; scale concurrency with replicas (§10). |
| `agentRunner.resources` | Default requests 1 CPU / 2Gi, limits 4 CPU / 8Gi. |
| `agentRunner.existingSecret` | **REQUIRED.** The runner Secret from §4, loaded via `envFrom`. |
| `agentRunner.workspaceId` | **REQUIRED.** The workspace this runner serves. |
| `agentRunner.apiUrl` | Coredoc API base URL. Default: the in-cluster server Service on port 3000. |
| `agentRunner.githubApiUrl` | GitHub REST API the bot is checked against. Empty for github.com; `https://<ghes-host>/api/v3` for GitHub Enterprise Server. |
| `agentRunner.gitAuthor.name` / `email` | Commit identity. `email` is **REQUIRED**; `name` defaults to `Coredoc agent`. |
| `agentRunner.modelBaseUrl` | Optional model gateway (`ANTHROPIC_BASE_URL`). Empty uses the Anthropic API. |
| `agentRunner.packageRegistries` | Registries for dependency installs, keyed by package scope or `default`, written into each turn's user-level `.npmrc` (repository registry files are never decrypted). `credential` is `github` (the bot token; GitHub Packages needs the classic token from §2.6), `env:<KEY>` (a key of the runner Secret) or omitted. |
| `agentRunner.proxy.httpsProxy` / `httpProxy` / `noProxy` | Outbound proxy for the runner, Claude Code, git and package managers. |
| `agentRunner.caBundle.configMap` / `key` | Extra PEM bundle for a TLS-inspecting proxy or internal registry. Node and Claude Code add it to their defaults; **git uses it instead of the system bundle**, so include the public roots unless all traffic goes through the inspecting proxy. |
| `agentRunner.scratch.sizeLimit` / `medium` | The only writable volume, wiped after every turn. Default `16Gi` on node disk (§10). |
| `agentRunner.terminationGracePeriodSeconds` | Default `180`: covers stopping a session, including its session-end hook. |
| `agentRunner.nodeSelector` / `tolerations` / `affinity` | Default node selector `kubernetes.io/arch: amd64`. |
| `agentRunner.env` | Escape hatch: extra plain variables on the runner container. |
| `agentRunner.networkPolicy.enabled` / `egress` / `dns` | Optional NetworkPolicy (§7). |

The Deployment runs non-root with a read-only root filesystem, no
service-account token, all capabilities dropped and the `RuntimeDefault`
seccomp profile.

Running the runner outside Kubernetes is possible (it needs only outbound
HTTPS to the hosts in §7 and the variables in §8), but the chart is the
documented path. The single-VM Compose topology has no runner.

## 6. Turn on agent runs and check the runner

Under **Settings → Agent runs** (workspace admins):

1. Check **availability**: every unmet condition from §2 is listed with its
   reason. Switching on needs all of them.
2. Switch agent runs on. The admin who does so is recorded as the **run
   owner**: Jira-triggered runs act as that member, who must stay a current
   member.
3. Review the settings: trigger label (default `coredoc-agent`), done status,
   questions policy, scope acceptance, spend per run, turn and run time
   limits, started runs per workspace, repositories per run, and the model
   (Claude Code's default when unset).

Each runner token shows its runner's last report, on the settings page and on
the **Agent runs** page:

| Shown | Meaning |
|---|---|
| `claim …` / `heartbeat …` with versions | The runner is polling or working. |
| *Start-up check failed: …* | The runner started but claims nothing: the Agent SDK could not start Claude Code, the plugin did not load or loaded with errors or without its skills, the bot account has admin or maintain permission, GitHub refused to list the bot's repositories, or `COREDOC_PACKAGE_REGISTRIES` is invalid. It checks again every minute. |
| *Refused: this runner version is not supported* | The runner's protocol version is one the server does not support. Upgrade the runner (or the server, §9). |
| *Refused: its creator is no longer an admin* | Mint a new token and update the Secret. |
| *Never connected* | No runner has used the token yet. |

Runs queue without a runner and say they are waiting, so a runner restart
never refuses a start. The runner logs its runner, SDK, Claude Code and plugin
versions at start-up.

## 7. Egress

**Server** (in addition to INSTALL.md §11):

- your **Jira Cloud site** (`https://<site>.atlassian.net`): the trigger,
  issue reads, comments and transitions;
- the **GitHub connector's API host** (`api.github.com`, or your GitHub
  Enterprise Server host): repository resolution and pull request
  verification.

Delivery analytics already uses both. The server still calls no LLM.

**Runner:**

- the **model API**: `api.anthropic.com`, or your gateway;
- **GitHub**: `github.com` and `api.github.com`, or the single GitHub
  Enterprise Server host, which serves git and the REST API under `/api/v3`;
- the **package registries** your toolchains install from, preferably
  read-only internal mirrors;
- the **Coredoc API** (in-cluster by default).

The runner turns off Claude Code's telemetry, error reporting, auto-update and
other non-essential traffic itself. Two connections remain:

- with an API key against the Anthropic API, Claude Code polls managed
  settings and policy limits on the same host;
- at start-up Claude Code fetches its plugin security list from
  `raw.githubusercontent.com`; blocking it fails harmlessly.

Claude Code, git and the package managers honour the standard proxy variables
(`agentRunner.proxy`).

**NetworkPolicy.** With `agentRunner.networkPolicy.enabled`, the chart denies
all ingress to the runner and limits its egress to cluster DNS, the in-cluster
Coredoc server and the rules in `agentRunner.networkPolicy.egress` (rendered
verbatim). NetworkPolicy matches IP blocks, not host names, so list the CIDRs
of the hosts above, or, simpler, only your egress proxy:

```yaml
agentRunner:
  networkPolicy:
    enabled: true
    egress:
      - to: [{ ipBlock: { cidr: 10.0.0.10/32 } }]   # the egress proxy
        ports: [{ protocol: TCP, port: 3128 }]
```

It needs a CNI that enforces NetworkPolicy.

## 8. Environment reference

The chart sets these from the values in §5 and the runner Secret. Set them
yourself only when you run the runner outside the chart. A missing required
variable stops the runner with exit code 2.

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `COREDOC_API_URL` | yes | (chart: in-cluster Service) | Coredoc API base URL, e.g. `http://coredoc:3000`. |
| `COREDOC_WORKSPACE_ID` | yes | | The workspace the runner serves. |
| `COREDOC_RUNNER_TOKEN` | yes | | The workspace's runner token (`cdt_…`). |
| `COREDOC_GITHUB_TOKEN` | yes | | The bot account's token (§2.6). |
| `COREDOC_GIT_AUTHOR_EMAIL` | yes | | Commit author email, the bot's no-reply address. |
| `COREDOC_GIT_AUTHOR_NAME` | no | `Coredoc agent` | Commit author name. |
| `COREDOC_GITHUB_API_URL` | no | `https://api.github.com` | GitHub REST API for the bot's start-up check; `https://<ghes-host>/api/v3` on GitHub Enterprise Server. |
| `COREDOC_PACKAGE_REGISTRIES` | no | | JSON object keyed by package scope (`@scope`) or `default`: `{"@scope": {"url": "https://npm.pkg.github.com", "credential": "github"}, "default": {"url": "https://npm-mirror.example.com/"}}`. `credential` is `github`, `env:<VARIABLE>` or omitted; a credential is only sent to an `https` registry. An invalid value is reported as a start-up problem (§6). |
| `COREDOC_RUNNER_SCRATCH` | no | `/scratch` (image) | The scratch volume. |
| `COREDOC_WORKFLOWS_PLUGIN_PATH` | no | `/opt/coredoc-workflows` (image) | The pinned plugin in the image. |
| `ANTHROPIC_API_KEY` | yes | | The dedicated model key (§2.1). |
| `ANTHROPIC_BASE_URL` | no | Anthropic API | Your model gateway. |
| `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` | no | | Outbound proxy; passed to Claude Code, git and package managers. |
| `NODE_USE_ENV_PROXY` | no | | `1` makes the runner's own requests (Coredoc API, GitHub) use the proxy variables. The chart sets it when a proxy is configured. |
| `NODE_EXTRA_CA_CERTS` / `GIT_SSL_CAINFO` | no | | Extra CA bundle for Node and Claude Code, and git's CA file. The chart sets both from `agentRunner.caBundle`. `SSL_CERT_FILE` and `SSL_CERT_DIR` are passed through when set. |

Claude Code itself gets an explicit environment built by the runner (`PATH`
from the image, a per-turn home, the model key, the opt-outs and the proxy and
CA variables), never the runner's own: the bot token and the runner token are
kept out of it.

The server side has one setting of its own, `AGENT_RUN_RETENTION_ENABLED`
(see `apps/server/ONPREM.md` §5).

## 9. Upgrades

- **Rebuild the derived image from each runner release.** The runner, the SDK
  and the plugin are pinned together in the base image; a derived image built
  on an older base keeps the older runner.
- **Upgrade the server first, then the runner.** Every claim carries the
  runner's protocol version; a server that does not support it refuses the
  runner, and settings show *Refused: this runner version is not supported*.
- **Rollouts discard in-flight turns.** On SIGTERM the runner stops the
  session, skips its pushes and does not complete the turn. The turn's lease
  expires and the turn runs again from the previous state archive and the
  remote branches, so **its model spend is repeated**. If that matters, roll
  the runner while the **Agent runs** page shows no turn in progress.

## 10. Sizing

| Item | Default | Notes |
|---|---|---|
| Turns per replica | 1 | Deliveries included. Add replicas for throughput. |
| Scratch per replica | `16Gi` | Clones, installed dependencies and package caches of one turn, wiped after it. Measured: about 6 GiB for five large backend services, about 12 GiB for five large web apps. |
| Runner CPU / memory | 1 CPU / 2Gi request, 4 CPU / 8Gi limit | Builds and tests run inside the pod; raise with your toolchains. |
| Base image | about 700 MB (about 290 MB compressed) | A derived image with five Node majors and Go measured about 1.9 GB. |
| State archives (object storage) | capped at 128 MiB per archive | Measured median 2.3 MiB; deleted 30 days after the run ends. |

## 11. Limitations and risks

- **What the model API sees.** Repositories and clones stay in your
  infrastructure, but whatever the agent reads into its context is sent to the
  model API.
- **The agent holds the runner's credentials.** A prompt-injected agent can use
  the bot's token within its scope (push to unprotected branches, open and
  comment on pull requests, read the repositories it covers), use or send out
  the model key, so spend is bounded by the key's provider-side limit rather
  than the run's budget, and act as a runner of its workspace. The mitigations
  are configuration: a dedicated key with a spend limit, a narrowly scoped
  token, the branch rules, the run-branch ruleset, egress policy, and revoking
  the runner token.
- **Exfiltration.** Anything the agent can read can leave through an allowed
  host that accepts uploads, such as a public package registry or the GitHub
  organisation itself. The model API is an allowed host too: with the key, the
  agent can call the API's server-side web fetch, web search or code execution
  tools and reach arbitrary URLs from the provider's side, past the pod's
  network policy. Prefer read-only internal mirrors, and turn off server-side
  tools for the key's organisation where the provider allows it, or route
  through your gateway.
- **CI on agent branches.** CI runs agent-written code with the secrets the
  repositories' workflows receive, unless you follow §2.8.
- **Archives are unredacted.** State archives hold full transcripts, meaning
  file contents and tool output. They sit in your object storage for 30 days,
  readable by anyone with access to that storage.
- **Questions are stored unredacted.** The agent's questions to people, and
  their answers, are stored as written and kept with the run. Only run event
  payloads are redacted.
- **Redaction gaps.** Event payloads are masked for common credential shapes,
  and the runner masks the exact values it holds; other secrets the agent
  reads can reach the run page.
- **Self-reported spend.** Spend comes from the runner and is Claude Code's
  list-price estimate on your key, not billing. The run budget limits honest
  runners, not a compromised one.
- **Waiting holds slots.** Runs waiting for a person keep their slot, so two
  waiting runs block a workspace at the default limit of 2 started runs.
- **Test dependencies.** The runner pod has no Docker, so tests that need
  `docker compose` do not run there; those repositories are reported as not
  built or tested, and their tests run in your CI on the draft pull request
  (§2.8).
- **Slow intent reads.** Intent context reads have no server-side deadline;
  the agent's tool timeout caps the wait and the agent continues without that
  context.
- **Absent product owners.** Under the pause policy, a question addressed to
  the product owner may be answered by whichever member opens the run page.
- **Crash during turn completion.** If a runner dies after pushing some
  repositories but before completing the turn, the retried turn starts from an
  older session over newer branches. The agent sees the committed code.
- **A partitioned runner.** A runner that lost its lease but still runs can
  push once more before its next heartbeat; the re-claimed turn then fails
  with `push_rejected` or builds on that commit.
- **Throughput.** One replica runs one turn at a time. Size replicas for the
  expected load.

Machine-derived data (run events, turn rows and state archives) is deleted 30
days after a run ends unless `AGENT_RUN_RETENTION_ENABLED=false`. Runs, specs,
questions and answers, acceptances and change requests are never deleted
automatically.
