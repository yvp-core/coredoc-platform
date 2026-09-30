import { existsSync } from 'node:fs';
import path from 'node:path';
import { builtRendererDir, expect, listUserDataEntries, test } from './fixtures/launch.js';

/**
 * Harness self-test. Everything the scenario specs assume is asserted here, so a
 * broken harness fails on its own file instead of showing up as nine confusing
 * scenario failures.
 */
test.describe('e2e harness canary', () => {
  test('boots the built app into a hermetic profile with the network boundary closed', async ({
    app,
    page,
    server,
    launchProfile,
  }) => {
    await expect(page.getByRole('heading', { name: 'Workspaces' })).toBeVisible();

    // The renderer under test is the built bundle, not a dev server.
    expect(page.url()).toContain(builtRendererDir);

    // The boundary is applied, not merely requested. `app.setPath('userData')`
    // has to run before the first module that reads it (`e2e-mode-boot.ts`);
    // asking the live app what it resolved is the only assertion that catches a
    // regression in that ordering — seeded files would still look right if the
    // app had fallen back to the developer's real profile for its own writes.
    const resolvedUserData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
    expect(resolvedUserData, 'the app did not apply COREDOC_DESKTOP_E2E_USER_DATA_DIR').toBe(launchProfile.userDataDir);

    // Egress: the shared `server` fixture asserts `unmatched()` is empty for
    // every test at teardown. What is canary-specific is the logged-out
    // contrast for the authenticated case below — no session seed, so the boot
    // path never reaches the cloud workspace API at all.
    expect(server.requests.map((entry) => entry.path)).not.toContain('/api/v1/workspaces');

    // Hermeticity: the app's own writes land in the temp profile.
    expect(listUserDataEntries(launchProfile).length).toBeGreaterThan(0);
    expect(existsSync(path.join(launchProfile.workspaceDir, 'coredoc.config.json'))).toBe(true);
  });

  test.describe('cloud-linked profile', () => {
    test.use({ profile: 'cloud-linked' });

    test('boots authenticated against the fixture cloud API', async ({ page, server }) => {
      await expect(page.getByRole('heading', { name: 'Workspaces' })).toBeVisible();

      // The seeded session is what makes the renderer take the logged-in branch;
      // logged out, projects-store returns before ever listing workspaces.
      await expect
        .poll(() => server.requests.filter((entry) => entry.path === '/api/v1/workspaces' && entry.matched).length, {
          message: 'the cloud-linked launch never listed workspaces — it booted logged out',
        })
        .toBeGreaterThan(0);
    });
  });
});
