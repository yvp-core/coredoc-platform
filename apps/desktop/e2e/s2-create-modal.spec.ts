import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixtures/launch.js';

/**
 * S2 create-modal — open/cancel behaviour, and the disabled→enabled gate that
 * blocks Create until a repo is attached. Runs against `s2-create-modal`
 * (see `fixtures/profiles/s2-create-modal/`): an otherwise-empty workspace
 * with no harness credentials, so the only thing gating Create is the repo
 * list this scenario cares about.
 */
test.describe('S2 create-modal', () => {
  test.use({ profile: 's2-create-modal' });

  test('open reveals the scrim and panel; Cancel closes it', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Create your first one' })).toBeVisible();
    await page.getByRole('button', { name: 'Create your first one' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Create new workspace' })).toBeVisible();
    await expect(dialog.getByText('Claude Subscription Token')).toHaveCount(0);
    await expect(page.locator('[data-slot="dialog-overlay"]')).toBeVisible();

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
  });

  test('Create stays disabled until a repo is added, then reaches the store', async ({ page, app, launchProfile }) => {
    await page.getByRole('button', { name: 'Create your first one' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    const workspaceName = 'New Workspace';
    await dialog.getByLabel('Workspace name').fill(workspaceName);

    const createButton = dialog.getByRole('button', { name: 'Create', exact: true });
    await expect(createButton).toBeDisabled();

    // Stub the native folder picker instead of driving a real OS dialog: patch
    // main's `dialog.showOpenDialog` for this run only.
    const repoPath = path.join(launchProfile.workspaceDir, 'repos', 'fixture-repo');
    await app.evaluate(({ dialog }, selectedPath) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [selectedPath],
      })) as typeof dialog.showOpenDialog;
    }, repoPath);

    await dialog.getByRole('button', { name: 'Add local repository' }).click();
    // Exact match: the repo's full path also contains "fixture-repo" as its
    // last segment, and the row renders both the name and the path.
    await expect(dialog.getByText('fixture-repo', { exact: true })).toBeVisible();

    await expect(createButton).toBeEnabled();

    await createButton.click();
    await expect(dialog).toBeHidden();

    // Submit path reaches the store: the app's own config writer persisted the
    // new project into the seeded workspace.
    const configPath = path.join(launchProfile.workspaceDir, 'coredoc.config.json');
    await expect
      .poll(() => (existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf-8')).projects.length : 0), {
        message: 'the new workspace never landed in coredoc.config.json',
      })
      .toBe(1);

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.projects[0].name).toBe(workspaceName);
    expect(config.projects[0].repos).toEqual([expect.objectContaining({ name: 'fixture-repo', path: repoPath })]);
  });
});
