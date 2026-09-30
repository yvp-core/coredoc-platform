import { describe, expect, it } from 'vitest';
import type { Target } from '../harness/types.js';
import { blastRadiusCase, type BlastRadiusParams } from './blast-radius.js';

const target = { name: 'acme-calculations' } as Target;
const multiRepoParams: BlastRadiusParams = {
  change: 'Rename `BookingTypes` to `BookingKinds`.',
  expectedTouchedFiles: [
    'acme-calculations/src/types/source-data.ts',
    'acme-packages/packages/acme-api-client/src/lib/booking/dto/enums.ts',
  ],
};

describe('blastRadiusCase.buildPrompt', () => {
  it('requires repo-qualified citations for every file when multiple repos are involved', () => {
    const prompt = blastRadiusCase.buildPrompt(target, multiRepoParams);

    expect(prompt).toContain('When more than one repository is involved');
    expect(prompt).toContain('`repo-name/repo-relative/path`');
    expect(prompt).toMatch(/every backticked file citation/i);
    expect(prompt).toMatch(/including files in the target repository/i);
  });
});

describe('blastRadiusCase.verify', () => {
  const verifyResponse = (responseText: string) =>
    blastRadiusCase.verify(target, multiRepoParams, {
      responseText,
    } as Parameters<typeof blastRadiusCase.verify>[2]);

  it('credits citations that carry an extra leading workspace segment', async () => {
    // Observed 2026-08-24: the agent prefixed every path with the workspace
    // directory (`acme/`), and exact-equality matching scored a 76-file
    // answer 0 while the oracle scored it 100.
    const result = await verifyResponse(
      'Must touch `acme/acme-calculations/src/types/source-data.ts` and ' +
        '`acme/acme-packages/packages/acme-api-client/src/lib/booking/dto/enums.ts`.',
    );

    expect(result.details.recall).toBe(1);
    expect(result.score).toBe(100);
  });

  it('does not credit a same-basename file from a different directory', async () => {
    const result = await verifyResponse(
      'Must touch `acme-calculations/src/other/source-data.ts`.',
    );

    expect(result.details.recall).toBe(0);
    expect(result.score).toBe(0);
  });
});
