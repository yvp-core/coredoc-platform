import type { ElectronApplication, Page } from '@playwright/test';
import { expect, test } from './fixtures/launch.js';
import { openDemoProject } from './fixtures/page-helpers.js';

/**
 * S9 dialogs sweep — open and close every dialog reachable from the seeded
 * profiles (PR #66 manual matrix: `DialogContent` consumers), CANCEL-only —
 * never confirming a destructive or mutating action. The console guard
 * (`fixtures/launch.ts`) runs for every test here; the value of this file is
 * that guard staying clean across every open/close, exactly the forwardRef
 * class of regression the spec calls out.
 *
 * Reachable-but-excluded, on purpose:
 *  - `AddProjectDialog` ("Add new Workspace" / "Create your first one") is S2's
 *    (create-modal) — covering it here would duplicate ownership.
 *  - `UploadProgressDialog` / the later `ConnectTeamMcpWizard` steps (invite,
 *    mcp-config, ci-cd) require actually starting a cloud upload — out of
 *    reach without hitting the fixture server's unstubbed routes.
 *  - `TelemetryConsentCard` needs seeded telemetry-consent state no profile
 *    currently carries.
 *  - `InvitedUserOnboardingWizard` needs a cloud-invite fixture
 *    (member-side onboarding), not covered by any of `empty` /
 *    `local-project` / `cloud-linked`.
 */

/** Repo actions ("Actions for <repo>", "Edit repositories") live inside the
 * docked Workspace Graph panel, not the toolbar itself. */
async function openWorkspaceGraphPanel(page: Page): Promise<void> {
  await openDemoProject(page);
  await page.getByRole('button', { name: 'Workspace graph' }).click();
  await expect(page.getByText('Workspace Graph', { exact: true })).toBeVisible();
}

/**
 * "Edit repositories" opens the native folder picker (`dialog.showOpenDialog`)
 * before `AddRepositoryToProjectDialog` — there is no fixture stub for it yet
 * (S2's own "fixture folder picker stub" lives in that owner's file, not a
 * shared one). Patched here, scoped to this one test, exactly the
 * `electronApp.evaluate` escape hatch the task allows: a real native dialog
 * would otherwise hang the run waiting for a human.
 */
async function stubFolderPicker(app: ElectronApplication, paths: string[]): Promise<void> {
  await app.evaluate(({ dialog }, selectedPaths) => {
    dialog.showOpenDialog = (() =>
      Promise.resolve({
        canceled: selectedPaths.length === 0,
        filePaths: selectedPaths,
      })) as typeof dialog.showOpenDialog;
  }, paths);
}

test.describe('S9 dialogs sweep', () => {
  test.describe('Workspaces list (local-project profile)', () => {
    test.use({ profile: 'local-project' });

    test('Rename workspace dialog opens and Cancel closes it', async ({ page }) => {
      await page.getByRole('button', { name: 'Open menu' }).click();
      await page.getByRole('menuitem', { name: 'Rename' }).click();

      await expect(page.getByRole('dialog')).toBeVisible();
      await expect(page.getByText('Edit Name', { exact: true })).toBeVisible();

      await page.getByRole('button', { name: 'Cancel' }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      // Untouched — a confirmed rename would have replaced this text.
      await expect(page.getByText('Demo', { exact: true })).toBeVisible();
    });

    test('Delete workspace dialog opens and Cancel closes it', async ({ page }) => {
      await page.getByRole('button', { name: 'Open menu' }).click();
      await page.getByRole('menuitem', { name: 'Delete' }).click();

      await expect(page.getByRole('dialog')).toBeVisible();
      await expect(page.getByText('Delete Demo', { exact: true })).toBeVisible();

      await page.getByRole('button', { name: 'Cancel' }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      // Untouched — a confirmed delete would have emptied the Workspaces list.
      await expect(page.getByText('Demo', { exact: true })).toBeVisible();
    });
  });

  test.describe('Repo actions (local-project profile)', () => {
    test.use({ profile: 'local-project' });

    test('Regenerate parser dialog opens and Cancel closes it', async ({ page }) => {
      await openWorkspaceGraphPanel(page);
      await page.getByRole('button', { name: 'Actions for demo-api' }).click();
      await page.getByRole('menuitem', { name: 'Regenerate parser…' }).click();

      await expect(page.getByText('Regenerate Parser', { exact: true })).toBeVisible();
      const regenerate = page.getByRole('button', { name: 'Regenerate' });
      // Empty feedback keeps Submit disabled regardless — Cancel is still the
      // only way out, which is the point of this sweep.
      await expect(regenerate).toBeDisabled();

      await page.getByRole('button', { name: 'Cancel' }).click();
      await expect(page.getByText('Regenerate Parser', { exact: true })).toHaveCount(0);
    });

    test('Remove repository dialog opens and Cancel closes it, repo stays', async ({ page }) => {
      await openWorkspaceGraphPanel(page);
      await page.getByRole('button', { name: 'Actions for demo-api' }).click();
      await page.getByRole('menuitem', { name: 'Remove repository' }).click();

      await expect(page.getByText('Remove Repository', { exact: true })).toBeVisible();

      await page.getByRole('button', { name: 'Cancel' }).click();
      await expect(page.getByText('Remove Repository', { exact: true })).toHaveCount(0);
      // Untouched — a confirmed removal would have dropped the row.
      await expect(page.getByRole('button', { name: 'Actions for demo-api' })).toBeVisible();
    });

    test('Add repository dialog (via a stubbed native folder picker) opens and Cancel closes it', async ({
      page,
      app,
    }) => {
      await openWorkspaceGraphPanel(page);
      // A long absolute path on purpose: the row's Location cell is the one thing in
      // this dialog that can push past the 480px panel, and a short `/tmp/...` would
      // never catch it.
      await stubFolderPicker(app, ['/Users/e2e/projects/acme/acme-ios-client-application']);

      await page.getByRole('button', { name: 'Edit repositories' }).click();

      await expect(page.getByText('Add new repository', { exact: true })).toBeVisible();
      await expect(page.getByText('acme-ios-client-application', { exact: true })).toBeVisible();

      // The dialog must stay inside its panel — no child wider than the 480px surface.
      const dialog = page.getByRole('dialog');
      await expect(dialog).toHaveScreenshot('add-repository-dialog.png');

      await page.getByRole('button', { name: 'Cancel' }).click();
      await expect(page.getByText('Add new repository', { exact: true })).toHaveCount(0);
      // Untouched — a confirmed add would have grown the repo list.
      await expect(page.getByRole('button', { name: 'Actions for demo-api' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Actions for e2e-not-a-real-repo' })).toHaveCount(0);
    });
  });

  test.describe('Chat session dialogs (local-project profile)', () => {
    test.use({ profile: 'local-project' });

    test('Rename and Delete chat-session dialogs open and Cancel closes each', async ({ page }) => {
      await openDemoProject(page);
      await page.getByRole('tab', { name: 'Chat' }).click();

      // ProjectDetailPage auto-creates a session when none exist yet — the
      // left rail's session row is the anchor for both dialogs below.
      const sessionActions = page.getByRole('button', { name: /^Actions for / });
      await expect(sessionActions.first()).toBeVisible();

      await sessionActions.first().click();
      await page.getByRole('menuitem', { name: 'Rename' }).click();
      await expect(page.getByText('Rename Chat', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Cancel' }).click();
      await expect(page.getByText('Rename Chat', { exact: true })).toHaveCount(0);

      await sessionActions.first().click();
      await page.getByRole('menuitem', { name: 'Delete' }).click();
      await expect(page.getByText('Delete Chat', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Cancel' }).click();
      await expect(page.getByText('Delete Chat', { exact: true })).toHaveCount(0);
      // Untouched — a confirmed delete would have emptied the session list.
      await expect(sessionActions.first()).toBeVisible();
    });
  });

  test.describe('Connect Team MCP wizard (s9-connect-wizard profile)', () => {
    // Not the S7 fixture: `handleTeamMcpClick` (CompletedView) branches on
    // `isLoggedIn` *before* `teamMcpAvailable` — logged-out clicks `login()`
    // instead of opening the wizard, which reached this fixture's stub server
    // on an unstubbed route the first time this was written. This profile
    // pairs S7's "anySynced, not cloud-linked" seed with a logged-in session
    // (`auth.json`) and stubs `GET /api/v1/workspaces` → `[]` (the boot-time
    // fetch every authenticated launch makes — see `AppLayout.tsx`), so the
    // click reaches the wizard's own "info" step.
    test.use({ profile: 's9-connect-wizard' });

    test('Connect Team MCP wizard opens on its info step and Cancel closes it without starting an upload', async ({
      page,
    }) => {
      // This variant seeds `graphReadyModalShown: true`.
      await openDemoProject(page, { expectReadyModal: false });

      await page.getByRole('button', { name: 'Connect Team MCP' }).click();
      await expect(page.getByText('Upload graph to cloud', { exact: true })).toBeVisible();

      await page.getByRole('button', { name: 'Cancel' }).click();
      await expect(page.getByText('Upload graph to cloud', { exact: true })).toHaveCount(0);
      // Untouched — a started upload would have opened the blocking
      // "Uploading your graph to cloud" progress dialog instead.
      await expect(page.getByText('Uploading your graph to cloud', { exact: true })).toHaveCount(0);
    });
  });
});
