import * as React from 'react';
import { AddFolder, TrashBinTrash } from '@solar-icons/react';
import { Dialog, DialogContent, DialogHeader, DialogBody, DialogFooter, DialogTitle } from './ui/dialog';
import { Button } from './ui/button';
import { useProjectsStore } from '../stores/projects-store';
import { useProjectDetailStore } from '../stores/project-detail-store';
import { getBaseName } from '../utils/platform';

interface RepoRow {
  name: string;
  path: string;
}

interface AddRepositoryToProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  existingRepos: RepoRow[];
  onApplied?: (addedNames: string[]) => void | Promise<void>;
  /** True when every repo in the project is in the not_started state. Drives the CTA label. */
  allReposNotStarted?: boolean;
  /** Folder paths to pre-populate the row list with on open. Used by the
   *  "open file picker first, then dialog" flow so the user doesn't have to
   *  click an extra button after picking folders. */
  initialPaths?: string[];
}

function buildRowsFromPaths(paths: string[], reservedPaths: Set<string>, reservedNames: Set<string>): RepoRow[] {
  const additions: RepoRow[] = [];
  for (const p of paths) {
    if (reservedPaths.has(p)) continue;
    let candidate = getBaseName(p);
    if (reservedNames.has(candidate)) {
      let i = 2;
      while (reservedNames.has(`${candidate}-${i}`)) i += 1;
      candidate = `${candidate}-${i}`;
    }
    reservedNames.add(candidate);
    reservedPaths.add(p);
    additions.push({ name: candidate, path: p });
  }
  return additions;
}

export function AddRepositoryToProjectDialog({
  open,
  onOpenChange,
  projectId,
  existingRepos,
  onApplied,
  allReposNotStarted = true,
  initialPaths,
}: AddRepositoryToProjectDialogProps) {
  const [rows, setRows] = React.useState<RepoRow[]>([]);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const loadProjects = useProjectsStore((state) => state.loadProjects);

  React.useEffect(() => {
    if (open) {
      // Seed the row list from any pre-picked paths (provided by the caller
      // when the file picker opens before this dialog).
      const seedPaths = initialPaths ?? [];
      const reservedPaths = new Set(existingRepos.map((r) => r.path));
      const reservedNames = new Set(existingRepos.map((r) => r.name));
      setRows(buildRowsFromPaths(seedPaths, reservedPaths, reservedNames));
      setIsSubmitting(false);
      setError(null);
    }
    // existingRepos / initialPaths intentionally excluded — only re-seed when
    // the dialog transitions open. Re-seeding mid-edit would clobber additions
    // the user made via "Add another repository".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const hasChanges = rows.length > 0;
  const submitLabel = allReposNotStarted
    ? rows.length > 1
      ? 'Add Repos'
      : 'Add Repo'
    : rows.length > 1
      ? 'Add & Parse Repos'
      : 'Add & Parse Repo';

  const handleAddFolders = async () => {
    setError(null);
    const result = await window.electronAPI.selectFolders();
    if (!result.success || !result.paths || result.paths.length === 0) return;

    const reservedPaths = new Set([...rows.map((r) => r.path), ...existingRepos.map((r) => r.path)]);
    const reservedNames = new Set([...rows.map((r) => r.name), ...existingRepos.map((r) => r.name)]);
    const additions = buildRowsFromPaths(result.paths, reservedPaths, reservedNames);
    if (additions.length > 0) {
      setRows((prev) => [...prev, ...additions]);
    }
  };

  const handleRemoveRow = (name: string) => {
    setError(null);
    setRows((prev) => prev.filter((r) => r.name !== name));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!hasChanges || isSubmitting) return;

    setIsSubmitting(true);
    setError(null);

    try {
      const loadResult = await window.electronAPI.loadConfig();
      if (!loadResult.success || !loadResult.config) {
        throw new Error('Failed to load config');
      }
      const config = loadResult.config;
      const project = config.projects.find((p) => p.id === projectId);
      if (!project) throw new Error(`Project "${projectId}" not found in config`);
      const projectNames = new Set(project.repos.map((r) => r.name));
      for (const row of rows) {
        if (project.repos.some((r) => r.path === row.path)) continue;
        if (projectNames.has(row.name)) {
          throw new Error(`A repo named "${row.name}" already exists in this workspace.`);
        }
        project.repos.push({ name: row.name, path: row.path });
        projectNames.add(row.name);
      }
      const saveResult = await window.electronAPI.saveConfig(config);
      if (!saveResult.success) {
        throw new Error(saveResult.error || 'Failed to save config');
      }

      await loadProjects();

      const updatedProject = useProjectsStore.getState().projects.find((p) => p.id === projectId);
      if (updatedProject) {
        await useProjectDetailStore.getState().loadRepoStates(updatedProject.repositories.map((r) => r.name));
      }

      await onApplied?.(rows.map((r) => r.name));

      onOpenChange(false);
    } catch (err) {
      console.error('Failed to add repositories:', err);
      setError(err instanceof Error ? err.message : 'Failed to add repositories');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {/* `min-w-0`: the form is DialogContent's only grid item, and a grid item
            defaults to `min-width: auto` — it refuses to shrink below its content's
            intrinsic width, so a long repo path widened the form past the 480px panel
            and everything in it got clipped at the edge. */}
        <form onSubmit={handleSubmit} className="min-w-0">
          <DialogHeader>
            <DialogTitle>Add new repository</DialogTitle>
          </DialogHeader>

          <DialogBody className="gap-2">
            <div className="flex items-end justify-between gap-2">
              <span className="min-w-0 truncate py-1 text-sm leading-5 text-content-secondary">Repository source:</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={handleAddFolders}
                disabled={isSubmitting}
              >
                <AddFolder className="size-4" />
                Add another repository
              </Button>
            </div>

            <div className="rounded-sm border border-border-input bg-selago-50 overflow-hidden">
              <div className="flex items-start">
                <div className="h-10 w-[150px] flex items-center px-2 py-2.5 text-sm leading-5 text-content-tertiary">
                  Repo-name
                </div>
                <div className="h-10 min-w-0 flex-1 flex items-center px-2 py-2.5 text-sm leading-5 text-content-tertiary">
                  Location
                </div>
                <div className="w-8 shrink-0" />
              </div>

              {rows.length === 0 ? (
                <div className="border-t border-border-input px-3 py-4 text-center text-xs text-content-quaternary">
                  Click &quot;Add another repository&quot; to select a folder.
                </div>
              ) : (
                <div
                  // `overflow-x-hidden` is explicit: `overflow-y-auto` alone leaves the
                  // x-axis computing to auto, which lets the rows lay out at their
                  // max-content width and scroll sideways instead of truncating.
                  className="max-h-[240px] overflow-y-auto overflow-x-hidden scrollbar-thin pb-1"
                >
                  {rows.map((row) => (
                    <div key={row.path} className="flex items-start border-t border-border-input pr-1.5">
                      <div className="w-[150px] flex items-center px-2 py-1.5 text-sm leading-5 font-medium text-content-primary truncate">
                        <span className="truncate" title={row.name}>
                          {row.name}
                        </span>
                      </div>
                      <div className="flex-1 min-w-0 flex items-center px-2 py-1.5 text-sm leading-5 text-content-primary">
                        <span className="truncate" title={row.path}>
                          {row.path}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="w-8 self-stretch flex items-center justify-center rounded-sm text-content-warning hover:bg-bg-primary-hover disabled:opacity-50"
                        onClick={() => handleRemoveRow(row.name)}
                        disabled={isSubmitting}
                        aria-label={`Remove ${row.name}`}
                      >
                        <TrashBinTrash className="size-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {error && <p className="text-xs text-content-warning">{error}</p>}
          </DialogBody>

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={!hasChanges || isSubmitting}>
              {isSubmitting ? 'Applying...' : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
