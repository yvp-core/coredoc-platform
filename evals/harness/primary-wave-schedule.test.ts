import { describe, expect, it } from 'vitest';
import { planPrimaryWaveSchedule } from './primary-wave-schedule.js';

describe('registered primary wave schedule', () => {
  it('interleaves paired arms in deterministic AB/BA order', () => {
    expect(planPrimaryWaveSchedule(['withMcp', 'withoutMcp'], 3)).toEqual([
      { arm: 'withoutMcp', runIndex: 0 },
      { arm: 'withMcp', runIndex: 0 },
      { arm: 'withMcp', runIndex: 1 },
      { arm: 'withoutMcp', runIndex: 1 },
      { arm: 'withoutMcp', runIndex: 2 },
      { arm: 'withMcp', runIndex: 2 },
    ]);
  });

  it.each([
    [['withoutMcp']],
    [['withMcp']],
    [['withoutMcp', 'withoutMcp']],
    [['withMcp', 'withMcp']],
    [['withoutMcp', 'withMcp', 'mcpOnly']],
  ] as const)('rejects an invalid primary arm selection: %j', (arms) => {
    expect(() => planPrimaryWaveSchedule(arms, 3)).toThrow(/exactly one.*withoutMcp.*withMcp/i);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid primary runs: %s',
    (runs) => {
      expect(() => planPrimaryWaveSchedule(['withoutMcp', 'withMcp'], runs)).toThrow(
        /positive integer/i,
      );
    },
  );
});
