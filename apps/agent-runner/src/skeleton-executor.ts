import type { TurnAssignment } from '@coredoc/core/agent-runner';
import type { TurnExecutor, TurnIO, TurnResult } from './runner.js';

/**
 * Placeholder executor until the Claude Code executor lands (SF-001 ticket
 * 04): it reports that no agent ran and ends the turn without spend, which
 * proves the claim, heartbeat, events and completion path end to end.
 */
export class SkeletonExecutor implements TurnExecutor {
  async run(turn: TurnAssignment, io: TurnIO): Promise<TurnResult> {
    await io.emit([
      { type: 'phase', phase: turn.turn.kind },
      { type: 'raw', text: `[runner] no agent configured; ending ${turn.turn.kind} turn ${turn.turn.ordinal}` },
    ]);
    return { spend: null };
  }
}
