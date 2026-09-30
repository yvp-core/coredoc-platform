import type { ElectronAPI } from '../src/shared/ipc-types.js';
import { expect, test } from './fixtures/launch.js';
import { openDemoProject } from './fixtures/page-helpers.js';

type CanonicalE2eApi = Pick<
  ElectronAPI,
  'getCanonicalTaskSummaries' | 'getCanonicalDeliveryTasks' | 'getCanonicalArtifactRevisions'
>;

const OWNER_WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const TASK_ID = 'cdt_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RUN_ID = 'cdr-20260816-a1b2c3';
const ARTIFACT_ID = 'cda_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const PRIVATE_EGRESS =
  /E2E_BEARER_SENTINEL|E2E_NONCE_SENTINEL|cloudAuthorization|bindingNonce|credential(?:Path)?|localPath|rawError/i;

test.describe('Analytics tab — owner Usage and Delivery views', () => {
  test.use({ profile: 'cloud-linked' });

  test('renders the Usage view and the Delivery view with a task trace', async ({ page, server }) => {
    const rendererConsole: string[] = [];
    const rendererRequests: string[] = [];
    page.on('console', (message) => rendererConsole.push(message.text()));
    page.on('request', (request) => rendererRequests.push(request.url()));

    const usagePath = `/api/v1/workspaces/${OWNER_WORKSPACE_ID}/analytics/usage?days=30`;
    const summaryPath = `/api/v1/workspaces/${OWNER_WORKSPACE_ID}/delivery/v2/summary?days=30&lifecycle=all`;
    const filteredSummariesPath = `/api/v1/workspaces/${OWNER_WORKSPACE_ID}/delivery/v2/task-summaries?limit=50&days=30&lifecycle=all`;
    const taskPath = `/api/v1/workspaces/${OWNER_WORKSPACE_ID}/delivery/v2/tasks/${TASK_ID}`;
    const legacyPath = `/api/v1/workspaces/${OWNER_WORKSPACE_ID}/delivery/v2/tasks`;
    const runsPath = `${taskPath}/runs?limit=50`;
    const stagesPath = `${taskPath}/runs/${RUN_ID}/stage-occurrences?limit=50`;
    const refsPath = `${taskPath}/external-refs?limit=50`;
    const refHistoryPath = `${taskPath}/external-refs/42/state-history?limit=50`;
    const codeChangesPath = `${taskPath}/code-changes?limit=50`;
    const shipEvidencePath = `${taskPath}/ship-evidence?limit=50`;
    const reworkPath = `${taskPath}/rework-signals?limit=50`;
    const artifactsPath = `${taskPath}/artifacts?limit=50`;
    const revisionsPath = `/api/v1/workspaces/${OWNER_WORKSPACE_ID}/delivery/v2/artifacts/${ARTIFACT_ID}/revisions`;

    await openDemoProject(page);
    await page.getByRole('tab', { name: 'Analytics' }).click();

    // ---- Usage is the default view (UC-1), served by ONE aggregate read. ----
    await expect(page.getByRole('tab', { name: 'Usage' })).toHaveAttribute('data-state', 'active');
    await expect(page.getByRole('group', { name: 'MCP calls' })).toContainText('42');
    await expect(page.getByRole('group', { name: 'Agent sessions' })).toContainText('6');
    // Every session in the window is unpriced: the marker, never $0.00 (BR-1, LIM-1).
    await expect(page.getByRole('group', { name: 'Assistant spend' })).not.toContainText('$0.00');
    await expect(page.getByRole('heading', { name: 'MCP tool usage' })).toBeVisible();
    await expect(page.getByTitle('explain', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Adoption' })).toBeVisible();
    // Adoption is server-observed MCP usage: 1 of 2 active developers called Coredoc (BR-3).
    await expect(page.getByText('Developers using Coredoc')).toBeVisible();
    await expect(page.getByText('Server-observed MCP calls · session medians from host telemetry')).toBeVisible();
    await expect(page.getByRole('group', { name: 'Active developers' })).toContainText('1 of 2 use Coredoc');
    // The session-based cost segmentation is gone; no host emits the telemetry it needed.
    await expect(page.getByRole('heading', { name: 'Cost per session' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Usage by member' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Session feedback' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Top issues' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Most-requested capabilities' })).toBeVisible();
    await expect(page.getByText('repository ownership lookup')).toBeVisible();

    let requests = server.requests.map(({ method, path }) => `${method} ${path}`);
    expect(requests).toContain(`GET ${usagePath}`);
    // Usage no longer fans out to the retired snapshot reads (ADR-1, ADR-6).
    expect(requests.some((request) => request.includes('/metrics/'))).toBe(false);
    expect(requests.some((request) => request.includes('/sessions/summary'))).toBe(false);
    expect(requests.some((request) => request.includes('/sessions/by-user'))).toBe(false);
    // Delivery is not read until its view is selected.
    expect(requests).not.toContain(`GET ${summaryPath}`);

    // ---- Delivery view (UC-3): one summary read plus one filtered task page. ----
    await page.getByRole('tab', { name: 'Delivery' }).click();
    await expect(page.getByText('Where the time goes')).toBeVisible();
    await expect(page.getByRole('group', { name: 'Median lead time' })).toBeVisible();
    await expect(page.getByText('Rework signals', { exact: true })).toBeVisible();
    await expect(page.getByText('Tasks', { exact: true })).toBeVisible();
    await expect(page.getByText('Tasks updated in the last 30 days · All tasks · UTC')).toBeVisible();
    await expect(page.getByText('Pick a task on the left to see its full trace.')).toBeVisible();

    requests = server.requests.map(({ method, path }) => `${method} ${path}`);
    expect(requests).toContain(`GET ${summaryPath}`);
    expect(requests).toContain(`GET ${filteredSummariesPath}`);
    // The trace collections are read only after a task is selected (LIM-8).
    expect(requests).not.toContain(`GET ${taskPath}`);
    expect(requests).not.toContain(`GET ${runsPath}`);

    // ---- Task selection composes the trace from the bounded per-collection reads (UC-4). ----
    await page.getByRole('button', { name: /Bounded task detail/ }).click();
    await expect(
      page.getByText(
        /Fine-event details received through .* are unavailable under the 90-day retention policy\. Durable delivery facts remain available\./,
      ),
    ).toBeVisible();
    await expect(page.getByRole('img', { name: /^Trace for / })).toBeVisible();
    await expect(page.getByText('Time by stage · this task')).toBeVisible();
    await expect(page.getByRole('list', { name: 'Task journey' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Claimed time by stage for this task' })).toContainText('spec');

    requests = server.requests.map(({ method, path }) => `${method} ${path}`);
    for (const collection of [
      taskPath,
      runsPath,
      refsPath,
      codeChangesPath,
      shipEvidencePath,
      reworkPath,
      artifactsPath,
    ]) {
      expect(requests).toContain(`GET ${collection}`);
    }
    // Nested pages follow their parent's first page (BR-12).
    expect(requests).toContain(`GET ${stagesPath}`);
    expect(requests).toContain(`GET ${refHistoryPath}`);
    // Checkpoint Markdown is demand-only: it is not read until the chip is expanded.
    expect(requests).not.toContain(`GET ${revisionsPath}`);

    // ---- Artifact drilldown: the chip toggle reads the revisions and renders them safely. ----
    await page.getByRole('button', { name: 'spec · 1 revision' }).click();
    await expect(page.getByRole('heading', { name: 'Checkpoint E2E' })).toBeVisible();
    await expect(page.getByText('Safe link', { exact: true })).toBeVisible();
    await expect(page.getByText('remote diagram', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Safe link' })).toHaveCount(0);
    await expect(page.locator('img[src*="images.example.test"]')).toHaveCount(0);
    expect(await page.evaluate(() => Reflect.get(globalThis, '__artifactPwned'))).toBeUndefined();
    requests = server.requests.map(({ method, path }) => `${method} ${path}`);
    expect(requests).toContain(`GET ${revisionsPath}`);

    // ---- Trust-boundary / privacy egress: no server-side secret reaches the renderer. ----
    const boundedSummaryResponse = await page.evaluate((workspaceId) => {
      const api = (window as unknown as { electronAPI: CanonicalE2eApi }).electronAPI;
      return api.getCanonicalTaskSummaries(workspaceId, 50);
    }, OWNER_WORKSPACE_ID);
    expect(PRIVATE_EGRESS.test(JSON.stringify(boundedSummaryResponse))).toBe(false);
    expect(boundedSummaryResponse.success).toBe(true);
    expect(boundedSummaryResponse.data?.tasks[0]?.authority).toEqual({
      kind: 'external_ref',
      externalRefId: '42',
      provider: 'jira',
      externalId: '10001',
      connected: true,
    });

    const boundedArtifactResponse = await page.evaluate(
      ([workspaceId, artifactId]) => {
        const api = (window as unknown as { electronAPI: CanonicalE2eApi }).electronAPI;
        return api.getCanonicalArtifactRevisions(workspaceId, artifactId);
      },
      [OWNER_WORKSPACE_ID, ARTIFACT_ID] as const,
    );
    expect(PRIVATE_EGRESS.test(JSON.stringify(boundedArtifactResponse))).toBe(false);

    const boundedTaskResponse = await page.evaluate((workspaceId) => {
      const api = (window as unknown as { electronAPI: CanonicalE2eApi }).electronAPI;
      return api.getCanonicalDeliveryTasks(workspaceId);
    }, OWNER_WORKSPACE_ID);
    expect(PRIVATE_EGRESS.test(JSON.stringify(boundedTaskResponse))).toBe(false);
    expect(boundedTaskResponse.success).toBe(true);
    const run = boundedTaskResponse.data?.tasks[0]?.workflowRuns[0];
    expect(run?.declaredStages).toEqual([
      { stageId: 'spec', after: [] },
      { stageId: 'tdd', after: ['spec'] },
    ]);
    expect(
      run?.stageOccurrences.map(({ stageId, attempt, startedAt, finishedAt, outcome }) => ({
        stageId,
        attempt,
        startedAt,
        finishedAt,
        outcome,
      })),
    ).toEqual([
      {
        stageId: 'tdd',
        attempt: 1,
        startedAt: '2026-08-16T10:03:00.000Z',
        finishedAt: '2026-08-16T10:06:00.000Z',
        outcome: 'success',
      },
      {
        stageId: 'spec',
        attempt: 1,
        startedAt: '2026-08-16T10:00:00.000Z',
        finishedAt: '2026-08-16T10:02:00.000Z',
        outcome: 'failed',
      },
      {
        stageId: 'spec',
        attempt: 2,
        startedAt: null,
        finishedAt: '2026-08-16T10:03:00.000Z',
        outcome: 'success',
      },
    ]);
    expect(rendererRequests.some((url) => url.startsWith('https://images.example.test/'))).toBe(false);
    expect(PRIVATE_EGRESS.test(rendererConsole.join('\n'))).toBe(false);
    expect(PRIVATE_EGRESS.test(await page.locator('body').innerText())).toBe(false);

    requests = server.requests.map(({ method, path }) => `${method} ${path}`);
    expect(requests).toContain(`GET ${legacyPath}`);
    expect(requests).toContain(`GET ${revisionsPath}`);
    expect(PRIVATE_EGRESS.test(JSON.stringify(server.requests))).toBe(false);
    expect(requests.filter((request) => request.includes('/delivery/') && !request.includes('/delivery/v2/'))).toEqual(
      [],
    );
    expect(requests.some((request) => request.includes('/mcp-feedback/correlation'))).toBe(false);

    await expect(page.getByText(/leaderboard|rework cause|stage cost/i)).toHaveCount(0);
    await expect(page.getByText('Enable Claude Code telemetry')).toHaveCount(0);
  });
});
