import { openDemoProject } from './fixtures/page-helpers.js';
import { expect, test } from './fixtures/launch.js';

/**
 * S7 team-btn — the Team MCP toolbar button (`CompletedTopBar`) is gated by
 * `teamMcpAvailable = anySynced || cloudEnabled || isCloudMember`
 * (fix 27b9c604). This sweeps both sides of that condition:
 *
 *  - hidden on the fresh `empty` profile (no project to even show the button on)
 *  - hidden on `local-project`, which is parsed/summarised but never pushed
 *    (`anySynced` false, not cloud-linked)
 *  - visible on `s7-team-btn-synced` (identical fixture plus a seeded
 *    `coredoc.db.d/demo.db` with one completed `push` operation — the
 *    `anySynced` side of the OR) reading "Connect Team MCP" (not yet connected)
 *  - visible on `cloud-linked` (the `cloudEnabled` side of the OR), reading
 *    "Team MCP" (already connected)
 */
test.describe('S7 team-btn', () => {
  const teamMcpButton = (page: import('@playwright/test').Page) => page.getByRole('button', { name: /Team MCP/ });

  test('empty profile: no project exists, so the button is nowhere on screen', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Workspaces' })).toBeVisible();
    await expect(teamMcpButton(page)).toHaveCount(0);
  });

  test.describe('local-project profile (parsed, never pushed)', () => {
    test.use({ profile: 'local-project' });

    test('Team MCP button is hidden — no repo has been synced and the workspace is not cloud-linked', async ({
      page,
    }) => {
      await openDemoProject(page);

      await expect(teamMcpButton(page)).toHaveCount(0);
    });
  });

  test.describe('s7-team-btn-synced profile (one repo pushed, not cloud-linked)', () => {
    test.use({ profile: 's7-team-btn-synced' });

    test('Team MCP button is visible once any repo is synced', async ({ page }) => {
      // This variant seeds `graphReadyModalShown: true`, unlike the two shared
      // profiles above.
      await openDemoProject(page, { expectReadyModal: false });

      // Not yet connected to a cloud workspace, so the CTA copy still invites
      // connecting rather than confirming an existing link.
      await expect(page.getByRole('button', { name: 'Connect Team MCP' })).toBeVisible();
    });
  });

  test.describe('cloud-linked profile', () => {
    test.use({ profile: 'cloud-linked' });

    test('the CTA yields to the connect icon once the workspace is cloud-linked', async ({ page }) => {
      await openDemoProject(page);

      // The CTA is an invitation to connect, so it has nothing left to say once the
      // workspace IS connected — for an owner and an invited member alike. The
      // link-circle in the icon cluster owns Team MCP from that point on.
      await expect(page.getByRole('button', { name: 'Team MCP', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Connect Team MCP', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Team MCP server', exact: true })).toBeVisible();
    });
  });
});
