/**
 * Project Types for the Projects feature
 *
 * Defines data models for projects and their associated repositories,
 * including repository workflow status states.
 */

// =============================================================================
// Repository Status
// =============================================================================

/**
 * Represents the current workflow status of a repository within a project.
 * Each status indicates a different stage in the parsing/syncing pipeline.
 */
export type RepositoryStatus =
  | 'checking'
  | 'status_unavailable'
  | 'not_started'
  | 'parser_creation'
  | 'parsing'
  | 'parsed'
  | 'parsed_pending_review'
  | 'approved'
  | 'approval_stale'
  | 'summarising'
  | 'summarised'
  | 'creating_graph'
  | 'graph_up_to_date'
  | 'graph_needs_update'
  | 'updating_graph';

/**
 * Status values that indicate an ongoing operation (show loading spinner).
 */
export const LOADING_STATUSES: RepositoryStatus[] = [
  'parser_creation',
  'parsing',
  'summarising',
  'creating_graph',
  'updating_graph',
];

/**
 * Check if a status represents a loading/in-progress state.
 */
export function isLoadingStatus(status: RepositoryStatus): boolean {
  return LOADING_STATUSES.includes(status);
}

// =============================================================================
// Project Repository
// =============================================================================

/**
 * Represents a repository within a project.
 */
export interface ProjectRepository {
  /** Unique identifier for the repository within the project */
  id: string;
  /** Repository name in "org/repo-name" format */
  name: string;
  /** Repository path */
  path: string;
  /** Current workflow status of the repository */
  status: RepositoryStatus;
  /**
   * Per-repo HTTP prefix (e.g. '/v3/management/shifts'). Mirrors
   * `RepoConfigSerialized.httpPrefix`. Carried on this denormalised renderer
   * shape so cloud sync (CompletedView / ConnectTeamMcpWizard) can forward
   * it through to `workspaceSyncToCloud` — otherwise the field is stripped
   * when projecting CoredocConfigSerialized → renderer state.
   */
  httpPrefix?: string;
}

// =============================================================================
// Project
// =============================================================================

/**
 * Represents a project containing multiple repositories.
 */
export interface Project {
  /** Unique identifier for the project */
  id: string;
  /** User-defined project name */
  name: string;
  /** ISO 8601 timestamp of when the project was created */
  createdAt: string;
  /** ISO 8601 timestamp of the last successful graph sync (optional) */
  lastSyncAt?: string;
  /** List of repositories associated with this project */
  repositories: ProjectRepository[];
  /** Cloud sync state */
  cloud?: { enabled: boolean; workspaceId?: string; lastSyncedAt?: string };
  /** Present when user is a cloud member (not admin/owner) of this workspace */
  cloudMember?: { workspaceId: string };
  /** Whether the project wizard has been completed */
  wizardCompleted?: boolean;
}

// =============================================================================
// Project Store Types
// =============================================================================

/**
 * Input for creating a new project.
 */
export interface CreateProjectInput {
  name: string;
  newFolders?: NewFolderInput[];
}

/**
 * Input for updating an existing project.
 */
export interface UpdateProjectInput {
  name?: string;
  lastSyncAt?: string;
}

/**
 * Input for adding a repository to a project.
 */
export interface AddRepositoryInput {
  name: string;
  path: string;
  status?: RepositoryStatus;
}

/**
 * Input for a newly selected folder to be added as a repo.
 */
export interface NewFolderInput {
  path: string;
  name: string;
  type?: 'backend' | 'frontend' | 'mobile' | 'library';
}
