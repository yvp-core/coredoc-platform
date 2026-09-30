import type { Locator, Page } from '@playwright/test';
import { seedStaleRepo } from './fixtures/git-fixtures.js';
import { expect, test } from './fixtures/launch.js';
import { openDemoProject } from './fixtures/page-helpers.js';

/**
 * T7 screenshot baselines — one file per the spec's surface list (Behavior:
 * "Screenshot baselines").
 *
 * Determinism of the capture surface is pinned three ways:
 *  - Platform: darwin only (gate below). The committed PNGs are macOS pixels;
 *    `snapshotPathTemplate` already keys on `{platform}`, so another OS would
 *    silently start writing its own baselines instead of failing — the gate
 *    makes the restriction explicit. See `README.md` for the exact macOS
 *    version and display the committed PNGs were generated on.
 *  - Window size: every window is created at 1400x900 (`src/main/index.ts`'s
 *    `BrowserWindow`), but that is a default the app owns and could change
 *    without any signal here. `beforeEach` re-asserts it on the live window, so
 *    a geometry change fails as a stated precondition rather than as eleven
 *    unexplained pixel diffs. Playwright's `page.setViewportSize` does not
 *    apply to Electron (viewport emulation is unsupported there), so the size
 *    is set on the BrowserWindow itself.
 *
 * Threshold: `expect.toHaveScreenshot.maxDiffPixelRatio` is set to `0.01` in
 * `playwright.config.ts` (see the comment there for why). `animations:
 * 'disabled'` is also set globally there so Radix/CSS transitions (dialog
 * fade-in, tab underline, drawer width) never race the snapshot.
 *
 * Non-determinism handled per surface, not globally:
 *  - Graph tab: the graph canvas draws on a real HTML canvas with a
 *    force-directed layout; masked even though the baseline fixture's Graph
 *    tab starts empty (no seeded canvas search) — a future fixture change
 *    that seeds nodes should not silently need a new mask here.
 *  - Running drawer: the terminal column streams real (fast, but not
 *    instant) CLI output and its footer "Stop Update" button visibility is a
 *    genuine race with the underlying push finishing (documented in
 *    `s8-running.spec.ts`) — both are masked; only the drawer chrome
 *    (widths, borders, static header) is asserted pixel-for-pixel.
 *  - Stale/CI-CD banner: clipped to the fixed-height header strip shared by
 *    both fixtures, so the CI/CD case's *absence* of the amber banner is
 *    exactly what the pixel diff would catch.
 */

/** The capture surface every committed PNG in this file was generated at. */
const BASELINE_WINDOW = { width: 1400, height: 900 };

test.describe('T7 screenshot baselines', () => {
  test.skip(process.platform !== 'darwin', 'Screenshot baselines are committed for darwin only — see e2e/README.md.');

  // Pins the capture surface before every snapshot: `setContentSize` sizes the
  // web contents (what a screenshot captures) rather than the outer frame, so
  // the result is independent of the title-bar height.
  test.beforeEach(async ({ app }) => {
    const contentSize = await app.evaluate(async ({ BrowserWindow }, size) => {
      const [window] = BrowserWindow.getAllWindows();
      window.setContentSize(size.width, size.height);
      return window.getContentSize();
    }, BASELINE_WINDOW);

    expect(contentSize, 'the baseline capture surface is not 1400x900').toEqual([
      BASELINE_WINDOW.width,
      BASELINE_WINDOW.height,
    ]);
  });

  test.describe('workspaces list', () => {
    test.use({ profile: 'local-project' });

    test('workspaces list with the seeded project', async ({ page }) => {
      await expect(page.getByText('Demo', { exact: true })).toBeVisible();
      await expect(page).toHaveScreenshot('workspaces-list.png');
    });
  });

  test.describe('create-workspace modal', () => {
    // Empty projects list — same "Create your first one" entry point S2 uses.
    test.use({ profile: 's2-create-modal' });

    test('create-workspace modal open (scrim + panel)', async ({ page }) => {
      await page.getByRole('button', { name: 'Create your first one' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await expect(page.locator('[data-slot="dialog-overlay"]')).toBeVisible();

      await expect(page).toHaveScreenshot('create-workspace-modal.png');
    });
  });

  test.describe('completed view tabs', () => {
    test.use({ profile: 'local-project' });

    // Graph is the tab on entry now, so Chat has to be asked for.
    test('Chat tab', async ({ page }) => {
      await openDemoProject(page);
      await page.getByRole('tab', { name: 'Chat' }).click();
      await expect(page.getByPlaceholder(/^Ask anything about the project/)).toBeVisible();

      await expect(page).toHaveScreenshot('completed-view-chat.png');
    });

    test('Graph tab, graph canvas masked', async ({ page }) => {
      await openDemoProject(page);
      await page.getByRole('tab', { name: 'Graph' }).click();
      await expect(
        page.getByText('Search for a symbol, browse a type, or run a query to seed the graph.'),
      ).toBeVisible();

      // `.graph-canvas-bg` wraps the ExplorerCanvas mount point
      // (GraphTab.tsx) — masked unconditionally, not just when nodes are
      // visible, so this baseline stays valid if the fixture ever seeds a
      // pre-loaded graph.
      await expect(page).toHaveScreenshot('completed-view-graph.png', {
        mask: [page.locator('.graph-canvas-bg')],
      });
    });

    test('Analytics tab (cloud upsell, no cloud workspace on local-project)', async ({ page }) => {
      await openDemoProject(page);
      await page.getByRole('tab', { name: 'Analytics' }).click();
      await expect(page.getByRole('heading', { name: 'Insights live in the cloud' })).toBeVisible();

      await expect(page).toHaveScreenshot('completed-view-analytics.png');
    });
  });

  test.describe('workspace + local MCP drawers', () => {
    // cloud-linked, same as S4: reaches every docked-panel drawer without a
    // dedicated profile variant.
    test.use({ profile: 'cloud-linked' });

    test('workspace graph drawer (open)', async ({ page }) => {
      await openDemoProject(page);
      await page.getByRole('button', { name: 'Workspace graph' }).click();
      await expect(page.getByRole('heading', { name: 'Workspace Graph' })).toBeVisible();

      await expect(page).toHaveScreenshot('workspace-graph-drawer.png');
    });
  });

  // Not cloud-linked, on purpose: once a workspace IS cloud-linked the single
  // link-circle in the top bar belongs to Team MCP, so this is the only state in
  // which the local MCP drawer has an entry point.
  test.describe('local MCP drawer', () => {
    test.use({ profile: 'local-project' });

    test('local MCP drawer (open)', async ({ page }) => {
      await openDemoProject(page);
      await page.getByRole('button', { name: 'Local MCP server' }).click();
      await expect(page.getByRole('heading', { name: 'Local MCP Server' })).toBeVisible();

      await expect(page).toHaveScreenshot('local-mcp-drawer.png');
    });
  });

  test.describe('Members tab', () => {
    test.use({ profile: 'cloud-linked' });

    test('Team MCP Members tab, owner viewer', async ({ page }) => {
      await openDemoProject(page);
      // Cloud-linked, so the CTA is gone and the connect icon owns Team MCP.
      await page.getByRole('button', { name: 'Team MCP server', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Team MCP Server' })).toBeVisible();
      await expect(page.getByText('People with access')).toBeVisible();
      // Seeded rows render async off the fixture server — wait for all three
      // before the snapshot so the baseline isn't racing the fetch. Rows carry the
      // email alone now, so the display names are no longer a usable anchor.
      await expect(page.getByText('owner@example.test')).toBeVisible();
      await expect(page.getByText('member@example.test')).toBeVisible();
      await expect(page.getByText('invited@example.test')).toBeVisible();

      await expect(page).toHaveScreenshot('team-mcp-members-tab.png');
    });
  });

  test.describe('running-state drawer', () => {
    test.use({ profile: 's8-running' });

    /** Same locator s8-running.spec.ts uses: the one drawer container. */
    function drawer(page: Page): Locator {
      return page.locator('div.absolute.inset-y-0.right-0.z-20.flex.gap-0\\.5');
    }

    test('768px drawer with terminal column, terminal + footer masked', async ({ page }) => {
      // s8-running seeds `graphReadyModalShown: true` — no dismiss needed.
      await openDemoProject(page, { expectReadyModal: false });

      await page.getByRole('button', { name: 'Workspace graph' }).click();
      await page.getByRole('button', { name: 'Actions for demo-api' }).click();
      await page.getByRole('menuitem', { name: 'Push to graph' }).click();

      // One drawer, one close button — the terminal lives inside it rather than as a
      // second panel with its own chrome.
      await expect(page.getByRole('button', { name: 'Close panel' })).toHaveCount(1);
      await expect(drawer(page)).toHaveCSS('width', '768px');

      // Direct children of the drawer: [0] the static workspace-graph column
      // (chrome, left unmasked), [1] the terminal column (real, fast-moving
      // CLI output), [2] the absolutely-positioned footer action bar (its
      // "Stop Update" button is a genuine timing race with the underlying
      // push — see s8-running.spec.ts). Both [1] and [2] are masked.
      const terminalColumn = drawer(page).locator(':scope > div').nth(1);
      const footerBar = drawer(page).locator(':scope > div.absolute.inset-x-0.bottom-0');

      await expect(page).toHaveScreenshot('running-drawer-768.png', {
        mask: [terminalColumn, footerBar],
      });

      // Let the push finish before the fixture tears down the temp profile —
      // same reasoning as s8-running.spec.ts.
      const stopUpdate = page.getByRole('button', { name: 'Stop Update' });
      await expect.poll(() => stopUpdate.isVisible(), { message: 'push never finished' }).toBe(false);
    });
  });

  test.describe('stale + CI/CD banners', () => {
    // `seedStaleRepo` is shared with s6-banners.spec.ts — see
    // `fixtures/git-fixtures.ts` for why the staleness has to be seeded with a
    // real git repo and a real operations row.

    // Same clip window for both tests (top bar + banner strip, well above the
    // tab content below) so the CI/CD case's snapshot differs from the
    // non-CI-CD one by exactly the missing amber strip.
    const HEADER_CLIP = { x: 0, y: 0, width: 1400, height: 180 };

    test.describe('CI/CD-managed workspace — no banner', () => {
      test.use({ profile: 's6-cicd-synced' });

      test('header region shows no staleness banner', async ({ page, server, launchProfile }) => {
        await seedStaleRepo(launchProfile);
        await openDemoProject(page);

        await expect
          .poll(() => server.requests.filter((entry) => entry.path === '/api/v1/workspaces' && entry.matched).length)
          .toBeGreaterThan(0);
        await expect(page.getByText('Graph is out of date')).toHaveCount(0);

        await expect(page).toHaveScreenshot('header-banner-cicd-suppressed.png', { clip: HEADER_CLIP });
      });
    });

    test.describe('non-CI-CD workspace — amber banner', () => {
      test.use({ profile: 's6-stale' });

      test('header region shows the stale banner', async ({ page, launchProfile }) => {
        await seedStaleRepo(launchProfile);
        await openDemoProject(page);

        await expect(page.getByText('Graph is out of date')).toBeVisible();

        await expect(page).toHaveScreenshot('header-banner-stale.png', { clip: HEADER_CLIP });
      });
    });
  });

  // GAP (reported, not faked): node-detail drawer needs a seeded canvas node
  // selection, which is impossible to drive from Playwright without a
  // renderer-side test hook — same gap S3 already documents (`s3-tabs.spec.ts`,
  // "leaving Graph force-closes an open node-detail panel"). No baseline here
  // for the same reason.
  test.skip('node-detail drawer (GAP — see comment above)', async () => {
    // Intentionally empty: skipped, not faked.
  });
});
