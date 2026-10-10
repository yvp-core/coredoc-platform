import { randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import { MAX_STATE_ARCHIVE_BYTES } from '@coredoc/core/agent-runner';
import { PrismaService } from '../../database/prisma.service.js';
import {
  CLOUD_AGENT_RUN_ARCHIVE_STORE,
  type CloudAgentRunArchiveStore,
  stateArchiveKey,
} from './cloud-agent-run-archive.store.js';
import { CloudAgentRunErrorCode, cloudAgentRunError, RunFailureCode } from './run-states.js';
import { CLOUD_AGENT_RUNS_CLOCK, type Clock, systemClock } from './run-store.js';
import { failRun, lockRun } from './run-transitions.js';
import { type FencedTurn, fenceLiveTurn, fenceTurn, type TurnLease } from './turn-lease.js';

/** A turn's state archive, moved between the runner and object storage under the live lease. */
@Injectable()
export class CloudAgentTurnArchiveService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CLOUD_AGENT_RUN_ARCHIVE_STORE) private readonly archives: CloudAgentRunArchiveStore,
    @Optional() @Inject(CLOUD_AGENT_RUNS_CLOCK) private readonly now: Clock = systemClock,
  ) {}

  /**
   * Stores the turn's state archive under a new key, create-only; the run
   * adopts it when the turn completes. An archive over the cap fails the run.
   */
  async upload(lease: TurnLease, body: Buffer): Promise<{ stored: true }> {
    if (body.length > MAX_STATE_ARCHIVE_BYTES) {
      await this.prisma.$transaction(async (tx) => {
        const { turn, standing } = await fenceTurn(tx, lease, this.now());
        const run = standing === 'live' ? await lockRun(tx, lease.runner.workspaceId, turn.run_id) : null;
        if (run) await failRun(tx, run, RunFailureCode.ArchiveTooLarge, null, this.now());
      });
      throw cloudAgentRunError(
        CloudAgentRunErrorCode.ArchiveTooLarge,
        `The state archive is larger than ${MAX_STATE_ARCHIVE_BYTES} bytes`,
        HttpStatus.PAYLOAD_TOO_LARGE,
      );
    }
    const turn = await this.liveTurn(lease);
    const key = stateArchiveKey(lease.runner.workspaceId, turn.run_id, turn.id, randomUUID());
    await this.archives.put(key, body);
    let replaced: string | null;
    try {
      replaced = await this.prisma.$transaction(async (tx) => {
        await fenceLiveTurn(tx, lease, this.now());
        const row = await tx.cloudAgentRunTurn.findUniqueOrThrow({
          where: { id: turn.id },
          select: { stateArchiveKey: true },
        });
        await tx.cloudAgentRunTurn.update({ where: { id: turn.id }, data: { stateArchiveKey: key } });
        return row.stateArchiveKey;
      });
    } catch (error) {
      await this.archives.delete(key).catch(() => undefined);
      throw error;
    }
    // An earlier upload of the same turn, which the run never adopted.
    if (replaced) await this.archives.delete(replaced).catch(() => undefined);
    return { stored: true };
  }

  /** The run's latest state archive, for the live lease only. */
  async download(lease: TurnLease): Promise<Buffer> {
    const turn = await this.liveTurn(lease);
    const run = await this.prisma.cloudAgentRun.findFirstOrThrow({
      where: { id: turn.run_id, workspaceId: lease.runner.workspaceId },
      select: { stateArchiveKey: true },
    });
    const archive = run.stateArchiveKey ? await this.archives.get(run.stateArchiveKey) : null;
    if (!archive) {
      throw cloudAgentRunError(
        CloudAgentRunErrorCode.ArchiveNotFound,
        'This run has no state archive',
        HttpStatus.NOT_FOUND,
      );
    }
    return archive;
  }

  private liveTurn(lease: TurnLease): Promise<FencedTurn> {
    return this.prisma.$transaction((tx) => fenceLiveTurn(tx, lease, this.now()));
  }
}
