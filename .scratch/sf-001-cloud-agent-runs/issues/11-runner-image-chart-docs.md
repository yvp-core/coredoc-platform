# 11: Runner image, Helm chart, release and docs

**What to build:** Operators can install the runner. A Coredoc-published runner image (runner, pinned SDK, pinned plugin, git, init process; linux/amd64 glibc), built on every pull request, signed with an SBOM and shipped in the air-gap kit. An optional `agentRunner` Deployment in the chart with its own image, Secret (model key, bot token, runner token), read-only root filesystem, scratch emptyDir, no service-account token and an optional NetworkPolicy; it receives none of the server's secrets. Install, egress, upgrade, sizing and CI-on-agent-branches documentation, including the derived-image example and the statement that file contents go to the model API.

**Blocked by:** 08, 13

**Status:** resolved

- [ ] Runner image builds in CI; the server image is unchanged and never contains the SDK
- [ ] `helm template` renders the runner Deployment as intended with no server secrets (inspected)
- [ ] Air-gap kit mirroring helper and values fragment include the runner image
- [ ] Install guide lists prerequisites (dedicated API key with spend limit, bot account, token permissions, branch rules, runner token, project keys), server and runner egress, and CI secret guidance
- [ ] Docs pass `git diff --check`

## Carried over from 06

- Chart env for the bot: `COREDOC_GITHUB_TOKEN` and `COREDOC_GIT_AUTHOR_EMAIL` (required), `COREDOC_GIT_AUTHOR_NAME` (optional); read-only root filesystem.
- Install the plugin at a path without spaces (the plugin's `file://` entry guard) and run the real preflight against a real remote.

## Carried over from 10

- Document `AGENT_RUN_RETENTION_ENABLED` (server) and `COREDOC_GITHUB_API_URL` (runner) in the environment reference.
- Runner retry with backoff on Coredoc 429 and transient errors.
- Limitations doc: question rows are stored unredacted; only event payloads are redacted.

## Carried over from 08

- Install docs: the Jira connector user's permissions (browse, add comments, transition issues) and the bot token's Pull requests permission.

## Carried over from 13

- Runner setting for package registries (scope → registry URL, which credential) and the per-turn user-level registry config the runner writes; chart values for it.

## Progress (2026-10-09)

Image part done on `feat/remote-agents` (`4dd8220`..`282ea6e`): runner image (linux/amd64 glibc, SDK 0.3.285, plugin pinned by commit, tini, non-root, read-only root), server image without any SDK, `scripts/images/check-images.sh` with size budgets and a PR-time `images` CI job, release signing, SBOM and air-gap entries, `COREDOC_PACKAGE_REGISTRIES` with the per-turn `.npmrc`, a neutral derived-image example, and the optional `agentRunner` Deployment and NetworkPolicy in the chart.

Still open in this ticket: the install, egress, upgrade, sizing and environment docs (including the carried-over items above), the start-up refusal reported through a heartbeat-only call, runner retries on Coredoc 429 and transient errors, and the first x86_64 run of the image check in CI (the start-up check inside the image is unverified locally).

## Answer

Done on `feat/remote-agents` (`4dd8220`..`45230a2`). Image, release and chart as in Progress above; then `docs/onprem/AGENT-RUNS.md` (install prerequisites, bot token and rulesets, egress, environment reference, upgrade, sizing, limitations) with updates to INSTALL, UPGRADE, SIZING, the server environment reference and ARCHITECTURE; start-up problems reported to settings as closed codes through `POST /agent-runner/startup-check` (detail masked by the runner, redacted and capped by the server); runner retries on 429, 5xx and dropped connections within the lease, repeating only calls that are safe to repeat. Open: the first x86_64 CI run of the image check, which also exercises the start-up check inside the image.
