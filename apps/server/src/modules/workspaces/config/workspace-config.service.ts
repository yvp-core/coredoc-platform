/**
 * Config Service
 *
 * Builds workspace configuration for desktop app onboarding.
 * Returns repo list and workspace info so the desktop can pull config.
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import { ControlPlaneService } from '../../../database/control-plane.service.js';

// =============================================================================
// Types
// =============================================================================

export interface WorkspaceConfigWorkspace {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  isCloud: boolean;
  ciCdEnabled: boolean;
}

export interface WorkspaceConfigRepo {
  id: string;
  repoKey: string;
  repoName: string;
  gitUrl: string | null;
  createdAt: string;
}

export interface WorkspaceConfigMember {
  userId: string;
  email: string;
  displayName: string | null;
  role: string;
  joinedAt: string;
}

export interface WorkspaceConfig {
  workspace: WorkspaceConfigWorkspace;
  repos: WorkspaceConfigRepo[];
  members: WorkspaceConfigMember[];
}

// =============================================================================
// Service
// =============================================================================

@Injectable()
export class WorkspaceConfigService {
  constructor(private readonly controlPlane: ControlPlaneService) {}

  async getWorkspaceConfig(workspaceId: string): Promise<WorkspaceConfig> {
    const workspace = await this.controlPlane.getWorkspaceById(workspaceId);
    if (!workspace) {
      throw new NotFoundException('Workspace not found');
    }

    const repos = await this.controlPlane.listRepos(workspaceId);
    const members = await this.controlPlane.listMembers(workspaceId);

    return {
      workspace: {
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        createdAt: workspace.createdAt.toISOString(),
        isCloud: workspace.isCloud,
        ciCdEnabled: workspace.ciCdEnabled,
      },
      repos: repos.map((r) => ({
        id: r.id,
        repoKey: r.repoKey,
        repoName: r.repoName,
        gitUrl: r.gitUrl,
        createdAt: r.createdAt.toISOString(),
      })),
      members: members.map((m) => ({
        userId: m.userId,
        email: m.email,
        displayName: m.displayName,
        role: m.role,
        joinedAt: m.joinedAt.toISOString(),
      })),
    };
  }
}
