/**
 * Workspace Manager - IPC handler registration for auth and workspace operations
 */

import { app, ipcMain, shell, type BrowserWindow } from 'electron';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import * as authManager from './auth-manager.js';
import type { IntentReleaseTrigger } from '../shared/intent-release-types.js';
import * as serverApi from './server-api.js';
import { getCurrentConfig, getConfigDir } from './config-manager.js';
import { hasParserArtifact } from './parser-artifact.js';
import { buildRepoIntentIdentity } from './repo-intent-identity.js';
import { pushParserToServer } from '@coredoc/cli/parser-remote';
import { stripSourceCode } from '@coredoc/db';
import type {
  SetServerUrlResult,
  SyncToCloudRepoInput,
  SyncToCloudResult,
  CloudRepoState,
} from '../shared/ipc-types.js';
import { IpcChannels } from '../shared/ipc-types.js';
import { normalizeServerUrl } from '../shared/server-url-format.js';
import { resolveServerConfig, setUserServerUrl } from './server-url.js';
import { getServerCompat, refreshServerCompat, resetServerCompat } from './version-compat.js';
import { isCliAliasInstalled } from './cli-alias-manager.js';

/** Extracts the server's structured error code from an API error, if any. Exported for tests. */
export function structuredErrorCode(error: unknown): string | null {
  const body = (error as { body?: unknown; response?: unknown })?.body ?? (error as { response?: unknown })?.response;
  const fromBody = (value: unknown): string | null =>
    value && typeof value === 'object' && typeof (value as { code?: unknown }).code === 'string'
      ? (value as { code: string }).code
      : null;
  const direct = fromBody(body) ?? fromBody(error);
  if (direct) return direct;
  // apiRequest surfaces the response body inside the Error message; parse the
  // embedded JSON rather than pattern-matching free text.
  const message = (error as Error)?.message ?? '';
  const jsonStart = message.indexOf('{');
  if (jsonStart >= 0) {
    try {
      return fromBody(JSON.parse(message.slice(jsonStart)));
    } catch {
      return null;
    }
  }
  return null;
}

export function structuredJobId(error: unknown): string | null {
  const message = (error as Error)?.message ?? '';
  const jsonStart = message.indexOf('{');
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(message.slice(jsonStart)) as { jobId?: unknown };
      return typeof parsed.jobId === 'string' ? parsed.jobId : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * A batch resolve reports each repository it published. Without this the
 * desktop would show every repository at zero nodes after a successful sync.
 */
function applyBatchCounts(synced: SyncToCloudResult['synced'], resolved: unknown): void {
  const repositories = (resolved as { repositories?: unknown } | null)?.repositories;
  if (!Array.isArray(repositories)) return;
  const counts = new Map(
    repositories
      .filter(
        (entry): entry is { repoName: string; nodeCount: number; edgeCount: number } =>
          !!entry && typeof entry === 'object' && typeof (entry as { repoName?: unknown }).repoName === 'string',
      )
      .map((entry) => [entry.repoName, entry]),
  );
  for (const entry of synced) {
    const published = counts.get(entry.repoName);
    if (!published) continue;
    entry.nodesInserted = published.nodeCount;
    entry.edgesInserted = published.edgeCount;
  }
}

export function registerWorkspaceHandlers(mainWindow?: BrowserWindow): void {
  // Push auth state changes to renderer
  authManager.onAuthChange((status) => {
    mainWindow?.webContents.send('workspace:authChange', status);
  });
  // Server connection — read before login so the pre-login screen can show
  // (and, when unmanaged, change) the server the login will register against.
  ipcMain.handle(IpcChannels.WORKSPACE_GET_SERVER_CONFIG, async () => resolveServerConfig());

  // Version handshake against the resolved server. Advisory: the renderer
  // renders a banner, nothing here refuses a request.
  ipcMain.handle(IpcChannels.WORKSPACE_GET_SERVER_COMPAT, async () =>
    getServerCompat(app.getVersion(), serverApi.getServerMeta),
  );

  ipcMain.handle(IpcChannels.WORKSPACE_SET_SERVER_URL, async (_event, url: unknown): Promise<SetServerUrlResult> => {
    if (typeof url !== 'string') throw new Error('Server URL must be a string');
    const normalized = normalizeServerUrl(url);
    if (!normalized) throw new Error('Enter a full http:// or https:// server URL');
    setUserServerUrl(normalized);
    // The cached verdict describes the OLD server; keeping it would let the
    // banner report a version this app is no longer talking to.
    resetServerCompat();
    // The installed terminal launcher hard-codes the server URL it was built
    // with. Re-rendering it here would prompt for an admin password on macOS
    // (it lives in /usr/local/bin), so the honest minimum is to tell the user
    // to reinstall it from this same screen.
    return { ...resolveServerConfig(), requiresCliReinstall: isCliAliasInstalled() };
  });

  // Auth — PKCE flow: opens browser, deep link callback completes login
  ipcMain.handle('workspace:login', async () => {
    const authUrl = await authManager.startLogin();
    shell.openExternal(authUrl);
    // Return immediately — the deep link callback will complete the flow
    // and emit authChange event to update the renderer
    return { pending: true };
  });

  ipcMain.handle('workspace:logout', async () => {
    return authManager.logout();
  });

  ipcMain.handle('workspace:getAuthStatus', async () => {
    // Use getValidTokens() to auto-refresh expired tokens on startup
    const tokens = await authManager.getValidTokens();
    if (tokens?.serverUrl) {
      const before = normalizeServerUrl(resolveServerConfig().url);
      serverApi.setServerUrl(tokens.serverUrl);
      // An in-flight handshake started against the pre-restoration server holds
      // the same cache generation, so its late result would describe the server
      // we just moved off. Mostly defensive since credentials are only restored
      // when their issuer is the resolved server, but it still covers the
      // residual ordering (e.g. a managed pin rolled back mid-session).
      if (normalizeServerUrl(resolveServerConfig().url) !== before) {
        resetServerCompat();
      }
    }
    // Re-run the handshake now that the session's server URL is applied (this
    // handler is the token-restore path on boot and is re-invoked after a
    // login callback). Fire-and-forget: a version check must never delay or
    // fail the auth status the UI is waiting on.
    void refreshServerCompat(app.getVersion(), serverApi.getServerMeta);
    return {
      isLoggedIn: tokens !== null,
      email: tokens?.email ?? null,
      userId: tokens?.userId ?? null,
    };
  });

  // Workspaces
  ipcMain.handle('workspace:listWorkspaces', async () => {
    return serverApi.listWorkspaces();
  });

  ipcMain.handle('workspace:createWorkspace', async (_event, name: string, slug: string) => {
    return serverApi.createWorkspace(name, slug);
  });

  ipcMain.handle('workspace:deleteWorkspace', async (_event, workspaceId: string) => {
    return serverApi.deleteWorkspace(workspaceId);
  });

  // Members
  ipcMain.handle('workspace:listMembers', async (_event, workspaceId: string) => {
    return serverApi.listMembers(workspaceId);
  });

  ipcMain.handle('workspace:inviteMember', async (_event, workspaceId: string, email: string, role?: string) => {
    return serverApi.inviteMember(workspaceId, email, role);
  });

  ipcMain.handle('workspace:removeMember', async (_event, workspaceId: string, userId: string) => {
    return serverApi.removeMember(workspaceId, userId);
  });

  ipcMain.handle('workspace:listInvites', async (_event, workspaceId: string) => {
    return serverApi.listPendingInvites(workspaceId);
  });

  ipcMain.handle('workspace:revokeInvite', async (_event, workspaceId: string, invitationId: string) => {
    return serverApi.revokeInvite(workspaceId, invitationId);
  });

  ipcMain.handle('workspace:resendInvite', async (_event, workspaceId: string, invitationId: string) => {
    return serverApi.resendInvite(workspaceId, invitationId);
  });

  ipcMain.handle('workspace:updateMemberRole', async (_event, workspaceId: string, userId: string, role: string) => {
    return serverApi.updateMemberRole(workspaceId, userId, role);
  });

  // Repos
  ipcMain.handle('workspace:listRepos', async (_event, workspaceId: string) => {
    return serverApi.listRepos(workspaceId);
  });

  ipcMain.handle(
    'workspace:connectRepo',
    async (_event, workspaceId: string, repoKey: string, repoName: string, gitUrl?: string) => {
      // This route has no local repo config to read `repos[].key` from, so the
      // name is the only durable key it can offer — and it travels only when it
      // proves the graph key (see repo-intent-identity.ts).
      const identity = buildRepoIntentIdentity({ repoKey, durableKey: repoName }, console.log);
      return serverApi.connectRepo(workspaceId, repoKey, repoName, gitUrl, undefined, identity);
    },
  );

  ipcMain.handle('workspace:disconnectRepo', async (_event, workspaceId: string, repoId: string) => {
    return serverApi.disconnectRepo(workspaceId, repoId);
  });

  // Config
  ipcMain.handle('workspace:pullConfig', async (_event, workspaceId: string) => {
    return serverApi.pullWorkspaceConfig(workspaceId);
  });

  // Cloud Sync
  ipcMain.handle('workspace:enableCloud', async (_event, workspaceId: string, opts?: { ciCdEnabled?: boolean }) => {
    return serverApi.enableCloud(workspaceId, opts);
  });

  ipcMain.handle('workspace:setCiCdEnabled', async (_event, workspaceId: string, enabled: boolean) => {
    return serverApi.updateWorkspace(workspaceId, { ciCdEnabled: enabled });
  });

  ipcMain.handle(
    'workspace:setIntentReleaseTrigger',
    async (_event, workspaceId: string, trigger: IntentReleaseTrigger) => {
      return serverApi.updateWorkspace(workspaceId, { intentReleaseTrigger: trigger });
    },
  );

  // `null` clears the override and restores the connector-reported default
  // branch; the server's tri-state PATCH distinguishes it from an omitted field.
  ipcMain.handle(
    'workspace:setProductionBranch',
    async (_event, workspaceId: string, repoKey: string, branch: string | null) => {
      return serverApi.updateRepo(workspaceId, repoKey, { productionBranch: branch });
    },
  );

  ipcMain.handle(
    'workspace:setRepoReleaseTrigger',
    async (_event, workspaceId: string, repoKey: string, trigger: IntentReleaseTrigger | null) =>
      serverApi.updateRepo(workspaceId, repoKey, { intentReleaseTrigger: trigger }),
  );

  ipcMain.handle('workspace:getRepoState', async (_event, workspaceId: string, repoName: string) => {
    try {
      return await serverApi.getRepoState(workspaceId, repoName);
    } catch (err) {
      // 404 = repo not connected to the workspace yet — a valid "no state"
      // answer, not a failure. The renderer relies on null to mean "never
      // pushed to cloud" (use-cloud-sync outdated check); rethrowing would
      // suppress the Sync-with-Cloud banner for newly added repos.
      if (err instanceof serverApi.ApiError && err.status === 404) return null;
      throw err;
    }
  });

  ipcMain.handle('workspace:getMcpConfig', async (_event, workspaceId: string, tool?: string) => {
    return serverApi.getMcpConfig(workspaceId, tool);
  });

  ipcMain.handle('workspace:updateName', async (_event, workspaceId: string, name: string) => {
    return serverApi.updateWorkspaceName(workspaceId, name);
  });

  // Service Tokens
  ipcMain.handle('workspace:listTokens', async (_event, workspaceId: string) => {
    return serverApi.listTokens(workspaceId);
  });

  ipcMain.handle('workspace:createToken', async (_event, workspaceId: string, name: string) => {
    return serverApi.createToken(workspaceId, name);
  });

  ipcMain.handle('workspace:getTokenValue', async (_event, workspaceId: string, tokenId: string) => {
    return serverApi.getTokenValue(workspaceId, tokenId);
  });

  ipcMain.handle('workspace:revokeToken', async (_event, workspaceId: string, tokenId: string) => {
    return serverApi.revokeToken(workspaceId, tokenId);
  });

  // Cloud Project States — fetch repo metadata for cloud member view
  ipcMain.handle(IpcChannels.CLOUD_PROJECT_STATES, async (_event, workspaceId: string): Promise<CloudRepoState[]> => {
    const repos = await serverApi.listRepos(workspaceId);
    const states: CloudRepoState[] = [];

    for (const repo of repos) {
      try {
        const repoState = await serverApi.getRepoState(workspaceId, repo.repoName);
        states.push({
          repoName: repo.repoName,
          nodeCount: repoState?.nodeCount ?? null,
          edgeCount: repoState?.edgeCount ?? null,
          lastPushedAt: repoState?.lastPushedAt ?? null,
          repoKey: repo.repoKey,
        });
      } catch {
        // Repo never pushed — return with null counts
        states.push({
          repoName: repo.repoName,
          nodeCount: null,
          edgeCount: null,
          lastPushedAt: null,
          repoKey: repo.repoKey,
        });
      }
    }

    return states;
  });

  ipcMain.handle(
    'workspace:syncToCloud',
    async (_event, workspaceId: string, repos: SyncToCloudRepoInput[], force?: boolean) => {
      console.log('[syncToCloud] Starting sync:', { workspaceId, repoCount: repos.length, force });
      const results: SyncToCloudResult = { synced: [], skipped: [], errors: [] };

      // File snapshots compose the whole workspace into one immutable object,
      // so publishing N repositories together costs one build and one stored
      // object. Turso mutates a shared graph per repository and has no such
      // composition, so it keeps the per-repository push.
      let batch = false;
      try {
        const workspace = await serverApi.getWorkspace(workspaceId);
        // Both halves required — see the CLI's sync gate: the backend says a
        // batch is meaningful, the capability says this server understands
        // resolve targets. An old server would run the final resolve
        // targetless and publish none of the uploads.
        batch = workspace.graphBackend === 'file_snapshot' && workspace.capabilities?.batchResolveTargets === true;
      } catch (err) {
        console.log('[syncToCloud] Could not read the graph backend; pushing per repo:', (err as Error).message);
      }
      const batchTargets: serverApi.ResolveTarget[] = [];

      for (const { repoName, parsedRepoPath, httpPrefix, key } of repos) {
        console.log(`[syncToCloud] Processing repo: ${repoName}, path: ${parsedRepoPath}`);
        try {
          const rawParsedRepo = JSON.parse(readFileSync(parsedRepoPath, 'utf-8'));
          const { parsed: parsedRepo, strippedCount } = stripSourceCode(rawParsedRepo);
          if (strippedCount > 0) {
            console.log(`[syncToCloud] Stripped sourceCode from ${strippedCount} nodes before push`);
          }
          console.log(
            `[syncToCloud] Loaded parsed repo, id: ${parsedRepo.id}, keys: ${Object.keys(parsedRepo).join(',')}`,
          );

          // Load summaries and embeddings if available
          const outputDir = path.dirname(parsedRepoPath);
          let summaryOutput: unknown = null;
          let embeddingsOutput: unknown = null;

          const summariesPath = path.join(outputDir, `${repoName}-summaries.json`);
          if (existsSync(summariesPath)) {
            try {
              summaryOutput = JSON.parse(readFileSync(summariesPath, 'utf-8'));
              console.log(`[syncToCloud] Loaded summaries for ${repoName}`);
            } catch {
              /* skip invalid */
            }
          }

          const embeddingsPath = path.join(outputDir, `${repoName}-embeddings.json`);
          if (existsSync(embeddingsPath)) {
            try {
              embeddingsOutput = JSON.parse(readFileSync(embeddingsPath, 'utf-8'));
              console.log(`[syncToCloud] Loaded embeddings for ${repoName}`);
            } catch {
              /* skip invalid */
            }
          }

          // Check remote state for delta sync (skip if hash matches, unless force)
          // Parse hash covers code only; summary version is checked separately
          if (!force) {
            try {
              const remoteState = await serverApi.getRepoState(workspaceId, repoName);
              const localParseHash = createHash('sha256').update(JSON.stringify(parsedRepo)).digest('hex').slice(0, 16);
              const localSummaryHash = summaryOutput
                ? `sum_${createHash('sha256').update(JSON.stringify(summaryOutput)).digest('hex').slice(0, 16)}`
                : null;

              const parseUpToDate = remoteState?.lastParseHash === localParseHash;
              const summaryUpToDate = !localSummaryHash || remoteState?.currentSummaryVersion === localSummaryHash;

              console.log(
                `[syncToCloud] Delta check: parse=${parseUpToDate} (remote=${remoteState?.lastParseHash}, local=${localParseHash}), ` +
                  `summary=${summaryUpToDate} (remote=${remoteState?.currentSummaryVersion}, local=${localSummaryHash})`,
              );

              if (parseUpToDate && summaryUpToDate) {
                console.log(`[syncToCloud] Skipping ${repoName}: fully up to date`);
                results.skipped.push({ repoName, reason: 'Already up to date' });
                continue;
              }
            } catch (err) {
              // Only swallow 404 (repo not found = first push). Re-throw auth/network errors.
              const msg = (err as Error).message || '';
              console.log(`[syncToCloud] getRepoState error for ${repoName}: ${msg}`);
              if (!msg.includes('(404)')) {
                results.errors.push({ repoName, error: `Failed to check repo state: ${msg}` });
                continue;
              }
            }
          } else {
            console.log(`[syncToCloud] Force mode — skipping delta check for ${repoName}`);
          }

          // Connect repo. POST is create-only on the server; on 409 (already
          // connected) we follow up with PATCH so mutable fields like
          // httpPrefix propagate from local config to the cloud row.
          const repoKey = parsedRepo.id || repoName;
          // The durable key intent binds on: `repos[].key` when local config
          // sets one, the name otherwise — sent on BOTH routes so a repo
          // connected before this shipped binds on its next sync.
          const identity = buildRepoIntentIdentity({ repoKey, durableKey: key ?? repoName }, console.log);
          try {
            console.log(`[syncToCloud] Connecting repo: ${repoKey} (httpPrefix=${httpPrefix ?? 'none'})`);
            await serverApi.connectRepo(workspaceId, repoKey, repoName, undefined, httpPrefix, identity);
            console.log(`[syncToCloud] Connected repo successfully`);
          } catch (err) {
            const msg = (err as Error).message || '';
            console.log(`[syncToCloud] connectRepo error: ${msg}`);
            if (!msg.includes('(409)') && !msg.includes('already connected')) {
              results.errors.push({ repoName, error: `Failed to connect repo: ${msg}` });
              continue;
            }
            console.log(`[syncToCloud] 409/already connected — patching mutable fields`);
            try {
              await serverApi.updateRepo(workspaceId, repoKey, { httpPrefix, ...identity });
            } catch (patchErr) {
              // Best-effort: PATCH failure isn't fatal — the push will still go
              // through, but a stale httpPrefix may persist. Log loudly so it
              // shows up in support sessions.
              const patchMsg = (patchErr as Error).message || '';
              console.log(`[syncToCloud] updateRepo (PATCH) failed: ${patchMsg}`);
            }
          }

          if (batch) {
            console.log(`[syncToCloud] Uploading repo artifacts: ${repoName}`);
            batchTargets.push(
              await serverApi.uploadRepoArtifacts(workspaceId, repoName, parsedRepo, summaryOutput, embeddingsOutput),
            );
            // Counts arrive with the batch publication, not per repository.
            results.synced.push({ repoName, nodesInserted: 0, edgesInserted: 0 });
          } else {
            console.log(`[syncToCloud] Pushing repo: ${repoName}`);
            const pushResult = await serverApi.pushRepo(
              workspaceId,
              repoName,
              parsedRepo,
              summaryOutput,
              embeddingsOutput,
            );
            console.log(`[syncToCloud] Push result:`, pushResult);
            results.synced.push(pushResult);
          }
        } catch (err) {
          console.log(`[syncToCloud] Error for ${repoName}:`, (err as Error).message);
          results.errors.push({ repoName, error: (err as Error).message });
        }
      }

      if (results.synced.length > 0) {
        // Upload mapper.json before resolution so mapper-driven edges are included
        const config = getCurrentConfig();
        const configDir = getConfigDir();
        if (config && configDir) {
          const project = config.projects.find((p) => p.cloud?.workspaceId === workspaceId);
          if (project) {
            const parserStorageDir = path.resolve(configDir, config.parserStorage);
            const mapperPath = path.join(parserStorageDir, project.id, 'mapper.json');
            if (existsSync(mapperPath)) {
              try {
                const mapper = JSON.parse(readFileSync(mapperPath, 'utf-8'));
                console.log('[syncToCloud] Uploading mapper.json');
                await serverApi.putMapper(workspaceId, mapper, { defer: batch });
                console.log('[syncToCloud] Mapper uploaded');
              } catch (err) {
                console.log('[syncToCloud] Mapper upload failed (non-fatal):', (err as Error).message);
              }
            }
          }
        }

        try {
          console.log('[syncToCloud] Running workspace-wide cross-repo resolution');
          const resolved = await serverApi.resolveWorkspace(workspaceId, batchTargets);
          console.log('[syncToCloud] Resolution complete');
          // In batch mode this call is what published every repository, so its
          // per-repository counts are the only ones this sync ever sees.
          applyBatchCounts(results.synced, resolved);
        } catch (err) {
          console.log('[syncToCloud] Resolution failed (non-fatal):', (err as Error).message);
          if (batch) {
            // A wait-timeout is not a failure OR a success: the resolve job
            // keeps running server-side and may still publish or fail. The
            // repos move out of `synced` into `publishing` so the renderer
            // neither reports failure nor advances freshness — a later sync
            // observes the terminal state. Structured code only: matching
            // arbitrary '504' text would misfile real failures as pending.
            const stillRunning = structuredErrorCode(err) === 'job_still_running';
            if (stillRunning) {
              results.publishing = {
                jobId: structuredJobId(err),
                repoNames: results.synced.map(({ repoName }) => repoName),
              };
              results.synced.length = 0;
            } else {
              results.errors.push({
                repoName: '*',
                error: `Batch publication failed, so no repository was published: ${(err as Error).message}`,
              });
              results.synced.length = 0;
            }
          }
        }
      }

      console.log('[syncToCloud] Final results:', JSON.stringify(results));
      return results;
    },
  );

  // Content-identity freshness check for the "cloud copy is behind" banner —
  // the SAME comparison syncToCloud's delta uses. The banner used to compare
  // push TIMESTAMPS, so a local re-push of identical content marked the cloud
  // behind forever while sync (correctly) kept skipping the upload: the two
  // signals deadlocked and the banner never cleared.
  ipcMain.handle(
    'workspace:checkCloudDelta',
    async (
      _event,
      workspaceId: string,
      repos: Array<{ repoName: string; parsedRepoPath: string }>,
    ): Promise<{ outdated: boolean }> => {
      console.log(`[checkCloudDelta] workspace=${workspaceId} repos=${repos.length}`);
      for (const { repoName, parsedRepoPath } of repos) {
        try {
          if (!existsSync(parsedRepoPath)) continue; // nothing local to compare
          const { parsed: parsedRepo } = stripSourceCode(JSON.parse(readFileSync(parsedRepoPath, 'utf-8')));
          const localParseHash = createHash('sha256').update(JSON.stringify(parsedRepo)).digest('hex').slice(0, 16);
          let localSummaryHash: string | null = null;
          const summariesPath = path.join(path.dirname(parsedRepoPath), `${repoName}-summaries.json`);
          if (existsSync(summariesPath)) {
            try {
              const summaries = JSON.parse(readFileSync(summariesPath, 'utf-8'));
              localSummaryHash = `sum_${createHash('sha256').update(JSON.stringify(summaries)).digest('hex').slice(0, 16)}`;
            } catch {
              // An unreadable summaries file is not part of the comparison.
            }
          }
          const remoteState = await serverApi.getRepoState(workspaceId, repoName);
          const parseUpToDate = remoteState?.lastParseHash === localParseHash;
          const summaryUpToDate = !localSummaryHash || remoteState?.currentSummaryVersion === localSummaryHash;
          if (!parseUpToDate || !summaryUpToDate) return { outdated: true };
        } catch (err) {
          const msg = (err as Error).message || '';
          if (msg.includes('(404)')) return { outdated: true }; // never pushed to cloud
          // A network/auth failure is not evidence of drift — skip quietly.
        }
      }
      return { outdated: false };
    },
  );

  // Parser Upload — scan local parsers, push via CLI's pushParserToServer
  ipcMain.handle('workspace:uploadParsers', async (_event, workspaceId: string) => {
    const config = getCurrentConfig();
    const configDir = getConfigDir();
    if (!config || !configDir) {
      throw new Error('No config loaded — open a project first');
    }

    const parserStorageDir = path.resolve(configDir, config.parserStorage);
    if (!existsSync(parserStorageDir)) {
      return { uploaded: 0, skipped: 0, errors: [] };
    }

    // Find the local project linked to this cloud workspace
    const project = config.projects.find((p) => p.cloud?.workspaceId === workspaceId);
    if (!project) {
      throw new Error(`No local project linked to cloud workspace ${workspaceId}`);
    }

    const projectId = project.id;
    const projectParserDir = path.join(parserStorageDir, projectId);
    if (!existsSync(projectParserDir)) {
      return { uploaded: 0, skipped: 0, errors: [] };
    }

    // Only upload parsers for repos connected to this workspace
    const workspaceRepos = await serverApi.listRepos(workspaceId);
    const connectedRepoNames = new Set(workspaceRepos.map((r) => r.repoName));

    const entries = readdirSync(projectParserDir, { withFileTypes: true });
    const repoNames = entries
      .filter(
        (e) =>
          e.isDirectory() && connectedRepoNames.has(e.name) && hasParserArtifact(parserStorageDir, projectId, e.name),
      )
      .map((e) => e.name);

    // Get desktop auth tokens for the CLI push function
    const tokens = await authManager.getValidTokens();
    if (!tokens) {
      throw new Error('Not authenticated. Please log in first.');
    }

    let uploaded = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const repoName of repoNames) {
      try {
        const result = await pushParserToServer({
          workspaceId,
          repoName,
          parserDir: path.join(projectParserDir, repoName),
          serverUrl: serverApi.getConfiguredServerUrl(),
          authToken: tokens.accessToken,
        });
        if (result === 'uploaded') uploaded++;
        else skipped++;
      } catch (err) {
        errors.push(`${repoName}: ${(err as Error).message}`);
      }
    }

    return { uploaded, skipped, errors };
  });
}
