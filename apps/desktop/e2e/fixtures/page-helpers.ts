import { expect, type Page } from '@playwright/test';

/**
 * Shared renderer-driving helpers.
 *
 * Every scenario that asserts anything inside a completed workspace has to get
 * there the same way, and each spec file used to carry its own copy — which
 * drifted (some dismissed the "Your Graph is ready!" modal conditionally, some
 * unconditionally, some not at all). One helper with an explicit expectation
 * removes the guesswork: whether the modal appears is a property of the seed
 * profile, so the caller states it instead of probing for it.
 */

export interface OpenDemoProjectOptions {
  /**
   * Whether the one-time "Your Graph is ready!" MCP-setup modal is expected on
   * entry (`ProjectDetailPage.tsx`, `graphReadyModalShown`).
   *
   * True for every profile whose `coredoc.config.json` leaves the flag unset —
   * the hermetic temp user-data dir has no "already shown" record, so it opens
   * every run and would sit over the surface under test. False for profiles
   * that seed `graphReadyModalShown: true` (`s7-team-btn-synced`, `s8-running`,
   * `s9-connect-wizard`).
   *
   * Asserted either way rather than probed: a conditional dismiss would hide a
   * regression that stops showing the modal at all.
   */
  expectReadyModal?: boolean;
}

/**
 * Opens the seeded "Demo" project from the Workspaces list and waits for the
 * completed-workspace toolbar to render.
 *
 * `ProjectCard` is a plain `onClick` div with no ARIA role of its own, so its
 * title text is the reachable target — the click bubbles to the card handler.
 */
export async function openDemoProject(page: Page, options: OpenDemoProjectOptions = {}): Promise<void> {
  const { expectReadyModal = true } = options;

  await expect(page.getByRole('heading', { name: 'Workspaces' })).toBeVisible();
  await page.getByText('Demo', { exact: true }).click();

  const finishSetup = page.getByRole('button', { name: 'Finish Setup' });
  if (expectReadyModal) {
    await expect(finishSetup, 'the ready modal was expected on entry but never opened').toBeVisible();
    await finishSetup.click();
  }
  await expect(finishSetup, 'the ready modal is still open over the surface under test').toHaveCount(0);

  await expect(page.getByRole('button', { name: 'Workspace graph' })).toBeVisible();
}
