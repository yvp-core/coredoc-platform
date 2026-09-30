import * as React from 'react';
import { Dialog, DialogContent, DialogHeader, DialogBody, DialogFooter, DialogTitle } from './ui/dialog';
import { Button } from './ui/button';
import { useProjectsStore } from '../stores/projects-store';
import type { Project } from '../types/project';

interface DeleteProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project | null;
}

export function DeleteProjectDialog({ open, onOpenChange, project }: DeleteProjectDialogProps) {
  const [isDeleting, setIsDeleting] = React.useState(false);
  const deleteProject = useProjectsStore((state) => state.deleteProject);

  // Reset state when dialog opens/closes
  React.useEffect(() => {
    if (open) {
      setIsDeleting(false);
    }
  }, [open]);

  const handleDelete = async () => {
    if (isDeleting || !project) return;

    setIsDeleting(true);

    try {
      await deleteProject(project.id);
      onOpenChange(false);
    } catch (error) {
      console.error('Failed to delete project:', error);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleCancel = () => {
    onOpenChange(false);
  };

  // Don't render if no project is provided
  if (!project) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {project.name}</DialogTitle>
        </DialogHeader>

        <DialogBody>
          <div className="text-sm text-content-primary">You're about to delete the project?</div>
          <div className="text-xs text-content-secondary">This action cannot be undone.</div>
        </DialogBody>

        <DialogFooter>
          <Button type="button" variant="secondary" onClick={handleCancel} disabled={isDeleting}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={handleDelete} disabled={isDeleting}>
            {isDeleting ? 'Deleting...' : 'Delete'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
