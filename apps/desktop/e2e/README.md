# Desktop e2e suite

macOS-only, local-only, run on demand (spec decision D4 — no CI job).

```bash
pnpm --filter @coredoc/desktop e2e        # build, then run
pnpm --filter @coredoc/desktop e2e:only   # run against the existing dist/ (local iteration)
pnpm e2e                                  # same, through turbo
```

## What a launch looks like

Each test gets its own Electron instance, launched from the **built** app
(`dist/main/index.js`), and its own throwaway state:

- a temp `userData` dir passed as `COREDOC_DESKTOP_E2E_USER_DATA_DIR`;
- a temp `$HOME` (keeps `~/.coredoc/telemetry.json` out of the run);
- a temp workspace dir passed as `COREDOC_DESKTOP_E2E_WORKSPACE_DIR`. Required by
  the boundary: without it the app derives its workspace root from the main
  bundle's own location (`runtime-paths.ts`, unpackaged branch) and would read
  the developer's monorepo `coredoc.config.json`;
- a loopback fixture HTTP server passed as `COREDOC_DESKTOP_E2E_SERVER_URL` (the
  boundary rejects anything that is not an `http://` 127.0.0.1/localhost origin);
  unstubbed routes answer 500 and are recorded (`server.unmatched()`);
- for profiles that must boot logged in, a plaintext session passed as
  `COREDOC_DESKTOP_E2E_AUTH_FILE` (the Keychain-bound credentials store cannot be
  seeded — see `fixtures/profiles/README.md`).

`COREDOC_DESKTOP_E2E` itself is strictly tri-state (`'1'`, `'0'`, unset); any
other value makes the app throw rather than fail open into a run against the
developer's real profile. See `src/main/e2e-mode.ts`.

`ELECTRON_RENDERER_URL` points at the built `index.html`: an unpackaged build
always takes the dev-server branch in `createWindow`, and the suite must exercise
the build output, not a Vite dev server.

The launch env is allowlist-built — no inherited API keys or OAuth tokens reach
the app, on top of the `COREDOC_DESKTOP_E2E` spawn guards in main.

## Packaged C# smoke

Use `COREDOC_TEST_PACKAGED_APP` to run `csharp-analysis.spec.ts` against a macOS
`.app` executable. This mode asserts `app.isPackaged`, loads the packaged renderer,
and uses the normal production bootstrap. It does not set `COREDOC_DESKTOP_E2E`
or enable development spawn/auth overrides. Only the credential-free C# fixture
is supported; HOME, Coredoc state, userData and the workspace are temporary.

After building the app with electron-builder, run:

```bash
COREDOC_TEST_PACKAGED_APP="/absolute/path/Coredoc.app/Contents/MacOS/Coredoc" \
COREDOC_TEST_DOTNET_DIR="/absolute/path/to/dotnet-sdk" \
COREDOC_TEST_SCIP_DOTNET="/absolute/path/to/scip-dotnet.dll" \
COREDOC_TEST_INSTALL_CSHARP=1 \
pnpm --filter @coredoc/desktop exec playwright test \
  --config=e2e/playwright.config.ts e2e/csharp-analysis.spec.ts \
  --grep 'installed compiler|explicit Install' --workers=1 --retries=0
```

The first scenario requires execution consent even with installed tools. The
second downloads the pinned release through the Install dialog, verifies progress
across reload, and parses with compiler facts and two conditional defines. Both
require enhanced mode without fallback and unchanged source files. The install
flag is an explicit network/download opt-in. Omit `--grep` to also run the basic,
cancel and incidental-csproj scenarios; the large reference-repo case needs its
separate environment variables.

An unsigned local `.app` proves packaging/runtime resolution; signed and notarized
installer validation is a separate release step. The production rejection of
`COREDOC_DESKTOP_E2E` remains enabled.

## Egress guard

The `server` fixture asserts `server.unmatched()` is empty at teardown, so
**every** test fails when the app reaches a route no seed profile stubs. New
egress must be declared in `fixtures/profiles/<name>/server.json`. A scenario
whose subject genuinely is a failing request can opt out with
`test.use({ allowUnmatchedRoutes: true })`; nothing currently does.

## Console guard

Every test fails on any renderer `console.error` or uncaught page error that is
not matched by `console-allowlist.ts`, which ships **empty**. Adding an entry
requires a reason naming the third-party source.

## Screenshot baselines

`baselines.spec.ts` is gated to darwin and pins the window to a 1400x900 content
size before each capture. The committed PNGs under `__screenshots__/darwin/` were
generated on:

- macOS 26.5.1 (build 25F80)
- Built-in Liquid Retina XDR Display, 3456 x 2234 native, Retina (2x) scaling

A different macOS version or display scale can move text antialiasing past the
1% `maxDiffPixelRatio`. Regenerate with `--update-snapshots` only after
confirming the diff is environmental and not a real visual regression.

## Writing a scenario

```ts
import { expect, test } from './fixtures/launch.js';
import { openDemoProject } from './fixtures/page-helpers.js';

test.use({ profile: 'local-project' }); // any dir name under fixtures/profiles/

test('…', async ({ page, server }) => {
  // `expectReadyModal: false` for profiles seeding `graphReadyModalShown: true`.
  await openDemoProject(page);
});
```

See `fixtures/profiles/README.md` for what each profile seeds and which files are
the source of truth for each shape.
