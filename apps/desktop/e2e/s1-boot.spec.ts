import { expect, test } from './fixtures/launch.js';

/**
 * S1 boot — the app launches straight to the Workspaces view, with the
 * surface reflecting whatever the seeded config actually holds (empty state
 * vs a seeded project). The console guard (`fixtures/launch.ts`) runs for
 * every test in this file; a boot-time console error fails the run.
 */
test.describe('S1 boot', () => {
  test('empty profile boots to the Workspaces empty state', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Workspaces' })).toBeVisible();

    await expect(page.getByRole('heading', { name: 'No Workspace yet' })).toBeVisible();
    await expect(page.getByText('Create your first one to get started.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create your first one' })).toBeVisible();

    // Nothing seeded — the "Add new Workspace" toolbar action only appears
    // once at least one project exists.
    await expect(page.getByRole('button', { name: 'Add new Workspace' })).toHaveCount(0);
  });

  test.describe('local-project profile', () => {
    test.use({ profile: 'local-project' });

    test('boots to the Workspaces view with the seeded project listed', async ({ page }) => {
      await expect(page.getByRole('heading', { name: 'Workspaces' })).toBeVisible();

      // The seeded "demo" project (see fixtures/profiles/local-project) renders
      // as a card instead of the empty state. ProjectCard has no heading role
      // (its title is a plain div), so this asserts on the visible text.
      await expect(page.getByText('Demo', { exact: true })).toBeVisible();
      await expect(page.getByText('demo-api')).toBeVisible();
      await expect(page.getByRole('heading', { name: 'No Workspace yet' })).toHaveCount(0);

      // A project already exists, so the toolbar action is now visible.
      await expect(page.getByRole('button', { name: 'Add new Workspace' })).toBeVisible();
    });
  });
});
