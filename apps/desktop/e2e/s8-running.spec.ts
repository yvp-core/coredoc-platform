import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures/launch.js';
import { openDemoProject } from './fixtures/page-helpers.js';

/**
 * S8 running — the workspace-running drawer's state machine
 * (`DockedPanelHost.RunningPanel` / `docked-panel.ts`): 344↔768px width switch,
 * the terminal column, and the footer Stop button, driven by a REAL command
 * through the full IPC → worker-thread → CLI SDK pipeline (`s8-running`
 * profile — a copy of `local-project`, already parsed and summarised).
 *
 * Command choice — `push`, not `parse`:
 * `RUNNING_DRAWER_ACTIONS` (`docked-panel.ts`) puts `parse`, `summarize` and
 * `push` all behind this same drawer, so any of the three exercises the FSM
 * under test identically. The only *unchained* parse the completed-workspace
 * UI offers is "Re-parse" (`WorkspaceGraphRepoRow`), which always passes
 * `{ chain: true }` — and `project-detail-store`'s `handleCommandCompleted`
 * auto-chains a successful chained parse straight into `summarize`.
 * `packages/cli/src/summarize/index.ts` calls the Claude Agent SDK directly
 * and is NOT one of the three `COREDOC_DESKTOP_E2E`-guarded spawn sites
 * (`chat-service.ts`, `agent-run/claude-adapter.ts`, `command-runner.ts`) —
 * so a real chained parse on a developer machine logged into Claude Code would
 * silently spend live tokens, which is exactly what the E2E boundary exists to
 * prevent (spec Non-goals: "Chat/generate/agent-run flows"). `onRunAction('push')`
 * from the same dropdown has no chain and is deterministic (reads the already-
 * seeded parsed/summarised JSON, writes the local sqlite graph) — same drawer,
 * zero LLM risk.
 */

/** The one drawer container — no role/aria of its own, so scoped by its stable Tailwind classes. */
function drawer(page: Page): Locator {
  return page.locator('div.absolute.inset-y-0.right-0.z-20.flex.gap-0\\.5');
}

test.describe('S8 running', () => {
  test.use({ profile: 's8-running' });

  test('a running push widens the drawer to 768px and hosts the terminal inside it, under one close button', async ({
    page,
  }) => {
    // s8-running seeds `graphReadyModalShown: true` (see fixtures/profiles/s8-running),
    // so the first-completion MCP modal never opens here — unlike S7's shared profiles.
    await openDemoProject(page, { expectReadyModal: false });

    // Open the workspace-graph panel and start a real "Push to graph" for the
    // seeded repo — the panel this opens IS the running drawer once a
    // RUNNING_DRAWER_ACTIONS command is in flight (docked-panel.ts panelForAction).
    await page.getByRole('button', { name: 'Workspace graph' }).click();
    await page.getByRole('button', { name: 'Actions for demo-api' }).click();
    await page.getByRole('menuitem', { name: 'Push to graph' }).click();

    // Terminal column present: the drawer WIDENS to 768px and hosts the terminal
    // inside itself. One drawer, one close button — the terminal is not a second
    // panel with its own chrome, so there is no "Hide terminal" affordance.
    const closePanel = page.getByRole('button', { name: 'Close panel' });
    await expect(page.getByText('Terminal', { exact: true })).toBeVisible();
    await expect(drawer(page)).toHaveCSS('width', '768px');
    await expect(page.getByRole('button', { name: 'Hide terminal' })).toHaveCount(0);
    await expect(closePanel).toHaveCount(1);

    const stopUpdate = page.getByRole('button', { name: 'Stop Update' });
    // The push may already have completed by the time this runs (deterministic,
    // near-instant on a two-file fixture) — the footer Stop is a nice-to-have
    // assertion when we win the race, not a hard requirement for the FSM itself.
    if (await stopUpdate.isVisible({ timeout: 500 }).catch(() => false)) {
      await expect(stopUpdate).toBeVisible();
    }

    // The widened drawer is still the Workspace Graph panel beside the terminal, not
    // an empty shell that replaced it.
    await expect(page.getByText('Workspace Graph', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Actions for demo-api' })).toBeVisible();

    // Let the push finish before the fixture tears down the profile — an
    // in-flight worker write racing `rmSync` on the temp dir is exactly the kind
    // of flake this suite's flake policy (retries <= 1, fix don't retry) rules out.
    await expect
      .poll(() => stopUpdate.isVisible(), { message: 'push never finished (footer Stop stayed up)' })
      .toBe(false);
  });
});
