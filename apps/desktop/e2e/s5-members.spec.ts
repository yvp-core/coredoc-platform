import { expect, test } from './fixtures/launch.js';
import { openDemoProject } from './fixtures/page-helpers.js';

/**
 * S5 — Team MCP "Members" tab: seeded members+invites render one row per
 * person, the owner's own row is static, and role-based gating restricts the
 * UI for a non-owner viewer.
 *
 * Row shape comes from `buildMemberRows` (`lib/member-rows.ts`): a row gets a
 * role `<Select>` and an "Actions for …" kebab only when `viewerCanManage`
 * (owner/admin) AND the row is not the viewer's own AND the row isn't a
 * pending placeholder (pending rows always show a static role — changing one
 * is a revoke-and-reinvite, not a role mutation). `cloud-linked` seeds an
 * owner viewer; `s5-member-viewer` is the same project and server data with a
 * `member`-role viewer instead (`profiles/s5-member-viewer/server.json` sets
 * `role: "member"` on the workspace), so the only variable between the two
 * tests is the viewer's role.
 */
async function openTeamMcpMembersTab(page: import('@playwright/test').Page) {
  // Both profiles here leave `graphReadyModalShown` unset, so the one-time
  // "Your Graph is ready!" modal opens on entry and would otherwise block the
  // Team MCP button behind its scrim.
  await openDemoProject(page);

  // Both profiles are cloud-linked, so the CTA is gone and the connect icon in the
  // top bar's icon cluster is what opens the drawer.
  await page.getByRole('button', { name: 'Team MCP server', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Team MCP Server' })).toBeVisible();
  // Members is the panel's default tab — wait for the seeded rows rather than
  // the tab trigger, since the tab is already selected on mount.
  await expect(page.getByText('People with access')).toBeVisible();
}

test.describe('S5 Team MCP members — owner viewer', () => {
  test.use({ profile: 'cloud-linked' });

  test('one row per seeded person; the owner row is static', async ({ page }) => {
    await openTeamMcpMembersTab(page);

    // owner@example.test is the viewer's own row (`isSelf`): no role Select, no
    // Actions kebab, regardless of the viewer being an owner.
    await expect(page.getByText('owner@example.test')).toBeVisible();
    await expect(page.getByLabel('Role for owner@example.test')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Actions for owner@example.test' })).toHaveCount(0);

    // member@example.test: a real, non-self member — the owner viewer can manage it.
    await expect(page.getByText('member@example.test')).toBeVisible();
    await expect(page.getByLabel('Role for member@example.test')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Actions for member@example.test' })).toBeVisible();

    // The pending invite renders as its own placeholder row (no display name
    // yet, so the email is the label) with a static role and a resend/revoke
    // kebab instead of a role Select.
    await expect(page.getByText('invited@example.test')).toBeVisible();
    await expect(page.getByText('Pending')).toBeVisible();
    await expect(page.getByLabel('Role for invited@example.test')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Actions for invited@example.test' })).toBeVisible();
  });
});

test.describe('S5 Team MCP members — member-role viewer', () => {
  // Identical to `cloud-linked` apart from the viewer's role — see
  // `profiles/s5-member-viewer/`.
  test.use({ profile: 's5-member-viewer' });

  test('a non-owner viewer sees every row as read-only', async ({ page }) => {
    await openTeamMcpMembersTab(page);

    await expect(page.getByText('owner@example.test')).toBeVisible();
    await expect(page.getByText('member@example.test')).toBeVisible();
    await expect(page.getByText('invited@example.test')).toBeVisible();

    // No row is manageable for a `member`-role viewer — not even their own
    // membership shows differently, since `viewerCanManage` gates every row.
    // Scoped to the three seeded people rather than a blanket `/^Actions for/`
    // match: the Chat left panel has its own per-session "Actions for …" kebab
    // that a workspace-wide regex would also (incorrectly) catch.
    await expect(page.getByLabel('Role for owner@example.test')).toHaveCount(0);
    await expect(page.getByLabel('Role for member@example.test')).toHaveCount(0);
    await expect(page.getByLabel('Role for invited@example.test')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Actions for owner@example.test' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Actions for member@example.test' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Actions for invited@example.test' })).toHaveCount(0);
  });
});
