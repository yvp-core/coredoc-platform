import { expect, test } from './fixtures/launch.js';
import { openDemoProject } from './fixtures/page-helpers.js';

/**
 * S4 — workspace / local-MCP / team-MCP drawers.
 *
 * `cloud-linked` is used unmodified: the owner fixture is logged in and
 * `project.cloud.enabled` is true, which is what makes `handleTeamMcpClick`
 * (`CompletedView.tsx`) set `{ kind: 'team-mcp' }` directly instead of
 * detouring through a login prompt or the first-time wizard — no new profile
 * variant is needed to reach all three drawers.
 *
 * Mutual exclusivity: `docked-panel.ts`'s header comment states the whole
 * policy — "The docked right panel is one slot with mutually exclusive
 * modes." The three drawers under test (`workspace-graph`, `local-mcp`,
 * `team-mcp`) share `PANEL_PRIORITY` rank 2 (a three-way tie), and the top-bar
 * buttons that open them call `togglePanel`/`setPanel` directly rather than
 * going through the `auto` vs `user` priority ladder in `nextPanel` — so for
 * these three, exclusivity comes from the single `useState<DockedPanel>` slot
 * itself: opening one is a plain replace of whatever else was docked. The
 * ladder in `nextPanel`/`PANEL_PRIORITY` governs `auto`-sourced requests
 * (e.g. a running command reclaiming the slot), which is out of scope here.
 */
test.describe('S4 docked drawers', () => {
  test.use({ profile: 'cloud-linked' });

  // Local MCP is deliberately absent from this profile's top bar: once a workspace is
  // cloud-linked the single link-circle belongs to Team MCP, so the mutual-exclusion
  // ladder here is workspace-graph ↔ team-MCP. The local MCP drawer keeps its coverage
  // under the `local-project` profile in `baselines.spec.ts`.
  test('workspace graph and team MCP drawers open, close, and are mutually exclusive', async ({ page }) => {
    // `cloud-linked` leaves `graphReadyModalShown` unset, so the one-time
    // "Your Graph is ready!" modal opens on entry and would otherwise block
    // every click below behind its scrim.
    await openDemoProject(page);

    const workspaceGraphButton = page.getByRole('button', { name: 'Workspace graph' });
    const teamMcpButton = page.getByRole('button', { name: 'Team MCP server', exact: true });
    const closePanelButton = page.getByRole('button', { name: 'Close panel' });

    const workspaceGraphHeading = page.getByRole('heading', { name: 'Workspace Graph' });
    const teamMcpHeading = page.getByRole('heading', { name: 'Team MCP Server' });

    await expect(workspaceGraphButton).toBeVisible();
    // The connected workspace has no local MCP entry point and no CTA.
    await expect(page.getByRole('button', { name: 'Local MCP server' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Connect Team MCP' })).toHaveCount(0);

    // Open workspace graph.
    await workspaceGraphButton.click();
    await expect(workspaceGraphHeading).toBeVisible();

    // Opening team MCP replaces it — the single docked slot, not a stack.
    await teamMcpButton.click();
    await expect(teamMcpHeading).toBeVisible();
    await expect(workspaceGraphHeading).not.toBeVisible();

    // Re-opening workspace graph replaces team MCP.
    await workspaceGraphButton.click();
    await expect(workspaceGraphHeading).toBeVisible();
    await expect(teamMcpHeading).not.toBeVisible();

    // The panel's own close control empties the slot.
    await closePanelButton.click();
    await expect(workspaceGraphHeading).not.toBeVisible();
    await expect(closePanelButton).not.toBeVisible();

    // Toggle semantics: clicking the same button that opened a panel closes it
    // (`togglePanel` — same `kind` as current closes rather than replaces).
    await workspaceGraphButton.click();
    await expect(workspaceGraphHeading).toBeVisible();
    await workspaceGraphButton.click();
    await expect(workspaceGraphHeading).not.toBeVisible();
  });
});
