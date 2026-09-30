import { test as base, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import electronExecutable from 'electron';
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAllowlisted } from '../console-allowlist.js';
import { type FixtureServer, loadRouteTable, startFixtureServer } from './fixture-server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, '..', '..');
const packagedExecutable = process.env.COREDOC_TEST_PACKAGED_APP;
const distDir = packagedExecutable
  ? path.resolve(path.dirname(packagedExecutable), '../Resources/app.asar/dist')
  : path.join(desktopRoot, 'dist');
const profilesDir = path.join(here, 'profiles');

/** The renderer bundle under test — specs assert the window is loaded from here. */
export const builtRendererDir = path.join(distDir, 'renderer');

/**
 * Name of a directory under `fixtures/profiles/`.
 *
 * Deliberately `string` and not a closed union: `seedProfile`/`loadRouteTable`
 * only join the name onto a path, so a union would buy no runtime safety while
 * forcing every scenario that adds a profile variant to either edit this shared
 * file or cast around it — which is exactly what six spec files ended up doing.
 * A typo fails loudly in `seedProfile`, which requires the directory to exist.
 */
export type ProfileName = string;

export interface LaunchProfile {
  /** Absolute temp dir the app writes its user data into. */
  userDataDir: string;
  /** Absolute temp dir standing in for `$HOME` (keeps `~/.coredoc` out of the run). */
  homeDir: string;
  /** Absolute temp dir the app resolves as its workspace root (`coredoc.config.json`). */
  workspaceDir: string;
  /** Absolute path of the seeded plaintext session, when the profile ships one. */
  authFile: string | null;
}

/**
 * Env names that must never reach the app: real credentials would let a broken
 * guard spend tokens. The launch env is allowlist-built (below), so these are
 * already absent — the explicit list keeps the intent reviewable and fails loud
 * if someone widens the allowlist later.
 */
const DENIED_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_OAUTH_TOKEN',
  'CODEX_API_KEY',
  'COREDOC_API_TOKEN',
  'COREDOC_CLAUDE_API_TOKEN',
  'COREDOC_CODEX_API_TOKEN',
  'COREDOC_POSTHOG_KEY',
  'COREDOC_SERVER_URL',
  'OPENAI_API_KEY',
];

/** Minimal env Electron/Chromium needs on macOS, plus the harness contract. */
const PASSTHROUGH_ENV = ['PATH', 'HOME', 'SHELL', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'DISPLAY'];

function seedProfile(profile: ProfileName, target: LaunchProfile): void {
  const sourceDir = path.join(profilesDir, profile);
  if (!existsSync(sourceDir)) {
    throw new Error(`No seed profile named "${profile}" (expected a directory at ${sourceDir})`);
  }
  const seeds: Array<[string, string]> = [
    ['workspace', target.workspaceDir],
    ['user-data', target.userDataDir],
    ['home', target.homeDir],
  ];

  for (const [name, dest] of seeds) {
    const src = path.join(sourceDir, name);
    if (!existsSync(src)) continue;
    cpSync(src, dest, { recursive: true });
  }
}

/**
 * Materialise the profile's session for `COREDOC_DESKTOP_E2E_AUTH_FILE`, or null when
 * the profile is meant to boot logged out.
 *
 * Two fields cannot live in the checked-in fixture: `serverUrl` (the fixture
 * server binds an ephemeral port) and `expiresAt` (a literal timestamp would
 * quietly expire and turn every cloud test logged-out). Everything else comes
 * from `auth.json` — see `profiles/README.md` for its source of truth.
 */
function seedAuthFile(profile: ProfileName, root: string, serverOrigin: string): string | null {
  const source = path.join(profilesDir, profile, 'auth.json');
  if (!existsSync(source)) return null;

  const tokens = JSON.parse(readFileSync(source, 'utf-8')) as Record<string, unknown>;
  const materialised = { ...tokens, serverUrl: serverOrigin, expiresAt: Date.now() + 60 * 60 * 1000 };
  const target = path.join(root, 'auth-seed.json');
  writeFileSync(target, JSON.stringify(materialised), 'utf-8');
  return target;
}

function assertBuiltAppExists(): string {
  if (packagedExecutable) {
    if (!path.isAbsolute(packagedExecutable) || !existsSync(packagedExecutable) || !existsSync(path.dirname(distDir)))
      throw new Error('COREDOC_TEST_PACKAGED_APP must identify an existing packaged macOS executable with app.asar.');
    return packagedExecutable;
  }
  const entry = path.join(distDir, 'main', 'index.js');
  const renderer = path.join(distDir, 'renderer', 'index.html');
  for (const file of [entry, renderer]) {
    if (!existsSync(file)) {
      throw new Error(
        `Built app not found at ${file}. The e2e suite runs against the build output, ` +
          `not the dev server — run \`pnpm --filter @coredoc/desktop build\` first (or use \`pnpm e2e\`).`,
      );
    }
  }
  return entry;
}

/**
 * The app window, never DevTools. `firstWindow()` resolves to whichever target
 * appeared first, and in an unpackaged build that is often the DevTools window.
 */
async function resolveRendererWindow(app: ElectronApplication, timeoutMs = 30_000): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  const isRenderer = (candidate: Page) => candidate.url().includes('/dist/renderer/');

  while (Date.now() < deadline) {
    const match = app.windows().find(isRenderer);
    if (match) return match;
    await app.waitForEvent('window', { timeout: Math.max(1, deadline - Date.now()) }).catch(() => undefined);
  }

  throw new Error(`No renderer window appeared within ${timeoutMs}ms (windows: ${app.windows().map((w) => w.url())})`);
}

interface Fixtures {
  profile: ProfileName;
  allowUnmatchedRoutes: boolean;
  launchProfile: LaunchProfile;
  server: FixtureServer;
  app: ElectronApplication;
  page: Page;
}

export const test = base.extend<Fixtures>({
  // Override per file/test with `test.use({ profile: 'local-project' })`.
  profile: ['empty', { option: true }],

  /**
   * Opt out of the egress guard below with `test.use({ allowUnmatchedRoutes: true })`.
   *
   * Only for a scenario whose *subject* is the app's behaviour on a failing
   * request (an error state, a retry). It is not a way to quiet a route a
   * fixture forgot to stub — add the route to `profiles/<name>/server.json`
   * instead. No spec currently needs this.
   */
  allowUnmatchedRoutes: [false, { option: true }],

  launchProfile: async ({ profile, server }, use, testInfo) => {
    const root = mkdtempSync(path.join(tmpdir(), 'coredoc-e2e-'));
    const launchProfile: LaunchProfile = {
      workspaceDir: path.join(root, 'workspace'),
      userDataDir: path.join(root, 'user-data'),
      homeDir: path.join(root, 'home'),
      authFile: null,
    };
    mkdirSync(launchProfile.workspaceDir, { recursive: true });
    mkdirSync(launchProfile.userDataDir, { recursive: true });
    mkdirSync(launchProfile.homeDir, { recursive: true });

    if (packagedExecutable && profile !== 'csharp-analysis')
      throw new Error('Packaged smoke supports only the credential-free C# analysis fixture.');
    seedProfile(profile, launchProfile);
    if (packagedExecutable) {
      writeFileSync(
        path.join(launchProfile.userDataDir, 'project-root.json'),
        JSON.stringify({ projectRoot: launchProfile.workspaceDir }),
      );
    }
    launchProfile.authFile = seedAuthFile(profile, root, server.origin);

    await use(launchProfile);

    // Failed runs keep the profile for inspection; Playwright already points at
    // a per-test output dir, so the path is discoverable from the report.
    if (testInfo.status === testInfo.expectedStatus) {
      rmSync(root, { recursive: true, force: true });
    } else {
      console.log(`[e2e] kept profile for failed test: ${root} (artifacts: ${testInfo.outputDir})`);
    }
  },

  server: async ({ profile, allowUnmatchedRoutes }, use) => {
    const profileDir = path.join(profilesDir, profile);
    const routes = await loadRouteTable(profileDir);
    const server = await startFixtureServer(routes, profileDir);

    await use(server);

    const unmatched = server.unmatched();
    await server.close();

    // Egress guard, same shape as the console guard below: every test — not
    // just the canary — fails when the app reaches a route no fixture stubs.
    // New egress is a product change that must be declared in a seed profile,
    // never something a green run can hide.
    if (!allowUnmatchedRoutes) {
      expect(
        unmatched.map((entry) => `${entry.method} ${entry.path}`),
        'app reached routes the fixture server does not stub (see e2e/fixtures/profiles/<name>/server.json)',
      ).toEqual([]);
    }
    expect(
      server.requests.filter(({ auth }) => auth === 'rejected').map(({ method, path }) => `${method} ${path}`),
      'app sent a missing or incorrect bearer to an authenticated fixture route',
    ).toEqual([]);
  },

  app: async ({ launchProfile, server }, use) => {
    const entry = assertBuiltAppExists();
    const rendererUrl = `file://${path.join(distDir, 'renderer', 'index.html')}`;

    const env: Record<string, string> = {};
    for (const name of PASSTHROUGH_ENV) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
    env.HOME = launchProfile.homeDir;
    // Unpackaged builds always take the dev-server branch in `createWindow`;
    // pointing ELECTRON_RENDERER_URL at the built bundle is what keeps this a
    // test of the build output rather than of a Vite dev server.
    if (!packagedExecutable) env.ELECTRON_RENDERER_URL = rendererUrl;
    env.COREDOC_TELEMETRY_DISABLED = '1';
    env.SHELL = '/bin/sh';
    env.COREDOC_HOME = path.join(launchProfile.homeDir, '.coredoc');
    if (packagedExecutable) {
      // Production mode retains the real bootstrap; no E2E auth or spawn bypass is enabled.
      env.COREDOC_SERVER_URL = server.origin;
    } else {
      env.COREDOC_DESKTOP_E2E = '1';
      env.COREDOC_DESKTOP_E2E_USER_DATA_DIR = launchProfile.userDataDir;
      env.COREDOC_DESKTOP_E2E_SERVER_URL = server.origin;
      // Workspace root override — without it the app derives its workspace from
      // the bundle's own location and would read the developer's monorepo. The
      // boundary requires it (`e2e-mode.ts`), so it is passed unconditionally.
      env.COREDOC_DESKTOP_E2E_WORKSPACE_DIR = launchProfile.workspaceDir;
      env.COREDOC_TELEMETRY_DISABLED = '1';
      // Absent for the logged-out profiles; auth-manager then takes its normal
      // (empty) credentials-store path.
      if (launchProfile.authFile) env.COREDOC_DESKTOP_E2E_AUTH_FILE = launchProfile.authFile;

      for (const name of DENIED_ENV) {
        if (name in env) throw new Error(`E2E launch env must not carry ${name}`);
      }
    }

    const electronApp = await electron.launch({
      executablePath: packagedExecutable ?? (electronExecutable as unknown as string),
      args: packagedExecutable ? [`--user-data-dir=${launchProfile.userDataDir}`] : [entry],
      cwd: packagedExecutable ? launchProfile.workspaceDir : desktopRoot,
      env,
    });
    try {
      if (packagedExecutable) {
        const paths = await electronApp.evaluate(({ app }) => ({
          packaged: app.isPackaged,
          userData: app.getPath('userData'),
        }));
        expect(paths.packaged).toBe(true);
        expect(realpathSync(paths.userData)).toBe(realpathSync(launchProfile.userDataDir));
      }
      // An unpackaged build opens DevTools unconditionally (`createWindow`), which
      // adds a second window and its own console noise (`Autofill.enable failed`).
      // Closing it keeps the guard scoped to the app's renderer.
      await electronApp.evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) {
          window.webContents.closeDevTools();
        }
      });

      await use(electronApp);
    } finally {
      await electronApp.close().catch(() => {
        /* app may already be gone after a failed assertion */
      });
    }
  },

  page: async ({ app }, use) => {
    const page = await resolveRendererWindow(app);
    const consoleErrors: string[] = [];

    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const text = message.text();
      if (isAllowlisted(text)) return;
      consoleErrors.push(text);
    });
    page.on('pageerror', (error) => {
      const text = `${error.name}: ${error.message}`;
      if (isAllowlisted(text)) return;
      consoleErrors.push(text);
    });

    // The window exists before the harness can subscribe, so a first-render
    // error could land outside the guard. Reloading with the listeners already
    // attached makes boot-time capture deterministic instead of a race.
    await page.reload({ waitUntil: 'domcontentloaded' });

    await use(page);

    expect(consoleErrors, `renderer console errors (see e2e/console-allowlist.ts)`).toEqual([]);
  },
});

export { expect };

/** Files the app wrote into the temp profile — the hermeticity signal. */
export function listUserDataEntries(launchProfile: LaunchProfile): string[] {
  return readdirSync(launchProfile.userDataDir);
}
