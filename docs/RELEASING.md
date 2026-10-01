# Releasing

Two tag-driven pipelines publish from this repository. They use separate tag
namespaces because electron-updater's GitHub provider resolves Desktop updates
from semver tags and from `/releases/latest`.

| Tag | Workflow | Publishes |
| --- | --- | --- |
| `v1.5.0` | `desktop-release.yml` | Desktop stable: a GitHub Release marked **latest** |
| `v1.5.0-beta.1` | `desktop-release.yml` | Desktop beta: a GitHub **pre-release** |
| `server-v0.0.40` | `release.yml` | Server and CLI images, CLI bundle, Helm chart, air-gap kit; a GitHub Release that is **never** latest |

Never mark a `server-v*` release as latest by hand. Stable Desktop clients and
the server's `GET /api/v1/auth/web/desktop-download` both read
`/releases/latest`.

## Desktop

`apps/desktop/package.json` `build.publish` points electron-updater at
`github` / `yvp-core` / `coredoc-platform`. The workflow builds, signs and
notarizes both macOS architectures. It merges the per-arch update manifests
into one and attaches these files to the release:

- the DMGs
- the updater ZIPs and blockmaps
- `latest-mac.yml`, or `beta-mac.yml` for a beta

Update channels:

- A **stable** build follows only the latest stable release.
- A **`-beta.N`** build sets `allowPrerelease` and follows the newest
  pre-release, falling back to stable.
- Pre-release ids other than `alpha` or `beta` (such as `-rc.1`) are ignored
  by the provider. Use `-beta.N`.

**Closed networks.** A managed config `updateFeedUrl`
([on-prem §12](onprem/INSTALL.md#12-desktop-fleet-configuration-mdm)) switches
the app to a generic feed. Mirror one release's assets into a flat directory
at that URL: the `*-mac.yml` manifest, the ZIPs and the blockmaps.

**Migrating installs from the old R2 feed.** Builds released before the
GitHub feed still poll the old R2 worker URL. Upload the first GitHub-feed
release's macOS assets to that bucket once, and keep it serving until the
fleet has updated. After that, R2 is no longer used for Desktop.

## Server, CLI and chart

`release.yml` pushes the following, all signed keyless with cosign by digest:

- `ghcr.io/yvp-core/coredoc-server:{version}` and `:latest`
- `ghcr.io/yvp-core/coredoc-cli:{version}` and `:latest`
- `oci://ghcr.io/yvp-core/charts/coredoc`

The server image ships dist as built, including source maps.

The same release carries the CLI bundle for `GET /api/v1/cli/bundle`:
`coredoc-cli.mjs`, `runtime-modules.tar.gz`, and `cli-bundle.json` (the
version and SHA-256 checksums). The endpoint is public. It maps `v<semver>` to
the `server-v<semver>` release, and resolves `latest` to the newest non-draft,
non-pre-release `server-v*` release that has a `cli-bundle.json`.

**GHCR packages must be public, and writable from this repository.** For each
of `coredoc-server`, `coredoc-cli` and `charts/coredoc`, open
*github.com/yvp-core → Packages → the package → Package settings*:

1. **Manage Actions access**: add `yvp-core/coredoc-platform` with the
   **Write** role. A package created by another repository's workflow rejects
   this repository's `GITHUB_TOKEN` until you do this.
2. **Danger Zone → Change visibility → Public**. Anonymous `docker pull`,
   `helm pull` and `cosign verify` then work without credentials.

Verify signatures with the identity
`^https://github\.com/yvp-core/coredoc-platform/\.github/workflows/release\.yml@refs/tags/server-v`.
Images released from the previous repository carry that repository's identity.

## Hosted server on Railway

Deploy the published image instead of building from source:

1. Open the service, then *Settings → Source*. Disconnect the GitHub repo and
   choose **Connect Image**: `ghcr.io/yvp-core/coredoc-server:latest`, or pin
   `:{version}`. A public package needs no registry credentials.
2. Set *Settings → Deploy → Pre-deploy Command* to
   `sh -c "cd apps/server && npx prisma migrate deploy"`. This is the same
   command the Helm migration job uses. Migrations are forward-only.
3. Keep the existing variables, including `DATABASE_URL`. The start command
   comes from the image (`node apps/server/dist/main.js`).
4. To roll out a new release, redeploy. A `:latest` source picks up the new
   digest; for a pinned tag, update the tag first.

## Repository secrets and variables

| Name | Used by |
| --- | --- |
| `MAC_CERTIFICATE_P12_BASE64`, `MAC_CERTIFICATE_PASSWORD` | Desktop code signing |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Desktop notarization |
| `COREDOC_SERVER_URL` (variable) | Desktop build default server |
| `COREDOC_POSTHOG_KEY`, `COREDOC_POSTHOG_HOST` (variables, optional) | Desktop telemetry |

The Desktop jobs run in the `production` environment; define these secrets
there. When Windows builds are re-enabled (`build-other`), they will need a
Windows signing certificate as well. Releases need no R2 credentials: the
`R2_*` secrets and `R2_DESKTOP_BUCKET` can be deleted from GitHub. The server
still uses R2 at runtime for graph artifacts, configured in its own
environment.
