import { describe, expect, it } from 'vitest';
import { readOptionalTargetManifest } from '../harness/optional-target.js';
import { impactDiffCase, type ImpactDiffParams } from './impact-diff.js';
import type { AgentRunResult, Target } from '../harness/types.js';

const target = { name: 'demo-workspace' } as Target;

const DIFF = `--- a/src/modules/shifts/shifts.service.ts
+++ b/src/modules/shifts/shifts.service.ts
@@ -10,7 +10,7 @@ export class ShiftsService {
-  async listShifts(companyUuid: string): Promise<Shift[]> {
+  async listShifts(companyUuid: string): Promise<ShiftListPage> {`;

const params: ImpactDiffParams = {
  diff: DIFF,
  changeSummary: 'changes the return shape of `ShiftsService.listShifts`',
  expectedImpactedFiles: [
    'src/modules/shifts/shifts.service.ts',
    'src/modules/shifts/shifts.controller.ts',
    'ui/src/components/Shifts/api/services/shifts.service.ts',
  ],
  expectedImpactedSurfaces: ['GET /v3/shifts', 'Shift'],
};

function runWith(responseText: string): AgentRunResult {
  return {
    responseText,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    },
    latencyMs: 0,
    toolCalls: [],
    transcriptPath: '',
    error: null,
  };
}

describe('impactDiffCase.buildPrompt', () => {
  const prompt = impactDiffCase.buildPrompt(target, params);

  it('presents the diff verbatim in a fenced diff block', () => {
    expect(prompt).toContain('```diff');
    expect(prompt).toContain(DIFF);
  });

  it('states the repo and the change summary', () => {
    expect(prompt).toContain('demo-workspace');
    expect(prompt).toContain(params.changeSummary);
  });

  it('demands whole-workspace scope, surfaces, re-tests, citations, and no padding', () => {
    expect(prompt).toContain('ENTIRE workspace');
    expect(prompt).toMatch(/all repos, not only the repo the diff touches/);
    expect(prompt).toMatch(/HTTP endpoints, routes, entities/);
    expect(prompt).toMatch(/re-tested/);
    expect(prompt).toMatch(/backticks/);
    expect(prompt).toMatch(/do not pad/i);
  });
});

describe('impactDiffCase.verify', () => {
  it('full match on files and surfaces scores 100', async () => {
    const r = await impactDiffCase.verify(
      target,
      params,
      runWith(
        'Impacted: `src/modules/shifts/shifts.service.ts`, `src/modules/shifts/shifts.controller.ts`, `ui/src/components/Shifts/api/services/shifts.service.ts`. Surface: GET /v3/shifts returning the `Shift` entity.',
      ),
    );
    expect(r.details.file_recall).toBe(1);
    expect(r.details.file_precision).toBe(1);
    expect(r.details.surfaceCoverage).toBe(1);
    expect(r.score).toBe(100);
  });

  it('partial recall and partial surface coverage score in between', async () => {
    // 2 of 3 truth files cited (nothing extra) → precision 1, recall 2/3, F1 0.8.
    // 1 of 2 surfaces named → coverage 0.5. 0.8*70 + 0.5*30 = 71.
    const r = await impactDiffCase.verify(
      target,
      params,
      runWith(
        'Impacted: `src/modules/shifts/shifts.service.ts` and `src/modules/shifts/shifts.controller.ts`. The `Shift` entity shape changes.',
      ),
    );
    expect(r.details.file_recall).toBeCloseTo(2 / 3, 5);
    expect(r.details.file_precision).toBe(1);
    expect(r.details.surfaceCoverage).toBe(0.5);
    expect(r.score).toBe(71);
    expect(r.details.missed_truth_files).toEqual([
      'ui/src/components/Shifts/api/services/shifts.service.ts',
    ]);
    expect(r.details.missedSurfaces).toEqual(['GET /v3/shifts']);
  });

  it('padding is penalized through precision even at full recall', async () => {
    const padded = await impactDiffCase.verify(
      target,
      params,
      runWith(
        'Impacted: `src/modules/shifts/shifts.service.ts`, `src/modules/shifts/shifts.controller.ts`, `ui/src/components/Shifts/api/services/shifts.service.ts`. You might also want to check `src/modules/billing/billing.service.ts`, `src/modules/users/users.controller.ts`, `src/app.module.ts`. Surface: GET /v3/shifts returning the `Shift` entity.',
      ),
    );
    expect(padded.details.file_recall).toBe(1);
    expect(padded.details.file_precision).toBe(0.5);
    expect(padded.score).toBeLessThan(100);
    // The surface half is untouched by padding, so the loss is confined to the
    // file half: F1 = 0.667 → 0.667*70 + 30 = 77.
    expect(padded.score).toBe(77);
  });

  it('drops the surface half when the target supplies no surfaces', async () => {
    const noSurfaces: ImpactDiffParams = { ...params, expectedImpactedSurfaces: undefined };
    const r = await impactDiffCase.verify(
      target,
      noSurfaces,
      runWith(
        'Impacted: `src/modules/shifts/shifts.service.ts`, `src/modules/shifts/shifts.controller.ts`, `ui/src/components/Shifts/api/services/shifts.service.ts`.',
      ),
    );
    expect(r.details.surfaceCoverage).toBe(0);
    // Files carry 100% — a perfect file set is not capped at 70.
    expect(r.score).toBe(100);
  });

  it('an empty response scores zero', async () => {
    const r = await impactDiffCase.verify(target, params, runWith('No impact found.'));
    expect(r.score).toBe(0);
  });
});

describe('target manifests', () => {
  it.each([
    ['coredoc-parser.json', 'missing-curated-truth'],
  ])('%s keeps impact-diff quarantined without runnable truth', (file, reasonCode) => {
    const manifest = readOptionalTargetManifest(file);
    if (!manifest) return;
    const cell = manifest.cells['impact-diff'];

    expect(cell.lifecycle).toBe('quarantine');
    expect(cell).not.toHaveProperty('params');
    expect(cell).toMatchObject({ reasonCode });
    expect(JSON.stringify(cell)).not.toMatch(/\bTBD\b/i);
  });
});
