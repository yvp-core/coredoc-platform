import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { Button } from '../components/ui/button';
import { PageHeader } from '../components/AppLayout';
import { useProjectsStore } from '../stores/projects-store';
import { useProjectDetailStore } from '../stores/project-detail-store';
import { useCloudProjectDetailStore } from '../stores/cloud-project-detail-store';
import { useChatStore } from '../stores/chat-store';
import { EditProjectDialog } from '../components/EditProjectDialog';
import { AddRepositoryToProjectDialog } from '../components/AddRepositoryToProjectDialog';
import { RemoveRepositoryDialog } from '../components/RemoveRepositoryDialog';
import { RenameSessionDialog } from '../components/RenameSessionDialog';
import { DeleteSessionDialog } from '../components/DeleteSessionDialog';
import { McpConnectDialog } from '../components/McpConnectDialog';
import { WizardView } from './views/WizardView';
import { CompletedView } from './views/CompletedView';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { deriveRepoStatus } from '../lib/repo-status';

// Stable empty Set used as the canceledRepos value for cloud members so the
// referential identity doesn't churn each render (would re-trigger memos
// downstream).
const EMPTY_CANCELED_REPOS: Set<string> = new Set();

export function ProjectDetailPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const project = useProjectsStore((s) => (projectId ? s.projects.find((p) => p.id === projectId) : undefined));
  const storeInitialized = useProjectsStore((s) => s.initialized);
  const loadProjects = useProjectsStore((s) => s.loadProjects);
  const isCloudMember = !!project?.cloudMember;

  const {
    setProjectId,
    loadRepoStates,
    repoStates,
    activeTerminalRepo,
    runningCommands,
    terminalClearCounter,
    terminalRepoNames,
    runCommand,
    cancelCommand,
    cancelAllCommands,
    runBatchCommand,
    setActiveTerminalRepo,
    isLoading,
    wizardCompleted,
    contextSelection,
    setContextSelection,
    graphReadyModalShown,
    markGraphReadyModalShown,
    canceledRepos,
  } = useProjectDetailStore();

  // Cloud member store — use selectors for stable references
  const cloudInit = useCloudProjectDetailStore((s) => s.init);
  const cloudLoading = useCloudProjectDetailStore((s) => s.loading);
  const cloudRepoDetailStates = useCloudProjectDetailStore((s) => s.repoDetailStates);
  const {
    setProjectId: setChatProjectId,
    sessions,
    sessionId,
    loadSessions,
    loadSession,
    createSession,
    deleteSession,
    renameSession,
  } = useChatStore();

  // Dialog states
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [addRepoDialogOpen, setAddRepoDialogOpen] = useState(false);
  // Folders pre-selected in the file picker before the dialog opens — they
  // seed the dialog's row list so the user doesn't have to pick again.
  const [addRepoInitialPaths, setAddRepoInitialPaths] = useState<string[]>([]);
  const [removeRepoDialogOpen, setRemoveRepoDialogOpen] = useState(false);
  const [selectedRepoName, setSelectedRepoName] = useState<string | null>(null);

  // MCP connect dialog — variant tracks why it opened so we can render the right footer/title.
  const [mcpConnectOpen, setMcpConnectOpen] = useState(false);
  const [mcpConnectVariant, setMcpConnectVariant] = useState<'manual' | 'first-completion'>('manual');

  // Session dialog states
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  const removeRepoDialogPrevOpen = useRef(false);

  // Load states when project changes
  useEffect(() => {
    if (project) {
      setProjectId(project.id);
      setChatProjectId(project.id);
      if (isCloudMember) {
        // Cloud member — use cloud store instead
        cloudInit(project.cloudMember!.workspaceId);
      } else {
        const repoNames = project.repositories.map((r) => r.name);
        loadRepoStates(repoNames);
      }
    }
  }, [project, setProjectId, setChatProjectId, loadRepoStates, isCloudMember, cloudInit]);

  // Reload after remove (not on mount)
  useEffect(() => {
    if (removeRepoDialogPrevOpen.current && !removeRepoDialogOpen && project) {
      loadProjects();
    }
    removeRepoDialogPrevOpen.current = removeRepoDialogOpen;
  }, [removeRepoDialogOpen, loadProjects, project]);

  // One-time "Your graph is ready" modal when the workspace first transitions to completed.
  // Suppressed for cloud members (they don't run the local wizard flow).
  useEffect(() => {
    if (!project || isCloudMember) return;
    if (wizardCompleted && !graphReadyModalShown) {
      setMcpConnectVariant('first-completion');
      setMcpConnectOpen(true);
    }
  }, [project, isCloudMember, wizardCompleted, graphReadyModalShown]);

  // Load sessions on mount or projectId change
  useEffect(() => {
    if (!project) return;
    const initSessions = async () => {
      await loadSessions(project.id);
      const { sessions: loadedSessions, sessionId: currentSessionId } = useChatStore.getState();
      if (!currentSessionId) {
        if (loadedSessions.length > 0) {
          await loadSession(loadedSessions[0].id);
        } else {
          await handleNewSession();
        }
      }
    };
    initSessions();
  }, [project?.id, loadSessions, loadSession, createSession, project]);

  const handleRemoveRepo = (repoName: string) => {
    setSelectedRepoName(repoName);
    setRemoveRepoDialogOpen(true);
  };

  // True while the OS folder picker is open. Drives a blur backdrop so the
  // app behind the picker matches the look of dialog flows.
  const [pickingFoldersForAdd, setPickingFoldersForAdd] = useState(false);

  // "Add new repository" — open the file picker first. If the user cancels,
  // do nothing (no dialog). If they pick folders, open the dialog with those
  // folders already populated as rows.
  const handleAddRepo = useCallback(async () => {
    setPickingFoldersForAdd(true);
    try {
      const result = await window.electronAPI.selectFolders();
      if (!result.success || !result.paths || result.paths.length === 0) return;
      setAddRepoInitialPaths(result.paths);
      setAddRepoDialogOpen(true);
    } finally {
      setPickingFoldersForAdd(false);
    }
  }, []);

  const handleRepoEditorApplied = useCallback(
    async (addedNames: string[]) => {
      if (addedNames.length === 0) return;
      // In wizard mode with every repo still not_started, the main "Parse Repositories"
      // button handles parsing — the dialog only adds. Skip the auto-trigger here.
      const states = useProjectDetailStore.getState().repoStates;
      const running = useProjectDetailStore.getState().runningCommands;
      const allNotStarted = Array.from(states.entries()).every(([name, s]) => {
        const runningForRepo = Array.from(running.values()).find((c) => c.repoName === name);
        return deriveRepoStatus(s, runningForRepo?.action) === 'not_started';
      });
      const inWizard = !useProjectDetailStore.getState().wizardCompleted;
      const skipAutoParse = inWizard && allNotStarted;

      if (!skipAutoParse) {
        // Auto-select the first added repo so the right panel shows its parsing terminal full-screen.
        useProjectDetailStore.getState().setContextSelection({ kind: 'repo', repoName: addedNames[0] });
        await runBatchCommand(0);
      }
    },
    [runBatchCommand],
  );

  const handleRenameProject = async (newName: string) => {
    if (project) {
      const updated = await useProjectsStore.getState().updateProject(project.id, { name: newName });
      if (updated && updated.id !== project.id) {
        navigate(`/project/${encodeURIComponent(updated.id)}`, { replace: true });
      }
    }
  };

  // Session handlers
  const handleNewSession = useCallback(async () => {
    if (!project) return;

    const emptySession = [...sessions]
      .filter((s) => s.messageCount === 0)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];

    const { messages, isLoading, isDirty, sessionId: storeSessionId, saveSession } = useChatStore.getState();
    const hasLocalActivity = messages.length > 0 || isLoading || messages.some((m) => m.isStreaming);

    if (emptySession) {
      if (emptySession.id !== sessionId) {
        await loadSession(emptySession.id);
        return;
      }
      // Same session is listed empty (messageCount not updated yet) but the
      // renderer already has messages (e.g. docs gen — isLoading stays false).
      // Old code returned here and never created a session.
      if (!hasLocalActivity) {
        return;
      }
    }

    if (isDirty && storeSessionId) {
      await saveSession();
    }
    await createSession(project.id);
  }, [project, sessions, sessionId, loadSession, createSession]);

  const handleSelectSession = async (id: string) => {
    await loadSession(id);
  };

  const handleRenameClick = (id: string) => {
    setSelectedSessionId(id);
    setRenameDialogOpen(true);
  };

  const handleDeleteClick = (id: string) => {
    setSelectedSessionId(id);
    setDeleteDialogOpen(true);
  };

  const handleRenameConfirm = async (newName: string) => {
    if (selectedSessionId) {
      await renameSession(selectedSessionId, newName);
    }
  };

  const handleDeleteConfirm = async () => {
    if (selectedSessionId && project) {
      const deleted = await deleteSession(selectedSessionId);
      if (deleted) {
        const { sessionId: currentId } = useChatStore.getState();
        if (!currentId) {
          await createSession(project.id);
        }
      }
    }
  };

  const selectedSession = sessions.find((s) => s.id === selectedSessionId);

  if (!storeInitialized) {
    return (
      <>
        <PageHeader>
          <div className="flex items-center gap-2">
            <Loader2 className="size-4 animate-spin" />
            <p className="text-content-secondary">Loading...</p>
          </div>
        </PageHeader>
      </>
    );
  }

  if (!project) {
    return (
      <>
        <PageHeader>
          <p className="text-content-secondary">Workspace not found</p>
        </PageHeader>
        <div className="flex-1 overflow-auto p-6">
          <div className="text-center py-12">
            <Button variant="link" onClick={() => navigate('/')}>
              Return to workspaces
            </Button>
          </div>
        </div>
      </>
    );
  }

  // For cloud members, use cloud store states, no-op commands
  const effectiveRepoStates = isCloudMember ? cloudRepoDetailStates : repoStates;
  const effectiveRunningCommands = runningCommands;
  // Cloud members can't cancel anything (no commands run), so the canceled
  // set is always empty for them.
  const effectiveCanceledRepos = isCloudMember ? EMPTY_CANCELED_REPOS : canceledRepos;

  // Shared props for both views
  const sharedProps = {
    project,
    repoStates: effectiveRepoStates,
    runningCommands: effectiveRunningCommands,
    canceledRepos: effectiveCanceledRepos,
    activeTerminalRepo,
    terminalClearCounter,
    terminalRepoNames,
    isLoading: isCloudMember ? cloudLoading : isLoading,
    runCommand,
    cancelCommand,
    cancelAllCommands,
    runBatchCommand,
    setActiveTerminalRepo,
    onAddRepo: handleAddRepo,
    onRemoveRepo: handleRemoveRepo,
    sessions,
    sessionId,
    onNewSession: handleNewSession,
    onSelectSession: handleSelectSession,
    onRenameSession: handleRenameClick,
    onDeleteSession: handleDeleteClick,
    onNavigateHome: () => navigate('/'),
    onEditProject: () => setEditDialogOpen(true),
    onRenameProject: handleRenameProject,
  };

  // Cloud members always go to CompletedView (skip wizard)
  const effectiveLoading = isCloudMember ? cloudLoading : isLoading;
  const showCompleted = isCloudMember || wizardCompleted;

  // Show loader while repo states are loading to prevent wizard → completed view flicker
  if (effectiveLoading && effectiveRepoStates.size === 0) {
    return (
      <>
        <PageHeader>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => navigate('/')}>
              &larr;
            </Button>
            <h1 className="text-lg font-bold truncate">{project.name}</h1>
          </div>
        </PageHeader>
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="size-6 animate-spin text-content-secondary" />
            <p className="text-sm text-content-secondary">Loading workspace...</p>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      {showCompleted ? (
        <CompletedView
          // Keyed by workspace: switching workspaces is entering a different workspace,
          // not scrolling within one. Without the key the view stays mounted across the
          // route change and carries the previous workspace's tab and panel state over,
          // which is why switching used to land on whatever tab you left behind.
          key={project.id}
          {...sharedProps}
          contextSelection={contextSelection}
          setContextSelection={setContextSelection}
          isCloudMember={isCloudMember}
          cloudWorkspaceId={project.cloudMember?.workspaceId}
        />
      ) : (
        <WizardView {...sharedProps} />
      )}

      {/* Blur backdrop while the OS folder picker is open. We piggy-back on the
          real radix Dialog overlay (same primitive the actual dialogs use), so
          the visual is identical and Radix manages mount/unmount + body lock
          cleanup — replacing a manual fixed div that could leave the screen
          covered if React batched updates oddly. */}
      <DialogPrimitive.Root open={pickingFoldersForAdd} modal>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 duration-100 fixed inset-0 isolate z-50 bg-bg-scrim" />
          {/* Required by radix for a11y, but visually hidden — there's no UI
              to interact with, the OS picker is in front. */}
          <DialogPrimitive.Content className="sr-only">
            <DialogPrimitive.Title>Selecting folders</DialogPrimitive.Title>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>

      {/* Dialogs — hidden for cloud members */}
      {!isCloudMember && (
        <>
          <EditProjectDialog open={editDialogOpen} onOpenChange={setEditDialogOpen} project={project} />
          <AddRepositoryToProjectDialog
            open={addRepoDialogOpen}
            onOpenChange={(open) => {
              setAddRepoDialogOpen(open);
              if (!open) setAddRepoInitialPaths([]);
            }}
            projectId={project.id}
            existingRepos={project.repositories.map((r) => ({ name: r.name, path: r.path }))}
            initialPaths={addRepoInitialPaths}
            onApplied={handleRepoEditorApplied}
            allReposNotStarted={project.repositories.every((r) => {
              const state = effectiveRepoStates.get(r.name);
              const runningForRepo = Array.from(runningCommands.values()).find((c) => c.repoName === r.name);
              return deriveRepoStatus(state, runningForRepo?.action) === 'not_started';
            })}
          />
          <RemoveRepositoryDialog
            open={removeRepoDialogOpen}
            onOpenChange={setRemoveRepoDialogOpen}
            projectId={project.id}
            repositoryName={selectedRepoName}
          />
        </>
      )}
      <RenameSessionDialog
        open={renameDialogOpen}
        onOpenChange={setRenameDialogOpen}
        currentName={selectedSession?.name || ''}
        onRename={handleRenameConfirm}
      />
      <DeleteSessionDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        sessionName={selectedSession?.name || ''}
        onDelete={handleDeleteConfirm}
      />
      {!isCloudMember && (
        <McpConnectDialog
          open={mcpConnectOpen}
          onOpenChange={(open) => {
            setMcpConnectOpen(open);
            // The dialog is now only ever the first-completion auto-open — the
            // manual entry point moved to the docked Local MCP panel.
            if (!open && mcpConnectVariant === 'first-completion' && !graphReadyModalShown) {
              markGraphReadyModalShown();
            }
          }}
          projectId={project.id}
          variant={mcpConnectVariant}
        />
      )}
    </>
  );
}
