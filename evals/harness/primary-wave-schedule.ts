import type { Arm } from './types.js';

export interface PrimaryWaveUnit {
  arm: 'withoutMcp' | 'withMcp';
  runIndex: number;
}

export function planPrimaryWaveSchedule(
  arms: readonly Arm[],
  runs: number,
): PrimaryWaveUnit[] {
  if (!Number.isInteger(runs) || runs <= 0) {
    throw new Error('Registered primary execution requires runs to be a positive integer.');
  }
  if (
    arms.length !== 2 ||
    arms.filter((arm) => arm === 'withoutMcp').length !== 1 ||
    arms.filter((arm) => arm === 'withMcp').length !== 1
  ) {
    throw new Error(
      'Registered primary execution requires exactly one withoutMcp arm and one withMcp arm.',
    );
  }

  const schedule: PrimaryWaveUnit[] = [];
  for (let runIndex = 0; runIndex < runs; runIndex++) {
    const pair: PrimaryWaveUnit['arm'][] =
      runIndex % 2 === 0
        ? ['withoutMcp', 'withMcp']
        : ['withMcp', 'withoutMcp'];
    for (const arm of pair) schedule.push({ arm, runIndex });
  }
  return schedule;
}
