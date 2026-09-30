import { seedStaleRepo } from './fixtures/git-fixtures.js';
import { expect, test } from './fixtures/launch.js';
import { openDemoProject } from './fixtures/page-helpers.js';

/**
 * S6 — staleness/CI-CD banners (`bannerVisibility`, `workspace-facts.ts`):
 * a confirmed CI/CD-managed workspace suppresses the amber "Graph is out of
 * date" strip outright (`ciCdEnabled !== false` short-circuits before the
 * per-signal checks — added by PR e1a15c3c); a non-CI-CD workspace with a
 * stale repo shows it, and dismissing it ("Remind Later") clears it for the
 * session.
 *
 * `seedStaleRepo` (`fixtures/git-fixtures.ts`) builds a real git repo plus a
 * real operations row against the fixture's already-copied `repos/demo-api`
 * before the app ever launches — see that module for why neither can be
 * hand-written JSON. `s6-cicd-synced` and `s6-stale` get the *same* seeded
 * staleness — the only variable between the two tests is the workspace's
 * `ciCdEnabled` flag, which is what proves the suppression rather than an
 * absence of anything to suppress.
 */

test.describe('S6 staleness banner — CI/CD-managed workspace', () => {
  test.use({ profile: 's6-cicd-synced' });

  test('a confirmed CI/CD workspace shows no staleness banner despite a stale repo', async ({
    page,
    server,
    launchProfile,
  }) => {
    await seedStaleRepo(launchProfile);
    await openDemoProject(page);

    // `ciCdEnabled` only settles once `GET /api/v1/workspaces` resolves
    // (`use-cloud-sync.ts`) — wait for that request rather than asserting
    // absence immediately, or a passing "not visible" could just mean the
    // banner (and the fetch that suppresses it) hasn't rendered yet.
    await expect
      .poll(() => server.requests.filter((entry) => entry.path === '/api/v1/workspaces' && entry.matched).length)
      .toBeGreaterThan(0);

    await expect(page.getByText('Graph is out of date')).toHaveCount(0);
    await expect(page.getByText('The cloud copy of this graph is behind.')).toHaveCount(0);
  });
});

test.describe('S6 staleness banner — non-CI-CD workspace', () => {
  test.use({ profile: 's6-stale' });

  test('a stale repo shows the amber banner, and dismissing it clears it for the session', async ({
    page,
    launchProfile,
  }) => {
    await seedStaleRepo(launchProfile);
    await openDemoProject(page);

    await expect(page.getByText('Graph is out of date')).toBeVisible();
    await expect(page.getByText('demo-api has 1 new commit since the last sync.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Update graph' })).toBeVisible();

    await page.getByRole('button', { name: 'Remind Later' }).click();
    await expect(page.getByText('Graph is out of date')).toHaveCount(0);

    // Stays dismissed within the session: switching tabs and back re-renders
    // the top of `CompletedView` without remounting it (`staleDismissed` is
    // component state, not tied to a tab), so the banner should not return.
    await page.getByRole('tab', { name: 'Graph' }).click();
    await page.getByRole('tab', { name: 'Chat' }).click();
    await expect(page.getByText('Graph is out of date')).toHaveCount(0);
  });
});
