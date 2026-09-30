import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { ControlPlaneService } from '../../database/control-plane.service.js';
import { ResultStorageService } from '../push/result-storage.service.js';
import type { ConnectRepoInput } from './repos.contract.js';
import type { UpdateRepoInput } from './repos.contract.js';
import type { RepoStateResponse } from './dto/repo-state.dto.js';
import { bindRepoIntentIdentity, resolveIntentRepoKey } from './repo-intent-identity.js';

@Injectable()
export class ReposService {
  constructor(
    private readonly controlPlane: ControlPlaneService,
    private readonly resultStorage: ResultStorageService,
  ) {}

  async listRepos(workspaceId: string) {
    return this.controlPlane.listRepos(workspaceId);
  }

  /**
   * Connect one repo and register its durable intent identity ATOMICALLY.
   *
   * Both writes run inside the single locked transaction the control plane uses
   * for every other `workspace_repos` mutation. A separate identity write could
   * fail after the row was committed, leaving the repo connected but
   * permanently unbound — and the obvious retry answers "already connected",
   * so the caller had no remedy at all (spec §6.5 review finding).
   */
  async connectRepo(workspaceId: string, dto: ConnectRepoInput) {
    // Proved BEFORE the row exists: a durable key that does not reproduce the
    // graph key is a caller bug, and refusing it here avoids opening a
    // transaction the caller is about to have rolled back.
    resolveIntentRepoKey(dto, dto);

    try {
      return await this.controlPlane.withRepositoryLock(workspaceId, async (transaction) => {
        await this.controlPlane.createRepoIn(transaction, workspaceId, dto);
        // A fresh row is always unbound, so this binding cannot conflict; a
        // storage-constraint backstop that does fire aborts the whole
        // transaction, so nothing half-created survives.
        await bindRepoIntentIdentity(transaction, workspaceId, dto, dto);
        // Re-read inside the transaction so the response carries the identity
        // columns the binding just set, not the pre-binding snapshot.
        return await transaction.workspaceRepo.findUnique({
          where: { workspaceId_repoKey: { workspaceId, repoKey: dto.repoKey } },
        });
      });
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes('Unique constraint')) {
        throw new ConflictException(`Repo "${dto.repoKey}" is already connected to this workspace`);
      }
      throw error;
    }
  }

  async getRepoState(workspaceId: string, repoName: string): Promise<RepoStateResponse | null> {
    const repos = await this.controlPlane.listRepos(workspaceId);
    const repo = repos.find((r) => r.repoName === repoName || r.repoKey === repoName);
    if (!repo) return null;

    // Upload time is useful diagnostics, but delta sync must compare against
    // the versions that were actually published into the graph.
    let summaryUploadedAt: string | null = null;
    try {
      const manifest = await this.resultStorage.getManifest(workspaceId, repoName);
      summaryUploadedAt = manifest.summaryUploadedAt;
    } catch {
      // R2 may not be configured (local dev) or manifest may not exist yet
    }

    return {
      repoKey: repo.repoKey,
      repoName: repo.repoName,
      lastParseHash: repo.lastParseHash ?? null,
      lastPushedAt: repo.lastPushedAt?.toISOString() ?? null,
      lastPushedByUserId: repo.lastPushedByUserId ?? null,
      nodeCount: repo.nodeCount ?? null,
      edgeCount: repo.edgeCount ?? null,
      currentSummaryVersion: repo.lastSummaryVersion ?? null,
      currentEmbeddingsVersion: repo.lastEmbedVersion ?? null,
      summaryUploadedAt,
    };
  }

  /**
   * Partial update, identity included, in ONE locked transaction.
   *
   * This is also the documented remedy for a repo whose `intent_repo_key` is
   * still NULL (a legacy row, or a client that predates the field): a PATCH
   * carrying the durable key fills it in place, without a disconnect.
   */
  async updateRepo(workspaceId: string, repoKey: string, dto: UpdateRepoInput) {
    return this.controlPlane.withRepositoryLock(workspaceId, async (transaction) => {
      // Identity FIRST: it is the stricter gate, and a refused rebind must
      // leave the mutable connect-time fields untouched. Inside the same
      // transaction the ordering is belt-and-braces — either both writes land
      // or neither does.
      const existing = await transaction.workspaceRepo.findUnique({
        where: { workspaceId_repoKey: { workspaceId, repoKey } },
        select: { repoKey: true, repoName: true },
      });
      if (!existing) throw new NotFoundException(`Repo "${repoKey}" is not connected to this workspace`);
      await bindRepoIntentIdentity(transaction, workspaceId, existing, dto);
      return this.controlPlane.updateRepoIn(transaction, workspaceId, repoKey, dto);
    });
  }

  async disconnectRepo(workspaceId: string, repoId: string) {
    try {
      await this.controlPlane.removeRepo(workspaceId, repoId);
      return { disconnected: true };
    } catch {
      throw new NotFoundException('Repo not found');
    }
  }
}
