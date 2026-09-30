/**
 * Telemetry transport E2E — the P0.9 gate (spec finding #1/#2).
 *
 * Unit tests with fake channels prove the CLIENT logic but CANNOT catch the two
 * findings this task exists to fix: (1) the standalone CLI ships no PostHog key,
 * so every `parse_completed` is a silent no-op; (2) the desktop worker never
 * receives the key. Only an end-to-end proof — a real `coredoc parse` whose
 * emitted event actually arrives over the wire — closes them.
 *
 * This test spins a local `node:http` capture stub (ephemeral port, clean
 * shutdown — no real PostHog, no fixed port), opts telemetry IN via a temp
 * `$HOME/.coredoc/telemetry.json` (the product default stays OFF — we never
 * touch it), runs the BUILT CLI (`dist/index.js parse`) against a tiny hermetic
 * fixture repo, and asserts a `parse_completed` capture POST actually lands.
 *
 *  - Leg (a) STANDALONE, ENV-KEY path (surface 'cli') — proves the transport is
 *    wired end-to-end and is not a no-op, credentialed by a runtime
 *    COREDOC_POSTHOG_KEY (the local/dev override path).
 *  - Leg (b) DESKTOP-WORKER APPROXIMATION — the same built CLI spawned with the
 *    env a desktop-spawned worker inherits (COREDOC_SURFACE=desktop +
 *    COREDOC_SESSION_ID=<fixed>), asserting the event carries surface 'desktop'
 *    and that stitched session id. The faithful in-Electron `Worker` spawn is a
 *    documented MANUAL gate (it cannot be driven reliably offline); this
 *    env-approximation exercises the same core client code path the worker hits.
 *  - Leg (c) STANDALONE, BUNDLED-KEY path — the leg that actually reproduces
 *    finding #1 ("the standalone CLI ships no PostHog key"). It bakes a dummy
 *    key into the BUILT `dist/build-env.js` (the release-CI codegen output) and
 *    spawns parse with NO runtime COREDOC_POSTHOG_KEY — only the stub host. The
 *    AnonChannel must fall back to the bundled key that P0.9's
 *    `initTelemetry({ channels: { posthogKey: BUNDLED_POSTHOG_KEY } })` wiring
 *    feeds it. Revert that wiring and this leg goes RED while (a)/(b) stay green
 *    — so it protects the exact change this task exists to make, not merely
 *    "transport works when an env key is present".
 *
 * Every leg also asserts the brief's PRIVACY gate (finding #2 — "captured
 * payload must be path-scrubbed, no absolute paths in props"). The on-wire
 * payload is visible ONLY here, and the fixture runs under an absolute temp root
 * that would appear verbatim if any prop leaked a raw path or git remote.
 *
 * Gated behind COREDOC_E2E=1 so the default unit suite stays fast and does not
 * depend on a prior `pnpm --filter @coredoc/cli build`. Run it with:
 *   pnpm --filter @coredoc/core build && pnpm --filter @coredoc/cli build
 *   COREDOC_E2E=1 pnpm --filter @coredoc/cli exec vitest run src/telemetry-e2e.test.ts
 */

import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** A decoded PostHog capture event: the on-wire event name + its property bag. */
interface CapturedEvent {
  event: string;
  properties: Record<string, unknown>;
}

const CLI_DIST = fileURLToPath(new URL('../dist/index.js', import.meta.url));
// The compiled codegen output (`scripts/gen-build-env.mjs` → `src/build-env.ts` → tsc).
// Leg (c) rewrites this to bake a bundled key, proving the no-runtime-key path.
const CLI_BUILD_ENV_DIST = fileURLToPath(new URL('../dist/build-env.js', import.meta.url));
const DUMMY_KEY = 'phc_e2e_dummy_key';

/** A local PostHog batch-ingest stub: records POST bodies (gzip-decoded) on an ephemeral port. */
function startCaptureStub(): Promise<{ server: Server; port: number; events: () => CapturedEvent[] }> {
  const bodies: Buffer[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      bodies.push(Buffer.concat(chunks));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":1}');
    });
  });
  const events = (): CapturedEvent[] => {
    const out: CapturedEvent[] = [];
    for (const raw of bodies) {
      let text: string;
      try {
        // posthog-node gzip-compresses the /batch/ body by default.
        text = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
      } catch {
        continue;
      }
      try {
        const parsed = JSON.parse(text) as { batch?: CapturedEvent[]; event?: string; properties?: unknown };
        const batch = Array.isArray(parsed.batch)
          ? parsed.batch
          : parsed.event
            ? [{ event: parsed.event, properties: (parsed.properties as Record<string, unknown>) ?? {} }]
            : [];
        out.push(...batch);
      } catch {
        // Non-JSON body — ignore.
      }
    }
    return out;
  };
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, port, events });
    });
  });
}

/** Root of the hermetic fixture (temp HOME + fixture repo + parser + config), built once. */
let fixtureRoot: string;
let fixtureHome: string;

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'coredoc-p09-e2e-'));
  fixtureHome = join(fixtureRoot, 'home');
  const repo = join(fixtureRoot, 'repo');
  const parsers = join(fixtureRoot, 'parsers');
  const output = join(fixtureRoot, 'output');
  mkdirSync(join(fixtureHome, '.coredoc'), { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true });
  // The TS provider's SCIP preflight requires a node_modules dir on the target repo;
  // an empty one satisfies it (SCIP indexing then degrades non-fatally without a key).
  mkdirSync(join(repo, 'node_modules'), { recursive: true });
  mkdirSync(join(parsers, 'testproj', 'samplerepo'), { recursive: true });
  mkdirSync(output, { recursive: true });

  // Opt telemetry IN for THIS run only, under the temp HOME — the product default
  // (enabled:false) is never touched.
  writeFileSync(
    join(fixtureHome, '.coredoc', 'telemetry.json'),
    JSON.stringify({
      installId: '00000000-0000-4000-8000-000000000000',
      enabled: true,
      firstSeenAt: new Date().toISOString(),
    }),
  );

  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'samplerepo', version: '1.0.0', type: 'module' }));
  writeFileSync(
    join(repo, 'src', 'sample.ts'),
    "export function greet(name: string): string {\n  return format(name);\n}\nfunction format(n: string): string {\n  return 'hi ' + n;\n}\n",
  );
  // Type-only profile: a plain object export (no runtime import), so the transpiled
  // profile.js has zero dependencies to resolve.
  writeFileSync(
    join(parsers, 'testproj', 'samplerepo', 'profile.ts'),
    "const profile = {\n  parserId: 'e2e-sample-v1',\n  repoType: 'library',\n  substrate: { language: 'ts', include: ['src/**/*.ts'], exclude: ['**/node_modules/**', '**/*.d.ts'] },\n};\nexport default profile;\n",
  );
  writeFileSync(
    join(fixtureRoot, 'coredoc.config.json'),
    JSON.stringify({
      version: '2.0',
      projects: [{ id: 'testproj', name: 'testproj', repos: [{ name: 'samplerepo', path: repo, type: 'library' }] }],
      output: { dir: output, format: 'json' },
      parserStorage: parsers,
      agentMode: 'auto',
    }),
  );
});

afterAll(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
});

/**
 * Runs the built CLI `parse` against the fixture with a fresh capture stub and
 * the given extra env, then returns every event the stub decoded.
 *
 * The stub host is always injected (it's the ephemeral port, only known here).
 * The runtime anon KEY is NOT baked in here — legs supply it per-run via
 * `extraEnv` (legs a/b, the env-key path). When a leg omits it (leg c, the
 * bundled-key path) any inherited `COREDOC_POSTHOG_KEY` is stripped, so a stray
 * parent env cannot silently credential the child — the key baked into
 * `dist/build-env.js` MUST be the only thing that configures the wire.
 */
async function runParseAndCapture(extraEnv: Record<string, string>): Promise<CapturedEvent[]> {
  const { server, port, events } = await startCaptureStub();
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: fixtureHome,
      COREDOC_POSTHOG_HOST: `http://127.0.0.1:${port}`,
      ...extraEnv,
    };
    if (!('COREDOC_POSTHOG_KEY' in extraEnv)) {
      delete env.COREDOC_POSTHOG_KEY;
    }
    await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, [CLI_DIST, 'parse', '-c', 'coredoc.config.json'], {
        cwd: fixtureRoot,
        env,
        stdio: 'ignore',
      });
      child.on('error', reject);
      child.on('exit', (code) => resolve(code ?? 1));
    });
    // Small settle so any final in-flight capture request is fully recorded.
    await new Promise((r) => setTimeout(r, 100));
    return events();
  } finally {
    server.close();
  }
}

/**
 * Temporarily bakes a bundled anon key into the BUILT `dist/build-env.js` — the
 * artifact `scripts/gen-build-env.mjs` emits in release CI — runs `fn`, then
 * restores the original bytes. This exercises the bundled-key path offline
 * without a full rebuild and without touching the committed `src/build-env.ts`
 * (dist is a gitignored build output). Host stays empty so the env host (the
 * ephemeral stub) still wins; only the KEY comes from the bundle.
 */
async function withBakedBundledKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (!existsSync(CLI_BUILD_ENV_DIST)) {
    throw new Error(
      `Built build-env not found at ${CLI_BUILD_ENV_DIST}. Run \`pnpm --filter @coredoc/cli build\` before the E2E gate.`,
    );
  }
  const original = readFileSync(CLI_BUILD_ENV_DIST, 'utf8');
  writeFileSync(
    CLI_BUILD_ENV_DIST,
    `export const BUNDLED_POSTHOG_KEY = '${key}';\nexport const BUNDLED_POSTHOG_HOST = '';\n`,
  );
  try {
    return await fn();
  } finally {
    writeFileSync(CLI_BUILD_ENV_DIST, original);
  }
}

/**
 * Privacy gate (brief: "captured payload must be path-scrubbed — no absolute
 * paths in props"). The E2E is the only place the real on-wire payload is
 * visible, so it is the only place this can be proven end-to-end. The fixture
 * runs under an absolute temp root (`fixtureRoot`) that would appear verbatim if
 * any prop leaked a raw path. Checked across ALL captured events (not just
 * parse_completed) so a future path-bearing prop on ANY event trips the gate —
 * note `track()` does not scrub props centrally (only `trackError` does), so
 * this end-to-end assertion is what keeps a raw path off the wire.
 */
function assertNoAbsolutePathsOrRemotes(events: CapturedEvent[]): void {
  const blob = JSON.stringify(events);
  expect(blob, 'captured props leaked the fixture absolute path').not.toContain(fixtureRoot);
  expect(blob, 'captured props leaked an absolute filesystem path').not.toMatch(
    /(^|")\/(Users|home|private|tmp|var)\//,
  );
  expect(blob, 'captured props leaked a git remote').not.toMatch(/git@[^ ]+|https?:\/\/[^ "']*\.git/);
}

// Gated: heavy (spawns the built CLI + a real parse) and requires `dist/index.js`.
describe.runIf(process.env.COREDOC_E2E === '1')('telemetry transport E2E (P0.9)', () => {
  beforeAll(() => {
    if (!existsSync(CLI_DIST)) {
      throw new Error(
        `Built CLI not found at ${CLI_DIST}. Run \`pnpm --filter @coredoc/cli build\` before the E2E gate.`,
      );
    }
  });

  it('leg (a) standalone CLI, env-key path: a real parse emits a parse_completed POST to the wire (surface cli)', {
    timeout: 60_000,
  }, async () => {
    const events = await runParseAndCapture({ COREDOC_POSTHOG_KEY: DUMMY_KEY });
    const parseCompleted = events.find((e) => e.event === 'parse_completed');
    expect(
      parseCompleted,
      `no parse_completed in captured events: ${events.map((e) => e.event).join(', ')}`,
    ).toBeDefined();
    // The scorecard props prove it is a REAL parse result, not an empty ping.
    expect(parseCompleted?.properties.surface).toBe('cli');
    expect(parseCompleted?.properties.schema_version).toBe(1);
    expect(Number(parseCompleted?.properties.files)).toBeGreaterThan(0);
    expect(Number(parseCompleted?.properties.functions)).toBeGreaterThan(0);
    assertNoAbsolutePathsOrRemotes(events);
  });

  it('leg (b) desktop-worker env: parse_completed carries surface desktop + the stitched session id', {
    timeout: 60_000,
  }, async () => {
    const sessionId = 'desktop-session-fixed-e2e';
    const events = await runParseAndCapture({
      COREDOC_POSTHOG_KEY: DUMMY_KEY,
      COREDOC_SURFACE: 'desktop',
      COREDOC_SESSION_ID: sessionId,
    });
    const parseCompleted = events.find((e) => e.event === 'parse_completed');
    expect(
      parseCompleted,
      `no parse_completed in captured events: ${events.map((e) => e.event).join(', ')}`,
    ).toBeDefined();
    expect(parseCompleted?.properties.surface).toBe('desktop');
    expect(parseCompleted?.properties.session_id).toBe(sessionId);
    assertNoAbsolutePathsOrRemotes(events);
  });

  it('leg (c) standalone CLI, bundled-key path: the baked dist BUNDLED_POSTHOG_KEY credentials the wire with NO runtime key', {
    timeout: 60_000,
  }, async () => {
    // No COREDOC_POSTHOG_KEY in the child env: the AnonChannel key must resolve
    // solely from the bundled key baked into dist/build-env.js and threaded
    // through P0.9's initTelemetry({ channels: { posthogKey } }) wiring. Revert
    // that wiring and this leg goes red (legs a/b, on the env key, stay green).
    const events = await withBakedBundledKey(DUMMY_KEY, () => runParseAndCapture({}));
    const parseCompleted = events.find((e) => e.event === 'parse_completed');
    expect(
      parseCompleted,
      `no parse_completed via the BUNDLED key — is P0.9 init feeding channels.posthogKey? captured: ${events
        .map((e) => e.event)
        .join(', ')}`,
    ).toBeDefined();
    expect(parseCompleted?.properties.surface).toBe('cli');
    expect(parseCompleted?.properties.schema_version).toBe(1);
    expect(Number(parseCompleted?.properties.files)).toBeGreaterThan(0);
    assertNoAbsolutePathsOrRemotes(events);
  });
});
