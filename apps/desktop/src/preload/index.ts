import type { IntentReleaseAction, IntentReleaseWrite } from '../shared/intent-release-types.js';
/**
 * Preload Script - Exposes secure IPC API to renderer
 *
 * Note: This runs in a sandboxed context, so we inline the channel names
 * rather than importing from shared module.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type {
  AnalyticsWindow,
  AnalysisChoice,
  DeliveryExternalTarget,
  DeliveryLifecycleFilter,
  FeedbackRecordsFilter,
  GraphScope,
  SyncToCloudRepoInput,
} from '../shared/ipc-types.js';
import type {
  IntentAnchorRefreshInput,
  IntentArchiveInput,
  IntentContextQuery,
  IntentDeleteInput,
  IntentDimensionsQuery,
  IntentDomainCreateInput,
  IntentDomainUpdateInput,
  IntentFeatureCreateInput,
  IntentFeatureUpdateInput,
  IntentFeaturesQuery,
  IntentItemsQuery,
  IntentReviewQueueQuery,
  IntentReviewRequest,
  IntentSeedDeleteInput,
  IntentSeedPutInput,
  IntentTransitionsQuery,
  IntentTreeQuery,
} from '../shared/intent-types.js';

// IPC Channel names (inlined to avoid module resolution issues in preload)
const IpcChannels = {
  CONFIG_LOAD: 'config:load',
  CONFIG_SAVE: 'config:save',
  CONFIG_VALIDATE: 'config:validate',
  CONFIG_REMOVE_REPO: 'config:removeRepo',
  STATE_GET: 'state:get',
  STATE_GET_ALL: 'state:getAll',
  STATE_GET_DETAIL: 'state:getDetail',
  STATE_GET_STATUS: 'state:getStatus',
  STATE_REFRESH: 'state:refresh',
  SHELL_OPEN_PATH: 'shell:openPath',
  SHELL_SHOW_ITEM_IN_FOLDER: 'shell:showItemInFolder',
  ANALYSIS_PROMPTS: 'analysis:prompts',
  ANALYSIS_ANSWER: 'analysis:answer',
  ANALYSIS_CHANGED: 'analysis:changed',
  COMMAND_RUN: 'command:run',
  COMMAND_CANCEL: 'command:cancel',
  COMMAND_GET_RUNNING: 'command:getRunning',
  COMMAND_OUTPUT: 'command:output',
  COMMAND_PROGRESS: 'command:progress',
  COMMAND_COMPLETED: 'command:completed',
  MCP_GET_INFO: 'mcp:getInfo',
  // Chat Streaming
  CHAT_SEND: 'chat:send',
  CHAT_CANCEL: 'chat:cancel',
  CHAT_CLEAR: 'chat:clear',
  CHAT_STREAM_DELTA: 'chat:stream:delta',
  CHAT_STREAM_TOOL: 'chat:stream:tool',
  CHAT_STREAM_END: 'chat:stream:end',
  // Sessions
  SESSION_LIST: 'session:list',
  SESSION_LOAD: 'session:load',
  SESSION_CREATE: 'session:create',
  SESSION_SAVE: 'session:save',
  SESSION_DELETE: 'session:delete',
  SESSION_RENAME: 'session:rename',
  SESSION_DELETE_PROJECT: 'session:deleteProject',
  // PTY
  PTY_DATA: 'pty:data',
  PTY_EXIT: 'pty:exit',
  PTY_WRITE: 'pty:write',
  PTY_RESIZE: 'pty:resize',
  // Agent runs (profile authoring)
  AGENT_RUN_EVENT: 'agentRun:event',
  AGENT_RUN_ANSWER: 'agentRun:answer',
  AGENT_RUN_GET_STATE: 'agentRun:getState',
  // Docs
  DOCS_LIST: 'docs:list',
  DOCS_READ: 'docs:read',
  DOCS_PROMPTS: 'docs:prompts',
  DOCS_DELETE: 'docs:delete',
  // Review
  REVIEW_GET_GRAPH_DATA: 'review:getGraphData',
  REVIEW_APPROVE: 'review:approve',
  REVIEW_GET_APPROVAL: 'review:getApproval',
  // Graph explorer
  GRAPH_NODE: 'graph:node',
  GRAPH_NEIGHBORS: 'graph:neighbors',
  GRAPH_SUBGRAPH: 'graph:subgraph',
  GRAPH_SEARCH: 'graph:search',
  GRAPH_NODES_BY_TYPE: 'graph:nodesByType',
  GRAPH_REPOS: 'graph:repos',
  GRAPH_OVERVIEW: 'graph:overview',
  GRAPH_EDGES_AMONG: 'graph:edgesAmong',
  GRAPH_CROSS_REPO: 'graph:crossRepo',
  GRAPH_DEAD_CODE: 'graph:deadCode',
  GRAPH_CAPABILITIES: 'graph:capabilities',
  GRAPH_CYPHER: 'graph:cypher',
  GRAPH_GENERATE_CYPHER: 'graph:generateCypher',
  // Settings
  SETTINGS_GET_HARNESS: 'settings:getHarness',
  SETTINGS_UPDATE_HARNESS: 'settings:updateHarness',
  // CLI alias
  CLI_ALIAS_GET_STATUS: 'cliAlias:getStatus',
  CLI_ALIAS_INSTALL: 'cliAlias:install',
  CLI_ALIAS_UNINSTALL: 'cliAlias:uninstall',
  // Telemetry
  TELEMETRY_GET_STATUS: 'telemetry:getStatus',
  TELEMETRY_SET_ENABLED: 'telemetry:setEnabled',
  TELEMETRY_MARK_CONSENT_PROMPTED: 'telemetry:markConsentPrompted',
  // Observability (cloud dashboards + Claude Code OTLP telemetry)
  OBSERVABILITY_GET_USAGE_ANALYTICS: 'observability:getUsageAnalytics',
  OBSERVABILITY_OPEN_DASHBOARD: 'observability:openDashboard',
  OBSERVABILITY_GET_FEEDBACK_ROADMAP: 'observability:getFeedbackRoadmap',
  OBSERVABILITY_GET_FEEDBACK_CORRELATION: 'observability:getFeedbackCorrelation',
  OBSERVABILITY_GET_FEEDBACK_RECORDS: 'observability:getFeedbackRecords',
  // Canonical Delivery
  DELIVERY_OPEN_EXTERNAL: 'delivery:openExternal',
  DELIVERY_GET_CANONICAL_TASKS: 'delivery:getCanonicalTasks',
  DELIVERY_GET_CANONICAL_TASK_SUMMARIES: 'delivery:getCanonicalTaskSummaries',
  DELIVERY_GET_CANONICAL_SUMMARY: 'delivery:getCanonicalSummary',
  DELIVERY_GET_CANONICAL_TASK_DETAIL: 'delivery:getCanonicalTaskDetail',
  DELIVERY_GET_CANONICAL_TASK_EXTERNAL_REFS: 'delivery:getCanonicalTaskExternalRefs',
  DELIVERY_GET_CANONICAL_EXTERNAL_REF_STATE_HISTORY: 'delivery:getCanonicalExternalRefStateHistory',
  DELIVERY_GET_CANONICAL_TASK_RUNS: 'delivery:getCanonicalTaskRuns',
  DELIVERY_GET_CANONICAL_RUN_STAGE_OCCURRENCES: 'delivery:getCanonicalRunStageOccurrences',
  DELIVERY_GET_CANONICAL_TASK_CODE_CHANGES: 'delivery:getCanonicalTaskCodeChanges',
  DELIVERY_GET_CANONICAL_TASK_SHIP_EVIDENCE: 'delivery:getCanonicalTaskShipEvidence',
  DELIVERY_GET_CANONICAL_TASK_REWORK_SIGNALS: 'delivery:getCanonicalTaskReworkSignals',
  DELIVERY_GET_CANONICAL_TASK_ARTIFACTS: 'delivery:getCanonicalTaskArtifacts',
  DELIVERY_GET_CANONICAL_ARTIFACT_REVISIONS: 'delivery:getCanonicalArtifactRevisions',
  // Update
  UPDATE_CHECK: 'update:check',
  UPDATE_INSTALL: 'update:install',
  UPDATE_STATUS: 'update:status',
  UPDATE_GET_STATUS: 'update:getStatus',
  UPDATE_GET_APP_VERSION: 'update:getAppVersion',
  // Dialog
  DIALOG_SELECT_FOLDERS: 'dialog:selectFolders',
  DIALOG_SELECT_TEMPLATE_DAG: 'dialog:selectTemplateDag',
  DIALOG_SELECT_TEMPLATE_FILE: 'dialog:selectTemplateFile',
  LINKED_REPOS_GET: 'linkedRepos:get',
  LINKED_REPOS_LINK: 'linkedRepos:link',
  LINKED_REPOS_REMOVE: 'linkedRepos:remove',
} as const;

// Type definitions (inlined)
interface CommandRunOptions {
  command: string;
  projectId: string;
  repo?: string;
  args?: Record<string, unknown>;
}

interface CommandOutput {
  id: string;
  line: string;
  stream: 'stdout' | 'stderr';
}

interface CommandProgress {
  id: string;
  current: number;
  total: number;
  message?: string;
}

interface CommandCompleted {
  id: string;
  success: boolean;
  exitCode: number;
  error?: string;
}

// PTY types (inlined)
interface PtyData {
  id: string;
  data: string;
}

interface PtyExit {
  id: string;
  exitCode: number;
  signal?: number;
}

// Agent-run types (inlined; canonical definitions in ../shared/agent-run-types)
interface AgentRunEventEnvelope {
  id: string;
  event: unknown;
}

interface AgentRunAnswer {
  requestId: string;
  answers: string[][];
}

interface AgentRunSnapshot {
  phase: string;
  todos: { text: string; status: string }[];
  pendingQuestion: { requestId: string; questions: unknown[] } | null;
  rawLog: string;
}

// Chat context type (inlined)
interface ChatContext {
  project?: string;
  repo?: string;
  cwd?: string;
  cloudMember?: boolean;
  workspaceId?: string;
  cloudRepoNames?: string[];
  linkedRepoPaths?: Record<string, string>;
}

// Chat streaming types (inlined)
interface ChatStreamDelta {
  sessionId: string;
  messageId: string;
  delta: string;
}

interface ChatStreamToolUpdate {
  sessionId: string;
  messageId: string;
  toolCall: {
    id: string;
    name: string;
    input: Record<string, unknown>;
    status: 'pending' | 'running' | 'completed' | 'error';
    output?: string;
    error?: string;
  };
}

interface ChatStreamEnd {
  sessionId: string;
  messageId: string;
  success: boolean;
  error?: string;
}

// Update types (inlined)
interface UpdateStatusInfo {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error';
  version?: string;
  downloadProgress?: number;
  error?: string;
}

// Expose protected methods to the renderer process
const electronAPI = {
  platform: process.platform,

  // Config
  loadConfig: (configPath?: string) => ipcRenderer.invoke(IpcChannels.CONFIG_LOAD, configPath),

  saveConfig: (config: unknown) => ipcRenderer.invoke(IpcChannels.CONFIG_SAVE, config),

  validateConfig: () => ipcRenderer.invoke(IpcChannels.CONFIG_VALIDATE),

  removeRepository: (projectId: string, repoName: string) =>
    ipcRenderer.invoke(IpcChannels.CONFIG_REMOVE_REPO, projectId, repoName),

  // State
  getRepoState: (projectId: string, name: string) => ipcRenderer.invoke(IpcChannels.STATE_GET, projectId, name),

  getRepoDetailState: (projectId: string, name: string) =>
    ipcRenderer.invoke(IpcChannels.STATE_GET_DETAIL, projectId, name),

  getRepoStatusState: (projectId: string, name: string) =>
    ipcRenderer.invoke(IpcChannels.STATE_GET_STATUS, projectId, name),

  getAllStates: () => ipcRenderer.invoke(IpcChannels.STATE_GET_ALL),

  refreshState: () => ipcRenderer.invoke(IpcChannels.STATE_REFRESH),

  // Shell
  openPath: (filePath: string) => ipcRenderer.invoke(IpcChannels.SHELL_OPEN_PATH, filePath),
  showItemInFolder: (filePath: string) => ipcRenderer.invoke(IpcChannels.SHELL_SHOW_ITEM_IN_FOLDER, filePath),

  // Commands
  getAnalysisPrompts: () => ipcRenderer.invoke(IpcChannels.ANALYSIS_PROMPTS),
  answerAnalysisPrompt: (id: string, choice: AnalysisChoice) =>
    ipcRenderer.invoke(IpcChannels.ANALYSIS_ANSWER, id, choice),
  onAnalysisPromptsChanged: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on(IpcChannels.ANALYSIS_CHANGED, listener);
    return () => ipcRenderer.removeListener(IpcChannels.ANALYSIS_CHANGED, listener);
  },
  runCommand: (options: CommandRunOptions) => ipcRenderer.invoke(IpcChannels.COMMAND_RUN, options),

  cancelCommand: (id: string) => ipcRenderer.invoke(IpcChannels.COMMAND_CANCEL, id),

  getRunningCommands: () => ipcRenderer.invoke(IpcChannels.COMMAND_GET_RUNNING),

  onCommandOutput: (callback: (output: CommandOutput) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, output: CommandOutput) => {
      callback(output);
    };
    ipcRenderer.on(IpcChannels.COMMAND_OUTPUT, listener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.COMMAND_OUTPUT, listener);
    };
  },

  onCommandProgress: (callback: (progress: CommandProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: CommandProgress) => {
      callback(progress);
    };
    ipcRenderer.on(IpcChannels.COMMAND_PROGRESS, listener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.COMMAND_PROGRESS, listener);
    };
  },

  onCommandCompleted: (callback: (result: CommandCompleted) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, result: CommandCompleted) => {
      callback(result);
    };
    ipcRenderer.on(IpcChannels.COMMAND_COMPLETED, listener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.COMMAND_COMPLETED, listener);
    };
  },

  // PTY
  onPtyData: (callback: (data: PtyData) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: PtyData) => {
      callback(data);
    };
    ipcRenderer.on(IpcChannels.PTY_DATA, listener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.PTY_DATA, listener);
    };
  },

  onPtyExit: (callback: (data: PtyExit) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: PtyExit) => {
      callback(data);
    };
    ipcRenderer.on(IpcChannels.PTY_EXIT, listener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.PTY_EXIT, listener);
    };
  },

  writePty: (id: string, data: string) => ipcRenderer.invoke(IpcChannels.PTY_WRITE, id, data),

  resizePty: (id: string, cols: number, rows: number) => ipcRenderer.invoke(IpcChannels.PTY_RESIZE, id, cols, rows),

  // Agent runs (profile authoring)
  onAgentRunEvent: (callback: (data: AgentRunEventEnvelope) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: AgentRunEventEnvelope) => callback(data);
    ipcRenderer.on(IpcChannels.AGENT_RUN_EVENT, listener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.AGENT_RUN_EVENT, listener);
    };
  },

  answerAgentRun: (id: string, answer: AgentRunAnswer) => ipcRenderer.invoke(IpcChannels.AGENT_RUN_ANSWER, id, answer),

  getAgentRunState: (id: string): Promise<AgentRunSnapshot | null> =>
    ipcRenderer.invoke(IpcChannels.AGENT_RUN_GET_STATE, id),

  // MCP configuration
  getMcpInfo: (projectId: string) => ipcRenderer.invoke(IpcChannels.MCP_GET_INFO, projectId),

  // Chat Streaming
  sendChatMessage: (message: string, context?: ChatContext) =>
    ipcRenderer.invoke(IpcChannels.CHAT_SEND, message, context),

  cancelChat: () => ipcRenderer.invoke(IpcChannels.CHAT_CANCEL),

  clearChat: () => ipcRenderer.invoke(IpcChannels.CHAT_CLEAR),

  onChatStreamDelta: (callback: (data: ChatStreamDelta) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: ChatStreamDelta) => callback(data);
    ipcRenderer.on(IpcChannels.CHAT_STREAM_DELTA, listener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.CHAT_STREAM_DELTA, listener);
    };
  },

  onChatStreamTool: (callback: (data: ChatStreamToolUpdate) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: ChatStreamToolUpdate) => callback(data);
    ipcRenderer.on(IpcChannels.CHAT_STREAM_TOOL, listener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.CHAT_STREAM_TOOL, listener);
    };
  },

  onChatStreamEnd: (callback: (data: ChatStreamEnd) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: ChatStreamEnd) => callback(data);
    ipcRenderer.on(IpcChannels.CHAT_STREAM_END, listener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.CHAT_STREAM_END, listener);
    };
  },

  // Sessions
  listSessions: (projectId: string) => ipcRenderer.invoke(IpcChannels.SESSION_LIST, projectId),

  loadSession: (sessionId: string) => ipcRenderer.invoke(IpcChannels.SESSION_LOAD, sessionId),

  createSession: (projectId: string, name?: string) => ipcRenderer.invoke(IpcChannels.SESSION_CREATE, projectId, name),

  saveSession: (session: unknown) => ipcRenderer.invoke(IpcChannels.SESSION_SAVE, session),

  deleteSession: (sessionId: string) => ipcRenderer.invoke(IpcChannels.SESSION_DELETE, sessionId),

  renameSession: (sessionId: string, newName: string) =>
    ipcRenderer.invoke(IpcChannels.SESSION_RENAME, sessionId, newName),

  deleteProjectSessions: (projectId: string) => ipcRenderer.invoke(IpcChannels.SESSION_DELETE_PROJECT, projectId),

  // Docs
  listDocs: (projectId: string, repoNames: string[], dagPath?: string, workspaceId?: string) =>
    ipcRenderer.invoke(IpcChannels.DOCS_LIST, projectId, repoNames, dagPath, workspaceId),
  readDoc: (projectId: string, repoName: string, relativePath: string, workspaceId?: string) =>
    ipcRenderer.invoke(IpcChannels.DOCS_READ, projectId, repoName, relativePath, workspaceId),
  listDocsPrompts: (dagPath?: string) => ipcRenderer.invoke(IpcChannels.DOCS_PROMPTS, dagPath),
  deleteDoc: (projectId: string, repoName: string, relativePath: string, workspaceId?: string) =>
    ipcRenderer.invoke(IpcChannels.DOCS_DELETE, projectId, repoName, relativePath, workspaceId),

  // Review
  getGraphReviewData: (projectId: string, repoName: string) =>
    ipcRenderer.invoke(IpcChannels.REVIEW_GET_GRAPH_DATA, projectId, repoName),
  approveParser: (projectId: string, repoName: string) =>
    ipcRenderer.invoke(IpcChannels.REVIEW_APPROVE, projectId, repoName),
  getApprovalStatus: (projectId: string, repoName: string) =>
    ipcRenderer.invoke(IpcChannels.REVIEW_GET_APPROVAL, projectId, repoName),

  // Graph explorer
  graphNode: (scope: GraphScope, nodeId: string) => ipcRenderer.invoke(IpcChannels.GRAPH_NODE, scope, nodeId),
  graphNeighbors: (
    scope: GraphScope,
    nodeId: string,
    args: { direction: 'in' | 'out'; edgeType: string; limit?: number; cursor?: string },
  ) => ipcRenderer.invoke(IpcChannels.GRAPH_NEIGHBORS, scope, nodeId, args),
  graphSubgraph: (
    scope: GraphScope,
    nodeId: string,
    args: { depth: number; direction?: 'in' | 'out' | 'both'; edgeTypes?: string[]; limit?: number },
  ) => ipcRenderer.invoke(IpcChannels.GRAPH_SUBGRAPH, scope, nodeId, args),
  graphSearch: (scope: GraphScope, q: string, limit?: number) =>
    ipcRenderer.invoke(IpcChannels.GRAPH_SEARCH, scope, q, limit),
  graphNodesByType: (scope: GraphScope, args: { type: string; scopeRepo?: string; limit?: number; cursor?: string }) =>
    ipcRenderer.invoke(IpcChannels.GRAPH_NODES_BY_TYPE, scope, args),
  graphRepos: (scope: GraphScope) => ipcRenderer.invoke(IpcChannels.GRAPH_REPOS, scope),
  graphOverview: (scope: GraphScope) => ipcRenderer.invoke(IpcChannels.GRAPH_OVERVIEW, scope),
  graphEdgesAmong: (scope: GraphScope, nodeIds: string[]) =>
    ipcRenderer.invoke(IpcChannels.GRAPH_EDGES_AMONG, scope, nodeIds),
  graphCrossRepo: (scope: GraphScope, args: { scopeRepo?: string; limit?: number }) =>
    ipcRenderer.invoke(IpcChannels.GRAPH_CROSS_REPO, scope, args),
  graphDeadCode: (scope: GraphScope, args: { types?: string[]; scopeRepo?: string; limit?: number }) =>
    ipcRenderer.invoke(IpcChannels.GRAPH_DEAD_CODE, scope, args),
  graphCapabilities: (scope: GraphScope) => ipcRenderer.invoke(IpcChannels.GRAPH_CAPABILITIES, scope),
  graphCypher: (scope: GraphScope, query: string, limit?: number) =>
    ipcRenderer.invoke(IpcChannels.GRAPH_CYPHER, scope, query, limit),
  graphGenerateCypher: (scope: GraphScope, text: string) =>
    ipcRenderer.invoke(IpcChannels.GRAPH_GENERATE_CYPHER, scope, text),

  // Settings
  getHarnessSettings: () => ipcRenderer.invoke(IpcChannels.SETTINGS_GET_HARNESS),
  updateHarnessSettings: (update: import('../shared/ipc-types.js').HarnessSettingsUpdate) =>
    ipcRenderer.invoke(IpcChannels.SETTINGS_UPDATE_HARNESS, update),

  // CLI alias
  getCliAliasStatus: () => ipcRenderer.invoke(IpcChannels.CLI_ALIAS_GET_STATUS),
  installCliAlias: () => ipcRenderer.invoke(IpcChannels.CLI_ALIAS_INSTALL),
  uninstallCliAlias: () => ipcRenderer.invoke(IpcChannels.CLI_ALIAS_UNINSTALL),

  // Telemetry
  getTelemetryStatus: () => ipcRenderer.invoke(IpcChannels.TELEMETRY_GET_STATUS),
  setTelemetryEnabled: (enabled: boolean) => ipcRenderer.invoke(IpcChannels.TELEMETRY_SET_ENABLED, enabled),
  markTelemetryConsentPrompted: () => ipcRenderer.invoke(IpcChannels.TELEMETRY_MARK_CONSENT_PROMPTED),

  // Observability (cloud dashboards + Claude Code OTLP telemetry)
  getUsageAnalytics: (workspaceId: string, window: AnalyticsWindow) =>
    ipcRenderer.invoke(IpcChannels.OBSERVABILITY_GET_USAGE_ANALYTICS, workspaceId, window),
  openObservabilityDashboard: (workspaceSlug: string) =>
    ipcRenderer.invoke(IpcChannels.OBSERVABILITY_OPEN_DASHBOARD, workspaceSlug),

  // Feedback
  getFeedbackRoadmap: (workspaceId: string, days: number) =>
    ipcRenderer.invoke(IpcChannels.OBSERVABILITY_GET_FEEDBACK_ROADMAP, workspaceId, days),
  getFeedbackCorrelation: (workspaceId: string, days: number) =>
    ipcRenderer.invoke(IpcChannels.OBSERVABILITY_GET_FEEDBACK_CORRELATION, workspaceId, days),
  getFeedbackRecords: (workspaceId: string, window: AnalyticsWindow, filter: FeedbackRecordsFilter) =>
    ipcRenderer.invoke(IpcChannels.OBSERVABILITY_GET_FEEDBACK_RECORDS, workspaceId, window, filter),

  // Canonical Delivery
  openDeliveryExternal: (target: DeliveryExternalTarget) =>
    ipcRenderer.invoke(IpcChannels.DELIVERY_OPEN_EXTERNAL, target),
  getCanonicalDeliveryTasks: (workspaceId: string) =>
    ipcRenderer.invoke(IpcChannels.DELIVERY_GET_CANONICAL_TASKS, workspaceId),
  getDeliverySummary: (
    workspaceId: string,
    window: AnalyticsWindow,
    lifecycle: DeliveryLifecycleFilter,
    mine: boolean,
    userId: string | null,
  ) => ipcRenderer.invoke(IpcChannels.DELIVERY_GET_CANONICAL_SUMMARY, workspaceId, window, lifecycle, mine, userId),
  getCanonicalTaskSummaries: (
    workspaceId: string,
    limit: number,
    cursor?: string,
    window?: AnalyticsWindow,
    lifecycle?: DeliveryLifecycleFilter,
    mine?: boolean,
    userId?: string | null,
  ) =>
    ipcRenderer.invoke(
      IpcChannels.DELIVERY_GET_CANONICAL_TASK_SUMMARIES,
      workspaceId,
      limit,
      cursor,
      window,
      lifecycle,
      mine,
      userId,
    ),
  getCanonicalTaskDetail: (workspaceId: string, taskId: string) =>
    ipcRenderer.invoke(IpcChannels.DELIVERY_GET_CANONICAL_TASK_DETAIL, workspaceId, taskId),
  getCanonicalTaskExternalRefs: (workspaceId: string, taskId: string, limit: number, cursor?: string) =>
    ipcRenderer.invoke(IpcChannels.DELIVERY_GET_CANONICAL_TASK_EXTERNAL_REFS, workspaceId, taskId, limit, cursor),
  getCanonicalExternalRefStateHistory: (
    workspaceId: string,
    taskId: string,
    externalRefId: string,
    limit: number,
    cursor?: string,
  ) =>
    ipcRenderer.invoke(
      IpcChannels.DELIVERY_GET_CANONICAL_EXTERNAL_REF_STATE_HISTORY,
      workspaceId,
      taskId,
      externalRefId,
      limit,
      cursor,
    ),
  getCanonicalTaskRuns: (workspaceId: string, taskId: string, limit: number, cursor?: string) =>
    ipcRenderer.invoke(IpcChannels.DELIVERY_GET_CANONICAL_TASK_RUNS, workspaceId, taskId, limit, cursor),
  getCanonicalRunStageOccurrences: (
    workspaceId: string,
    taskId: string,
    runId: string,
    limit: number,
    cursor?: string,
  ) =>
    ipcRenderer.invoke(
      IpcChannels.DELIVERY_GET_CANONICAL_RUN_STAGE_OCCURRENCES,
      workspaceId,
      taskId,
      runId,
      limit,
      cursor,
    ),
  getCanonicalTaskCodeChanges: (workspaceId: string, taskId: string, limit: number, cursor?: string) =>
    ipcRenderer.invoke(IpcChannels.DELIVERY_GET_CANONICAL_TASK_CODE_CHANGES, workspaceId, taskId, limit, cursor),
  getCanonicalTaskShipEvidence: (workspaceId: string, taskId: string, limit: number, cursor?: string) =>
    ipcRenderer.invoke(IpcChannels.DELIVERY_GET_CANONICAL_TASK_SHIP_EVIDENCE, workspaceId, taskId, limit, cursor),
  getCanonicalTaskReworkSignals: (workspaceId: string, taskId: string, limit: number, cursor?: string) =>
    ipcRenderer.invoke(IpcChannels.DELIVERY_GET_CANONICAL_TASK_REWORK_SIGNALS, workspaceId, taskId, limit, cursor),
  getCanonicalTaskArtifacts: (workspaceId: string, taskId: string, limit: number, cursor?: string) =>
    ipcRenderer.invoke(IpcChannels.DELIVERY_GET_CANONICAL_TASK_ARTIFACTS, workspaceId, taskId, limit, cursor),
  getCanonicalArtifactRevisions: (workspaceId: string, artifactId: string) =>
    ipcRenderer.invoke(IpcChannels.DELIVERY_GET_CANONICAL_ARTIFACT_REVISIONS, workspaceId, artifactId),

  // Update
  checkForUpdate: () => ipcRenderer.invoke(IpcChannels.UPDATE_CHECK),
  installUpdate: () => ipcRenderer.invoke(IpcChannels.UPDATE_INSTALL),
  getUpdateStatus: () => ipcRenderer.invoke(IpcChannels.UPDATE_GET_STATUS),
  onUpdateStatus: (callback: (status: UpdateStatusInfo) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: UpdateStatusInfo) => {
      callback(status);
    };
    ipcRenderer.on(IpcChannels.UPDATE_STATUS, listener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.UPDATE_STATUS, listener);
    };
  },
  getAppVersion: () => ipcRenderer.invoke(IpcChannels.UPDATE_GET_APP_VERSION),

  // Dialog
  selectFolders: () => ipcRenderer.invoke(IpcChannels.DIALOG_SELECT_FOLDERS),
  selectTemplateDag: () => ipcRenderer.invoke(IpcChannels.DIALOG_SELECT_TEMPLATE_DAG),
  selectTemplateFile: () => ipcRenderer.invoke(IpcChannels.DIALOG_SELECT_TEMPLATE_FILE),

  // Workspace & Auth
  workspaceGetServerConfig: () => ipcRenderer.invoke('workspace:getServerConfig'),
  workspaceSetServerUrl: (url: string) => ipcRenderer.invoke('workspace:setServerUrl', url),
  workspaceGetServerCompat: () => ipcRenderer.invoke('workspace:getServerCompat'),
  workspaceLogin: () => ipcRenderer.invoke('workspace:login'),
  workspaceLogout: () => ipcRenderer.invoke('workspace:logout'),
  getWorkspaceAuthStatus: () => ipcRenderer.invoke('workspace:getAuthStatus'),
  workspaceListWorkspaces: () => ipcRenderer.invoke('workspace:listWorkspaces'),
  workspaceCreateWorkspace: (name: string, slug: string) => ipcRenderer.invoke('workspace:createWorkspace', name, slug),
  workspaceDeleteWorkspace: (workspaceId: string) => ipcRenderer.invoke('workspace:deleteWorkspace', workspaceId),
  workspaceListMembers: (workspaceId: string) => ipcRenderer.invoke('workspace:listMembers', workspaceId),
  workspaceInviteMember: (workspaceId: string, email: string, role?: string) =>
    ipcRenderer.invoke('workspace:inviteMember', workspaceId, email, role),
  workspaceRemoveMember: (workspaceId: string, userId: string) =>
    ipcRenderer.invoke('workspace:removeMember', workspaceId, userId),
  workspaceListInvites: (workspaceId: string) => ipcRenderer.invoke('workspace:listInvites', workspaceId),
  workspaceRevokeInvite: (workspaceId: string, invitationId: string) =>
    ipcRenderer.invoke('workspace:revokeInvite', workspaceId, invitationId),
  workspaceResendInvite: (workspaceId: string, invitationId: string) =>
    ipcRenderer.invoke('workspace:resendInvite', workspaceId, invitationId),
  workspaceUpdateMemberRole: (workspaceId: string, userId: string, role: string) =>
    ipcRenderer.invoke('workspace:updateMemberRole', workspaceId, userId, role),
  workspaceListRepos: (workspaceId: string) => ipcRenderer.invoke('workspace:listRepos', workspaceId),
  workspaceConnectRepo: (workspaceId: string, repoKey: string, repoName: string, gitUrl?: string) =>
    ipcRenderer.invoke('workspace:connectRepo', workspaceId, repoKey, repoName, gitUrl),
  workspaceDisconnectRepo: (workspaceId: string, repoId: string) =>
    ipcRenderer.invoke('workspace:disconnectRepo', workspaceId, repoId),
  workspacePullConfig: (workspaceId: string) => ipcRenderer.invoke('workspace:pullConfig', workspaceId),

  // Cloud Sync
  workspaceEnableCloud: (workspaceId: string, opts?: { ciCdEnabled?: boolean }) =>
    ipcRenderer.invoke('workspace:enableCloud', workspaceId, opts),
  workspaceSetCiCdEnabled: (workspaceId: string, enabled: boolean) =>
    ipcRenderer.invoke('workspace:setCiCdEnabled', workspaceId, enabled),
  workspaceSetIntentReleaseTrigger: (workspaceId: string, trigger: string) =>
    ipcRenderer.invoke('workspace:setIntentReleaseTrigger', workspaceId, trigger),
  workspaceSetRepoReleaseTrigger: (workspaceId: string, repoKey: string, trigger: string | null) =>
    ipcRenderer.invoke('workspace:setRepoReleaseTrigger', workspaceId, repoKey, trigger),
  workspaceSetProductionBranch: (workspaceId: string, repoKey: string, branch: string | null) =>
    ipcRenderer.invoke('workspace:setProductionBranch', workspaceId, repoKey, branch),
  workspaceSyncToCloud: (workspaceId: string, repos: SyncToCloudRepoInput[], force?: boolean) =>
    ipcRenderer.invoke('workspace:syncToCloud', workspaceId, repos, force),
  workspaceGetRepoState: (workspaceId: string, repoName: string) =>
    ipcRenderer.invoke('workspace:getRepoState', workspaceId, repoName),
  workspaceCheckCloudDelta: (workspaceId: string, repos: Array<{ repoName: string; parsedRepoPath: string }>) =>
    ipcRenderer.invoke('workspace:checkCloudDelta', workspaceId, repos),
  workspaceGetMcpConfig: (workspaceId: string, tool?: string) =>
    ipcRenderer.invoke('workspace:getMcpConfig', workspaceId, tool),
  workspaceUpdateName: (workspaceId: string, name: string) =>
    ipcRenderer.invoke('workspace:updateName', workspaceId, name),
  workspaceListTokens: (workspaceId: string) => ipcRenderer.invoke('workspace:listTokens', workspaceId),
  workspaceCreateToken: (workspaceId: string, name: string) =>
    ipcRenderer.invoke('workspace:createToken', workspaceId, name),
  workspaceGetTokenValue: (workspaceId: string, tokenId: string) =>
    ipcRenderer.invoke('workspace:getTokenValue', workspaceId, tokenId),
  workspaceRevokeToken: (workspaceId: string, tokenId: string) =>
    ipcRenderer.invoke('workspace:revokeToken', workspaceId, tokenId),
  workspaceUploadParsers: (workspaceId: string) => ipcRenderer.invoke('workspace:uploadParsers', workspaceId),

  onAuthChange: (
    callback: (status: { isLoggedIn: boolean; email: string | null; userId: string | null; reason?: string }) => void,
  ) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      status: { isLoggedIn: boolean; email: string | null; userId: string | null; reason?: string },
    ) => {
      callback(status);
    };
    ipcRenderer.on('workspace:authChange', listener);
    return () => {
      ipcRenderer.removeListener('workspace:authChange', listener);
    };
  },

  // Linked Repos
  getLinkedRepos: (workspaceId: string) => ipcRenderer.invoke(IpcChannels.LINKED_REPOS_GET, workspaceId),
  linkRepo: (workspaceId: string, repoName: string) =>
    ipcRenderer.invoke(IpcChannels.LINKED_REPOS_LINK, workspaceId, repoName),
  removeLinkedRepo: (workspaceId: string, repoName: string) =>
    ipcRenderer.invoke(IpcChannels.LINKED_REPOS_REMOVE, workspaceId, repoName),

  // Onboarding
  onboardingListSeen: (userId: string) => ipcRenderer.invoke('onboarding:listSeen', userId),
  onboardingMarkSeen: (userId: string, workspaceId: string) =>
    ipcRenderer.invoke('onboarding:markSeen', userId, workspaceId),

  // Cloud Project
  getCloudRepoStates: (workspaceId: string) => ipcRenderer.invoke('cloud:projectStates', workspaceId),
  generateCloudDoc: (workspaceId: string, repoName: string, promptName: string) =>
    ipcRenderer.invoke('cloud:docsGenerate', workspaceId, repoName, promptName),

  // Intent knowledge base (cloud workspaces only). Channel names are inlined
  // like every other group in this file — preload is sandboxed.
  intentGetTree: (workspaceId: string, query: IntentTreeQuery) =>
    ipcRenderer.invoke('intent:getTree', workspaceId, query),
  intentListDimensions: (workspaceId: string, query: IntentDimensionsQuery) =>
    ipcRenderer.invoke('intent:listDimensions', workspaceId, query),
  intentListFeatures: (workspaceId: string, query: IntentFeaturesQuery) =>
    ipcRenderer.invoke('intent:listFeatures', workspaceId, query),
  intentListFeatureSeeds: (workspaceId: string, featureId: string, query: IntentTreeQuery) =>
    ipcRenderer.invoke('intent:listFeatureSeeds', workspaceId, featureId, query),
  intentListSources: (workspaceId: string, search: string) =>
    ipcRenderer.invoke('intent:listSources', workspaceId, search),
  intentListItems: (workspaceId: string, query: IntentItemsQuery) =>
    ipcRenderer.invoke('intent:listItems', workspaceId, query),
  intentReviewQueue: (workspaceId: string, query: IntentReviewQueueQuery) =>
    ipcRenderer.invoke('intent:reviewQueue', workspaceId, query),
  intentReleasePreviews: (workspaceId: string, itemIds: string[]) =>
    ipcRenderer.invoke('intent:releasePreviews', workspaceId, itemIds),
  intentReleasePreview: (workspaceId: string, itemId: string) =>
    ipcRenderer.invoke('intent:releasePreview', workspaceId, itemId),
  intentReleaseList: (workspaceId: string, beforeSeq?: number) =>
    ipcRenderer.invoke('intent:releaseList', workspaceId, beforeSeq),
  intentReleaseWrite: (workspaceId: string, action: IntentReleaseAction, body: IntentReleaseWrite) =>
    ipcRenderer.invoke('intent:releaseWrite', workspaceId, action, body),
  intentGetContext: (workspaceId: string, query: IntentContextQuery) =>
    ipcRenderer.invoke('intent:getContext', workspaceId, query),
  intentListItemTransitions: (workspaceId: string, itemId: string, query: IntentTransitionsQuery) =>
    ipcRenderer.invoke('intent:listItemTransitions', workspaceId, itemId, query),
  intentListTransitions: (workspaceId: string, query: IntentTransitionsQuery) =>
    ipcRenderer.invoke('intent:listTransitions', workspaceId, query),
  intentReviewItems: (workspaceId: string, body: IntentReviewRequest) =>
    ipcRenderer.invoke('intent:reviewItems', workspaceId, body),
  intentCreateDomain: (workspaceId: string, body: IntentDomainCreateInput) =>
    ipcRenderer.invoke('intent:createDomain', workspaceId, body),
  intentUpdateDomain: (workspaceId: string, body: IntentDomainUpdateInput) =>
    ipcRenderer.invoke('intent:updateDomain', workspaceId, body),
  intentArchiveDomain: (workspaceId: string, body: IntentArchiveInput) =>
    ipcRenderer.invoke('intent:archiveDomain', workspaceId, body),
  intentDeleteDomain: (workspaceId: string, body: IntentDeleteInput) =>
    ipcRenderer.invoke('intent:deleteDomain', workspaceId, body),
  intentCreateFeature: (workspaceId: string, body: IntentFeatureCreateInput) =>
    ipcRenderer.invoke('intent:createFeature', workspaceId, body),
  intentUpdateFeature: (workspaceId: string, body: IntentFeatureUpdateInput) =>
    ipcRenderer.invoke('intent:updateFeature', workspaceId, body),
  intentArchiveFeature: (workspaceId: string, body: IntentArchiveInput) =>
    ipcRenderer.invoke('intent:archiveFeature', workspaceId, body),
  intentDeleteFeature: (workspaceId: string, body: IntentDeleteInput) =>
    ipcRenderer.invoke('intent:deleteFeature', workspaceId, body),
  intentPutSeed: (workspaceId: string, body: IntentSeedPutInput) =>
    ipcRenderer.invoke('intent:putSeed', workspaceId, body),
  intentDeleteSeed: (workspaceId: string, body: IntentSeedDeleteInput) =>
    ipcRenderer.invoke('intent:deleteSeed', workspaceId, body),
  intentRefreshAnchor: (workspaceId: string, body: IntentAnchorRefreshInput) =>
    ipcRenderer.invoke('intent:refreshAnchor', workspaceId, body),
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
