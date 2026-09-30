import { defineConfig } from '@playwright/test';

/**
 * Desktop e2e suite — macOS-only, local-only, run on demand (spec decision D4).
 *
 * Every test launches its own Electron instance against the BUILT app, so the
 * worker count stays modest: parallelism here costs one full app boot each.
 */
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  outputDir: 'test-results',
  fullyParallel: false,
  workers: 2,
  // Flake policy: one retry absorbs the genuinely environmental (an Electron
  // boot losing a race with the machine). A scenario that needs more than that
  // gets fixed or quarantined with an issue — never retried into green, so this
  // number does not go up.
  retries: 1,
  timeout: 90_000,
  expect: {
    timeout: 15_000,
    toHaveScreenshot: {
      // Radix dialog/drawer/tab transitions must not race the snapshot.
      animations: 'disabled',
      // Tight on purpose (T7 acceptance 4: "passes-while-broken" is an
      // over-generous ratio hiding a real regression). 0.01 (1% of pixels)
      // still tolerates macOS/Chromium's normal sub-pixel text/AA jitter
      // across repeat runs on the same machine, but a real token change
      // (background/border color swap) moves far more than 1% of the
      // baseline's pixels and fails — verified empirically during T7's
      // `globals.css` mutation check.
      maxDiffPixelRatio: 0.01,
    },
  },
  reporter: [['list']],
  // Baselines are generated on macOS only; a linux/windows run would write its
  // own dir instead of silently diffing against darwin pixels.
  snapshotPathTemplate: '{testDir}/__screenshots__/{platform}/{testFileName}/{arg}{ext}',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'electron' }],
});
