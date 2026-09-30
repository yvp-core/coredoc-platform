import * as React from 'react';
import { AlertTriangle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from './ui/dialog';
import { Button } from './ui/button';
import { useProjectsStore } from '../stores/projects-store';
import { useProjectDetailStore } from '../stores/project-detail-store';

interface RemoveRepositoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  repositoryName: string | null;
}

export function RemoveRepositoryDialog({ open, onOpenChange, projectId, repositoryName }: RemoveRepositoryDialogProps) {
  const [isRemoving, setIsRemoving] = React.useState(false);
  const loadProjects = useProjectsStore((state) => state.loadProjects);

  // Reset state when dialog closes
  React.useEffect(() => {
    if (!open) {
      setIsRemoving(false);
    }
  }, [open]);

  const handleRemove = async () => {
    if (!repositoryName || isRemoving) return;

    setIsRemoving(true);

    try {
      // Call the IPC to remove repository with cleanup
      const result = await window.electronAPI.removeRepository(projectId, repositoryName);

      if (!result.success) {
        throw new Error(result.error || 'Failed to remove repository');
      }

      // Drop any per-repo cancel flag so a future repo with the same name
      // doesn't inherit a stale "Start parsing" affordance.
      useProjectDetailStore.getState().forgetRepo(repositoryName);

      // Reload projects to reflect changes
      await loadProjects();

      onOpenChange(false);
    } catch (error) {
      console.error('Failed to remove repository:', error);
    } finally {
      setIsRemoving(false);
    }
  };

  const handleCancel = () => {
    onOpenChange(false);
  };

  if (!repositoryName) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-bg-warning/10">
              <AlertTriangle className="h-5 w-5 text-content-warning" />
            </div>
            <div>
              <DialogTitle>Remove Repository</DialogTitle>
              <DialogDescription>This action cannot be undone</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <DialogBody>
          <p className="text-sm text-content-secondary">
            Are you sure you want to remove <strong>{repositoryName}</strong> from this project?
          </p>
          <p className="text-sm text-content-secondary">This will:</p>
          <ul className="text-sm text-content-secondary list-disc list-inside space-y-1">
            <li>Remove the repository from the project configuration</li>
            <li>Delete the generated parser files</li>
            <li>Delete the parsed and summarized output files</li>
          </ul>
        </DialogBody>

        <DialogFooter>
          <Button type="button" variant="secondary" onClick={handleCancel} disabled={isRemoving}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={handleRemove} disabled={isRemoving}>
            {isRemoving ? 'Removing...' : 'Remove'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
