# CI

### TypeScript and JavaScript publication

The CLI bundles `scip-typescript`; install the repository's own dependencies with
its normal package-manager command before CI analysis. Local parsing and profile
scoring can use basic analysis when those dependencies are absent. The output's
`stats.analysis` records the level actually used.

`coredoc ci run` logs TS/JS semantic fallback and refuses upload only if the resulting
graph has no resolved call or external-call edges. Useful basic output can still be
published. `--dry-run` produces output without uploading it. Actual extraction errors
remain blocking.

Enhanced C#/Go/Rust analysis may execute repository build code with network access.
CLI/CI keep enhanced with fallback as the default, without an interactive consent step.
Use it only on trusted code and trusted branches; choose `analysis.mode: 'basic'` otherwise.
This release does not block every LAN/cloud-metadata destination, and Linux shares the
runner network. A dedicated runner/network policy is required for that additional boundary.

### Optional C# enhanced analysis

The default C# profile policy is enhanced with visible basic fallback. A missing SDK or
indexer does not by itself fail CI. Strict enhanced is opt-in through
`substrate.analysis: { mode: 'enhanced', fallback: false }`; explicit basic is
`substrate.analysis: { mode: 'basic' }`.

For the bundle channel, provision .NET SDK 10 and `bubblewrap` on the Linux runner using
ordinary setup commands, then set `install-csharp-tools: true` on the Coredoc action.
That input explicitly runs `coredoc tools install csharp` after downloading the CLI.
It installs only the pinned, checksum-verified indexer outside the source checkout.
A setup download failure is logged; parsing then follows the profile's fallback policy.
The parser never installs SDKs or indexers. NuGet restore runs inside the isolated source copy with Coredoc-owned caches.

Linux enhanced also requires permission to create bubblewrap namespaces; having the
binary on PATH alone is insufficient. Nested Docker runners may deny those namespaces.
The default policy then reports the reason and completes in basic mode; strict enhanced
fails. Use a runner configured to support bubblewrap for enhanced analysis. The official
Alpine channel remains basic; no broader container privileges are enabled by the action.

For a standalone CLI job the same command is sufficient:

```sh
coredoc tools install csharp
coredoc ci run --repo your-repository
```

Cache `<COREDOC_HOME>/tools/scip-dotnet` to reuse the indexer between runs. Repository
restore data is separate, under `<COREDOC_HOME>/cache/csharp`; build processes cannot
write to the installed executable directory. Restore and indexing operate on an isolated
source copy and leave no `index.scip`, `bin`, `obj` or tool manifest in the checkout.

The official Docker image is Alpine and provides C# basic analysis; the action logs this
limitation. TS/JS use their bundled indexer and the publication check above.
Ruby/Python optional installation and Go/Rust SDK setup are documented in the [parser README](../packages/profile-parser/README.md#optional-ruby-python-go-and-rust-analysis). CI does not install them implicitly; choose basic, enhanced with fallback (default), or explicit strict enhanced in the language target. Windows desktop and GitLab validation
are separate work.

### Desktop-generated GitHub and GitLab templates

The Desktop CI/CD tab offers a provider selector. Both templates use each saved repository
name and production branch, with a manual bootstrap when no branch is configured. Setup
blocks are commented examples, not automatic language detection: enable only the toolchains
your profile uses and adapt dependency commands to your monorepo directories.

For GitHub bundle jobs, `install-tools: 'csharp ruby python'` explicitly installs those
optional indexers sequentially before the one monorepo parse. Omit languages you do not use.
`install-csharp-tools: true` remains supported for existing workflows. Go and Rust use ordinary
SDK commands shown in the template. Installation never happens implicitly inside the parser.

The GitLab template adds dependency-setup and graph-publication jobs to `.gitlab-ci.yml`, downloads the authenticated CLI
bundle and sidecar, checks both checksums, then invokes `ci run`. Configure `COREDOC_TOKEN`
as masked/protected with environment scope **`coredoc-publish`**, never `*`, and
`COREDOC_WORKSPACE_ID` as a CI/CD variable. Only the publication job declares that
environment (`action: access`, not a deployment). The dependency job refuses to run
package scripts when the token is visible. Install dependencies in that job and pass
`node_modules` through its expiring artifacts; adapt the commands/artifact paths for
other package managers and monorepo layouts. Use isolated disposable job runners so
setup processes cannot survive into publication.

Both push and manual web runs require the saved production branch to be protected;
when no production branch is configured, manual bootstrap requires a protected ref.
Unprotected and MR pipelines do not receive these jobs. The environment-scoping setup
follows [GitLab's variable guidance](https://docs.gitlab.com/ci/environments/#limit-the-environment-scope-of-a-cicd-variable). Its default Node/Debian
image does not contain .NET, Go or Rust; enhanced jobs need an appropriate image and working
bubblewrap namespaces. No privileged-container setting is added. GitLab branch/SHA metadata
is supported; automatic GitLab deployment-release evidence is not generated yet. Validate
the template with GitLab CI Lint before enabling it on your runner:
https://docs.gitlab.com/ci/yaml/ and https://docs.gitlab.com/ci/variables/predefined_variables/.
