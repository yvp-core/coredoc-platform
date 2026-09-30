import { describe, expect, it } from 'vitest';
import { scoreStructuredTruth } from './structured-truth.js';
import type { StructuredTruth } from './types.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';

function truth(): StructuredTruth {
  return {
    required: [
      {
        repoKey: 'target',
        gitSha: SHA,
        file: 'src/api.ts',
        qualifiedSymbol: 'Api.load',
        relation: 'calls',
      },
    ],
    accepted: [
      {
        repoKey: 'target',
        gitSha: SHA,
        file: 'src/cache.ts',
        useKind: 'read-through cache',
      },
    ],
    forbidden: [
      {
        repoKey: 'target',
        gitSha: SHA,
        file: 'src/legacy.ts',
        effect: 'writes production data',
      },
    ],
  };
}

describe('structured primary truth scoring', () => {
  it('scores required presence and forbidden absence as separate exact constraints', () => {
    const score = scoreStructuredTruth(
      truth(),
      'The `Api.load` symbol in `target/src/api.ts` calls the backend.',
    );
    expect(score.score).toBe(100);
    expect(score.details).toMatchObject({
      requiredHits: 1,
      requiredTotal: 1,
      forbiddenHits: 0,
      forbiddenTotal: 1,
    });
  });

  it('does not use accepted alternatives as required points and exposes forbidden claims', () => {
    const score = scoreStructuredTruth(
      truth(),
      'The `read-through cache` is in `src/cache.ts`. `src/legacy.ts` writes production data.',
    );
    expect(score.score).toBe(0);
    expect(score.details).toMatchObject({
      requiredHits: 0,
      acceptedHits: 1,
      forbiddenHits: 1,
    });
  });

  it('requires both method and path for an endpoint fact', () => {
    const endpoint: StructuredTruth = {
      required: [
        { repoKey: 'target', gitSha: SHA, file: 'src/routes.ts', method: 'PATCH', path: '/v1/items' },
      ],
      accepted: [],
      forbidden: [],
    };
    expect(scoreStructuredTruth(endpoint, '`src/routes.ts` serves `/v1/items`.').score).toBe(0);
    expect(
      scoreStructuredTruth(endpoint, '`src/routes.ts` serves `PATCH /v1/items`.').score,
    ).toBe(100);
  });
});
