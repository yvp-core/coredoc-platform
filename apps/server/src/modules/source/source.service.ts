/**
 * Source Service
 *
 * Fetches source files from GitHub/GitLab APIs for non-dev workspace members.
 * Uses native fetch — no external dependencies required.
 */

import { Inject, Injectable, NotFoundException, BadRequestException, Optional } from '@nestjs/common';
import { CONNECTORS_CONFIG, type ConnectorsConfig, configFromEnv } from '../../config/app-config.js';
import { ControlPlaneService } from '../../database/control-plane.service.js';

// =============================================================================
// Types
// =============================================================================

export interface SourceFile {
  path: string;
  content: string;
  encoding: string;
  size: number;
}

// =============================================================================
// Service
// =============================================================================

@Injectable()
export class SourceService {
  constructor(
    private readonly controlPlane: ControlPlaneService,
    @Optional() @Inject(CONNECTORS_CONFIG) private readonly connectors: ConnectorsConfig = configFromEnv().connectors,
  ) {}

  async fetchFile(workspaceId: string, repoName: string, filePath: string, ref?: string): Promise<SourceFile> {
    // Look up repo to get git URL
    const repos = await this.controlPlane.listRepos(workspaceId);
    const repo = repos.find((r) => r.repoName === repoName);
    if (!repo) {
      throw new NotFoundException(`Repo "${repoName}" not found in workspace`);
    }

    if (!repo.gitUrl) {
      throw new BadRequestException(`Repo "${repoName}" has no git URL configured`);
    }

    const gitUrl = repo.gitUrl;

    if (gitUrl.includes('github.com')) {
      return this.fetchFromGitHub(gitUrl, filePath, ref);
    } else if (gitUrl.includes('gitlab')) {
      return this.fetchFromGitLab(gitUrl, filePath, ref);
    }

    throw new BadRequestException(`Unsupported git provider for URL: ${gitUrl}`);
  }

  private async fetchFromGitHub(gitUrl: string, filePath: string, ref?: string): Promise<SourceFile> {
    // Extract owner/repo from GitHub URL
    const match = gitUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
    if (!match) {
      throw new BadRequestException(`Invalid GitHub URL: ${gitUrl}`);
    }

    const [, owner, repo] = match;
    const token = this.connectors.githubToken;

    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}${ref ? `?ref=${ref}` : ''}`;

    const headers: Record<string, string> = {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'coredoc-server',
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const response = await fetch(url, { headers });

    if (!response.ok) {
      if (response.status === 404) {
        throw new NotFoundException(`File not found: ${filePath}`);
      }
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as {
      content?: string;
      encoding?: string;
      size?: number;
      path?: string;
    };

    if (!data.content) {
      throw new NotFoundException(`File content not available: ${filePath}`);
    }

    const content = Buffer.from(data.content, 'base64').toString('utf-8');

    return {
      path: data.path ?? filePath,
      content,
      encoding: 'utf-8',
      size: data.size ?? content.length,
    };
  }

  private async fetchFromGitLab(gitUrl: string, filePath: string, ref?: string): Promise<SourceFile> {
    // Extract project path from GitLab URL
    const match = gitUrl.match(/gitlab[^/]*[/:](.+?)(?:\.git)?$/);
    if (!match) {
      throw new BadRequestException(`Invalid GitLab URL: ${gitUrl}`);
    }

    const projectPath = encodeURIComponent(match[1]);
    const encodedFilePath = encodeURIComponent(filePath);
    const token = this.connectors.gitlabToken;

    const gitlabHost = gitUrl.match(/https?:\/\/([^/]+)/)?.[1] ?? 'gitlab.com';
    const url = `https://${gitlabHost}/api/v4/projects/${projectPath}/repository/files/${encodedFilePath}${ref ? `?ref=${ref}` : '?ref=main'}`;

    const headers: Record<string, string> = {};
    if (token) {
      headers['PRIVATE-TOKEN'] = token;
    }

    const response = await fetch(url, { headers });

    if (!response.ok) {
      if (response.status === 404) {
        throw new NotFoundException(`File not found: ${filePath}`);
      }
      throw new Error(`GitLab API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as {
      content?: string;
      encoding?: string;
      size?: number;
      file_path?: string;
    };

    if (!data.content) {
      throw new NotFoundException(`File content not available: ${filePath}`);
    }

    const content = Buffer.from(data.content, 'base64').toString('utf-8');

    return {
      path: data.file_path ?? filePath,
      content,
      encoding: 'utf-8',
      size: data.size ?? content.length,
    };
  }
}
