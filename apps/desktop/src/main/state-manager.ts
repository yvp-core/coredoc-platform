/**
 * State Manager - Tracks repo pipeline state by checking file existence
 */

import { IpcMain } from 'electron';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import {
  IpcChannels,
  RepoState,
  RepoDetailState,
  RepoStatusState,
  AllStatesResult,
  ParseStats,
  OperationTimestamps,
  GitRevision,
  RepoStalenessInfo,
} from '../shared/ipc-types.js';
import { getCurrentConfig, getConfigDir, getCurrentConfigPath, resolveRepoPath } from './config-manager.js';
import { getApprovalStatus } from './review-manager.js';
import { parsedRepoFile, summariesFile, embeddingsFile, docsDir, countCommitsAhead } from '@coredoc/core/utils';
import { resolveParserArtifactPath, profileArtifactPath } from './parser-artifact.js';

const execFileAsync = promisify(execFile);

/**
 * Get the resolved output directory
 */
function getOutputDir(): string | null {
  const config = getCurrentConfig();
  const configDir = getConfigDir();

  if (!config || !configDir) return null;

  return path.resolve(configDir, config.output.dir);
}

/**
 * Get the resolved parser storage directory
 */
function getParserStorageDir(): string | null {
  const config = getCurrentConfig();
  const configDir = getConfigDir();

  if (!config || !configDir) return null;

  return path.resolve(configDir, config.parserStorage);
}

/**
 * Check if file exists and get its timestamp
 */
function getFileState(filePath: string): { exists: boolean; timestamp?: string } {
  try {
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      return {
        exists: true,
        timestamp: stats.mtime.toISOString(),
      };
    }
  } catch {
    // Ignore errors
  }
  return { exists: false };
}

/**
 * Data extracted from the parsed JSON file in a single read.
 */
interface ParsedJsonData {
  stats: ParseStats;
  gitRevision?: GitRevision;
}

/**
 * Load stats and git revision from parsed JSON file in a single read+parse.
 */
function loadParsedJsonData(jsonPath: string): ParsedJsonData | undefined {
  try {
    if (!fs.existsSync(jsonPath)) return undefined;

    const content = fs.readFileSync(jsonPath, 'utf-8');
    const parsed = JSON.parse(content);

    const stats: ParseStats = {
      ...(parsed.stats?.analysis ? { analysis: parsed.stats.analysis } : {}),
      totalFiles: parsed.files?.length ?? 0,
      parsedFiles: parsed.stats?.parsedFiles ?? parsed.files?.length ?? 0,
      totalFunctions: parsed.functions?.length ?? 0,
      totalClasses: parsed.classes?.length ?? 0,
      totalEntrypoints: parsed.entrypoints?.length ?? 0,
      totalEntities: parsed.entities?.length ?? 0,
    };

    const gitRevision: GitRevision | undefined = parsed.git?.commitHash
      ? {
          commitHash: parsed.git.commitHash,
          commitShortHash: parsed.git.commitShortHash,
          branch: parsed.git.branch,
          isDirty: parsed.git.isDirty,
          commitDate: parsed.git.commitDate,
        }
      : undefined;

    return { stats, gitRevision };
  } catch {
    return undefined;
  }
}

/**
 * Count items in a JSON array file
 */
function countJsonItems(filePath: string): number | undefined {
  try {
    if (!fs.existsSync(filePath)) return undefined;

    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content);

    if (Array.isArray(parsed)) {
      return parsed.length;
    }

    // Handle object with items array or similar structure
    if (parsed.functions) return Object.keys(parsed.functions).length;
    if (parsed.items) return parsed.items.length;

    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Get state for a single repository
 */
export function getRepoState(projectId: string, repoName: string): RepoState | null {
  const outputDir = getOutputDir();
  if (!outputDir) return null;

  const parsedPath = parsedRepoFile(outputDir, projectId, repoName);
  const summariesPath = summariesFile(outputDir, projectId, repoName);
  const embeddingsPath = embeddingsFile(outputDir, projectId, repoName);
  const docsPath = docsDir(outputDir, projectId, repoName);

  const parsedState = getFileState(parsedPath);
  const summariesState = getFileState(summariesPath);
  const embeddingsState = getFileState(embeddingsPath);
  const docsState = getFileState(docsPath);

  const parsedJsonData = parsedState.exists ? loadParsedJsonData(parsedPath) : undefined;

  return {
    name: repoName,
    parsed: {
      ...parsedState,
      stats: parsedJsonData?.stats,
    },
    summarized: {
      ...summariesState,
      count: summariesState.exists ? countJsonItems(summariesPath) : undefined,
    },
    embedded: {
      ...embeddingsState,
      count: embeddingsState.exists ? countJsonItems(embeddingsPath) : undefined,
    },
    docs: {
      ...docsState,
      mode: docsState.exists ? detectDocsMode(docsPath) : undefined,
    },
    neo4jSynced: {
      synced: false, // TODO: Query Neo4j or check local state
    },
  };
}

/**
 * Detect docs generation mode from output
 */
function detectDocsMode(docsPath: string): string | undefined {
  try {
    // Check for mode indicator files
    const quickIndicator = path.join(docsPath, 'quick-mode.marker');
    const deepIndicator = path.join(docsPath, 'analysis');

    if (fs.existsSync(quickIndicator)) return 'quick';
    if (fs.existsSync(deepIndicator)) return 'deep';

    return 'unknown';
  } catch {
    return undefined;
  }
}

interface OpsEntryResult extends OperationTimestamps {
  parsedRevision?: GitRevision;
}

/**
 * Query operation timestamps via the SDK's in-process helper.
 * Returns undefined if the DB is unavailable (non-intrusive).
 */
async function getOperationTimestamps(projectId: string, repoName: string): Promise<OpsEntryResult | undefined> {
  try {
    const configPath = getCurrentConfigPath();
    if (!configPath) return undefined;
    const { getOpsTimestamps } = await import('@coredoc/cli/sdk');
    const result = await getOpsTimestamps(projectId, repoName, path.dirname(configPath));
    if (!result) return undefined;

    return {
      lastGenerated: result.lastGenerated,
      lastParsed: result.lastParsed,
      lastSummarized: result.lastSummarized,
      lastPushed: result.lastPushed,
      lastDocs: result.lastDocs,
      parsedRevision: result.parsedRevision
        ? {
            commitHash: result.parsedRevision.commitHash,
            commitShortHash: result.parsedRevision.commitShortHash,
            branch: result.parsedRevision.branch,
            isDirty: result.parsedRevision.isDirty,
          }
        : undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * Check if a repo is stale by comparing current HEAD with parsed commit.
 */
async function checkRepoStaleness(
  projectId: string,
  repoName: string,
  parsedRevision: GitRevision,
): Promise<RepoStalenessInfo> {
  const repoPath = resolveRepoPath(repoName, projectId);
  if (!repoPath) {
    return { isStale: false };
  }

  try {
    // Get current HEAD commit hash
    const { stdout: currentHash } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: repoPath,
      timeout: 5_000,
    });

    // Check for uncommitted changes
    // const { stdout: porcelain } = await execFileAsync('git', ['status', '--porcelain'], {
    //   cwd: repoPath,
    //   timeout: 5_000,
    // });

    const trimmedHash = currentHash.trim();
    // const isDirty = porcelain.trim().length > 0;

    if (trimmedHash !== parsedRevision.commitHash) {
      // Decoration on a fact: staleness is already established by the hash
      // mismatch, so an unmeasurable count degrades the sentence in the UI, not
      // the warning. null ≠ 0 on purpose (see RepoStalenessInfo).
      const commitsBehind = await countCommitsAhead(repoPath, parsedRevision.commitHash);
      return {
        isStale: true,
        reason: 'new_commits',
        currentCommitHash: trimmedHash,
        parsedCommitHash: parsedRevision.commitHash,
        isDirty: false, // TODO currently we dont need that check
        commitsBehind,
      };
    }

    // if (isDirty) {
    //   return {
    //     isStale: true,
    //     reason: 'dirty_worktree',
    //     currentCommitHash: trimmedHash,
    //     parsedCommitHash: parsedRevision.commitHash,
    //     isDirty,
    //   };
    // }

    return { isStale: false };
  } catch {
    return { isStale: false };
  }
}

/**
 * Get list badges using only artifact existence, profile approval and operations metadata.
 */
export async function getRepoStatusState(projectId: string, repoName: string): Promise<RepoStatusState | null> {
  const outputDir = getOutputDir();
  const parserStorageDir = getParserStorageDir();
  if (!outputDir || !parserStorageDir) return null;

  const parserExists = resolveParserArtifactPath(parserStorageDir, projectId, repoName) !== undefined;
  const parsed = getFileState(parsedRepoFile(outputDir, projectId, repoName));
  const summarized = getFileState(summariesFile(outputDir, projectId, repoName));
  const [ops, approval] = await Promise.all([
    getOperationTimestamps(projectId, repoName),
    parsed.exists ? getApprovalStatus(projectId, repoName, false) : undefined,
  ]);
  // Operation metadata is sufficient for the list's freshness badge. Opening
  // the repository still verifies the revision and output against the artifact.
  const staleness =
    parsed.exists && ops?.parsedRevision
      ? await checkRepoStaleness(projectId, repoName, ops.parsedRevision)
      : undefined;

  return {
    name: repoName,
    parserExists,
    parsed,
    summarized,
    neo4jSynced: { synced: !!ops?.lastPushed, timestamp: ops?.lastPushed },
    approval: approval ?? undefined,
    staleness,
  };
}

/** Full state for an opened repository, including artifact-derived statistics. */
export async function getRepoDetailState(projectId: string, repoName: string): Promise<RepoDetailState | null> {
  const outputDir = getOutputDir();
  const parserStorageDir = getParserStorageDir();
  if (!outputDir || !parserStorageDir) return null;

  // Prefer the declarative profile.ts (legacy parser.ts fallback). parserPath stays a
  // string for the IPC contract — the canonical profile location when neither exists yet.
  const resolvedParserArtifact = resolveParserArtifactPath(parserStorageDir, projectId, repoName);
  const parserPath = resolvedParserArtifact ?? profileArtifactPath(parserStorageDir, projectId, repoName);
  const parsedPath = parsedRepoFile(outputDir, projectId, repoName);
  const summariesPath = summariesFile(outputDir, projectId, repoName);

  const parserExists = resolvedParserArtifact !== undefined;
  const parsedState = getFileState(parsedPath);
  const summariesState = getFileState(summariesPath);

  // Single read+parse for both stats and git revision
  const parsedJsonData = parsedState.exists ? loadParsedJsonData(parsedPath) : undefined;

  // Query operations DB for timestamps (non-blocking, non-intrusive)
  const opsResult = await getOperationTimestamps(projectId, repoName);

  // Only show git revision when a parsed artifact actually exists.
  // Primary source: parsed JSON; fallback: ops metadata (only if JSON exists but lacks git field).
  const parsedRevision = parsedState.exists ? (parsedJsonData?.gitRevision ?? opsResult?.parsedRevision) : undefined;

  // Check staleness if we have a parsed commit to compare against
  let staleness: RepoStalenessInfo | undefined;
  if (parsedRevision) {
    staleness = await checkRepoStaleness(projectId, repoName, parsedRevision);
  }

  // Extract just the timestamp fields for operations
  const operations: OperationTimestamps | undefined = opsResult
    ? {
        lastGenerated: opsResult.lastGenerated,
        lastParsed: opsResult.lastParsed,
        lastSummarized: opsResult.lastSummarized,
        lastPushed: opsResult.lastPushed,
        lastDocs: opsResult.lastDocs,
      }
    : undefined;

  // Get approval status if parsed output exists
  const approval = parsedState.exists ? ((await getApprovalStatus(projectId, repoName)) ?? undefined) : undefined;

  return {
    name: repoName,
    parserExists,
    parserPath,
    parsedOutputPath: parsedState.exists ? parsedPath : undefined,
    parsed: {
      ...parsedState,
      stats: parsedJsonData?.stats,
    },
    summarized: {
      ...summariesState,
      count: summariesState.exists ? countJsonItems(summariesPath) : undefined,
    },
    neo4jSynced: {
      synced: !!opsResult?.lastPushed,
      timestamp: opsResult?.lastPushed,
    },
    operations,
    parsedRevision,
    staleness,
    approval,
  };
}

/**
 * Get state for all repositories in config
 */
export function getAllStates(): AllStatesResult {
  const config = getCurrentConfig();
  const outputDir = getOutputDir();

  if (!config || !outputDir) {
    return { states: [], outputDir: '' };
  }

  const states: RepoState[] = [];

  // Iterate per-project so we have the projectId for each repo
  for (const project of config.projects) {
    const projectId = project.id;
    for (const repo of project.repos) {
      const state = getRepoState(projectId, repo.name);
      states.push(
        state ?? {
          name: repo.name,
          parsed: { exists: false },
          summarized: { exists: false },
          embedded: { exists: false },
          docs: { exists: false },
          neo4jSynced: { synced: false },
        },
      );
    }
  }

  return { states, outputDir };
}

/**
 * Register IPC handlers for state operations
 */
export function registerStateHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IpcChannels.STATE_GET_DETAIL, (_event, projectId: string, name: string) => {
    return getRepoDetailState(projectId, name);
  });

  ipcMain.handle(IpcChannels.STATE_GET_STATUS, (_event, projectId: string, name: string) => {
    return getRepoStatusState(projectId, name);
  });

  ipcMain.handle(IpcChannels.STATE_GET_ALL, () => {
    return getAllStates();
  });
}
