import { fileURLToPath } from 'node:url';
import { expect, test as base } from './fixtures/launch.js';
import { loadRouteTable, startFixtureServer } from './fixtures/fixture-server.js';
import { openDemoProject } from './fixtures/page-helpers.js';

// Extend the route table in memory: other scenarios keep their original fixture.
const test = base.extend({
  server: async ({ profile }, use) => {
    const dir = fileURLToPath(new URL(`./fixtures/profiles/${profile}`, import.meta.url));
    const routes = await loadRouteTable(dir);
    const workspace = '/api/v1/workspaces/11111111-1111-4111-8111-111111111111';
    const list = routes['GET /api/v1/workspaces'] as Record<string, unknown>[];
    for (const item of list) item.ciCdEnabled = true;
    (routes[`GET ${workspace}`] as Record<string, unknown>).ciCdEnabled = true;
    routes[`GET ${workspace}/tokens`] = [];
    const repos = routes[`GET ${workspace}/repos`] as Record<string, unknown>[];
    repos[0].productionBranch = 'production';
    const server = await startFixtureServer(routes, dir);
    try {
      await use(server);
      expect(server.unmatched()).toEqual([]);
      expect(server.requests.filter((request) => request.auth === 'rejected')).toEqual([]);
      expect(server.requests.filter((request) => request.method !== 'GET')).toEqual([]);
    } finally {
      await server.close();
    }
  },
});

test.use({ profile: 'cloud-linked' });
test('switches CI provider, destination and generated YAML without creating a token', async ({ page }, testInfo) => {
  await openDemoProject(page);
  await page.getByRole('button', { name: 'Team MCP server', exact: true }).click();
  await page.getByRole('tab', { name: 'CI/CD', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'CI provider' })).toHaveText('GitHub Actions');
  await expect(page.getByText('Add this workflow to .github/workflows/coredoc.yml in each repository:')).toBeVisible();
  await expect(page.locator('pre').filter({ hasText: 'name: Coredoc' })).toContainText('install-tools');
  await page.getByRole('combobox', { name: 'CI provider' }).click();
  await page.getByRole('option', { name: 'GitLab CI', exact: true }).click();
  await expect(page.getByText('Merge these jobs into .gitlab-ci.yml in each repository:')).toBeVisible();
  const yaml = page.locator('pre').filter({ hasText: 'resource_group:' });
  await expect(yaml).toContainText('COREDOC_REPO_NAME: "demo-api"');
  await expect(yaml).toContainText('production');
  await expect(yaml).toContainText('coredoc-dependencies:');
  await expect(page.getByText(/set its environment scope to coredoc-publish/)).toBeVisible();
  await expect(yaml).toContainText('tools install python');
  await page.screenshot({ path: testInfo.outputPath('gitlab-ci-setup.png') });
});
