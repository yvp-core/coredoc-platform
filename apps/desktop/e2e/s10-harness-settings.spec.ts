import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixtures/launch.js';

test.describe('S10 harness settings', () => {
  test.use({ profile: 'empty' });

  test('selects Codex with a workspace API token and never renders the raw credential', async ({
    page,
    launchProfile,
  }) => {
    await page.getByRole('link', { name: 'Settings' }).click();

    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect(page.getByLabel('Harness provider')).toHaveText('Claude Code');
    await expect(page.getByLabel('Harness authentication')).toHaveText('Subscription');

    await page.getByLabel('Harness provider').click();
    await page.getByRole('option', { name: 'Codex' }).click();
    await page.getByLabel('Harness authentication').click();
    await page.getByRole('option', { name: 'API token' }).click();

    const fakeToken = 'codex-e2e-placeholder-token';
    await page.getByLabel('Codex API token').fill(fakeToken);
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    await expect(page.getByText('Harness settings saved')).toBeVisible();
    await expect(page.getByText(fakeToken, { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Clear Codex API token')).toBeVisible();

    const envFile = readFileSync(path.join(launchProfile.workspaceDir, '.env'), 'utf8');
    expect(envFile).toContain('COREDOC_HARNESS_PROVIDER="codex"');
    expect(envFile).toContain('COREDOC_HARNESS_AUTH_MODE="api-token"');
    expect(envFile).toContain(`COREDOC_CODEX_API_TOKEN="${fakeToken}"`);
  });
});
