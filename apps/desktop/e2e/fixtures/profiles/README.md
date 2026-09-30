# Seed profiles

Each profile is a complete, hermetic starting state for one Electron launch. The
launch fixture (`../launch.ts`) copies the sub-dirs into fresh temp dirs:

| Dir | Copied to | Read by |
|-----|-----------|---------|
| `workspace/` | `COREDOC_DESKTOP_E2E_WORKSPACE_DIR` (what `runtime-paths.ts` resolves as `projectRoot`) | `config-manager.ts` (`coredoc.config.json`), `state-manager.ts` (`coredoc-output/`, `coredoc-parsers/`) |
| `user-data/` | `COREDOC_DESKTOP_E2E_USER_DATA_DIR` | `onboarding-manager.ts` (`onboarded-workspaces.json`), `linked-repos-manager.ts` (`linked-repos.json`), `docs-manager.ts` (`cloud-docs/`) |
| `home/` | `$HOME` for the launched app | `packages/core/src/utils/telemetry-config.ts` (`~/.coredoc/telemetry.json`) |
| `auth.json` | a temp file passed as `COREDOC_DESKTOP_E2E_AUTH_FILE` | `auth-manager.ts` (`getStoredTokens`) — present only for profiles that must boot logged in |
| `server.json` | — | the fixture HTTP server's route table (`../fixture-server.ts`) |

`auth.json` is a plaintext `AuthTokens` object. The launch fixture overwrites two
of its fields on the way in — `serverUrl` (the stub server binds an ephemeral
port) and `expiresAt` (a checked-in timestamp would silently expire) — so the
values in the file are placeholders. A profile without `auth.json` boots logged
out, which is the normal `auth-manager` path.

## Source of truth per shape (drift risk — check these when a fixture stops matching reality)

- `workspace/coredoc.config.json` → `apps/desktop/src/shared/ipc-types.ts` (`CoredocConfigSerialized`, `ProjectConfigSerialized`, `RepoConfigSerialized`) and `packages/core/src/types/config.ts` (`CloudSyncState`); default shape in `apps/desktop/src/main/runtime-paths.ts` (`DEFAULT_CONFIG`).
- `workspace/coredoc-output/<projectId>/<repo>.json`, `-summaries.json` and `workspace/coredoc-parsers/<projectId>/<repo>/profile.ts` paths → `packages/core/src/utils/repo-ref.ts`.
- `home/.coredoc/telemetry.json` → `packages/core/src/utils/telemetry-config.ts` (`TelemetryConfig`).
- `server.json` bodies → `apps/desktop/src/main/server-api.ts` (`Workspace`, `WorkspaceMember`, `PendingInvite`, `WorkspaceRepo`).
- `auth.json` → `apps/desktop/src/main/auth-manager.ts` (`AuthTokens`, `TOKEN_FORMAT`).

Fixtures are hand-written JSON: the app's config writers are Electron-bound
(`app.getPath`, `safeStorage`), so they cannot be driven from a plain node seed
script. That is the drift risk the table above exists to contain.

## Profiles

- `empty` — no projects. The Workspaces screen renders its empty state.
- `local-project` — one project (`demo`) with one repo (`demo-api`) that has a
  profile artifact plus parsed and summarised output.
- `cloud-linked` — `local-project` plus `project.cloud`, a seeded session
  (`auth.json`, owner of `11111111-1111-4111-8111-111111111111`) and the cloud
  workspace, members and invites the fixture server serves. This is the profile
  for scenarios that need a logged-in user (S5 members, parts of S6/S7).

## Why the session is a file and not a seeded credentials store

`auth-manager.ts` persists credentials through `safeStorage`, which on macOS
encrypts against the login Keychain — a seeded plaintext `auth/credentials.json`
cannot decrypt, so the app would always boot logged out. `COREDOC_DESKTOP_E2E_AUTH_FILE`
is the explicit e2e-only seam that loads the session from `auth.json` instead
(`src/main/e2e-mode.ts` `resolveE2EAuthFile`). It is read only when
`COREDOC_DESKTOP_E2E=1`, which packaged builds reject; a set-but-broken file throws
rather than degrading into a logged-out run.
