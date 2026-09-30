import * as React from 'react';
import { Dialog, DialogContent, DialogHeader, DialogBody, DialogFooter, DialogTitle } from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { useProjectsStore } from '../stores/projects-store';
import type { Project } from '../types/project';

interface EditProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project | null;
}

export function EditProjectDialog({ open, onOpenChange, project }: EditProjectDialogProps) {
  const [name, setName] = React.useState('');
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const updateProject = useProjectsStore((state) => state.updateProject);

  // Reset form when dialog opens with project data
  React.useEffect(() => {
    if (open && project) {
      setName(project.name);
      setIsSubmitting(false);
    }
  }, [open, project]);

  const isValid = name.trim().length > 0;
  const hasChanged = project ? name.trim() !== project.name : false;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!isValid || !hasChanged || isSubmitting || !project) return;

    setIsSubmitting(true);

    try {
      await updateProject(project.id, { name: name.trim() });
      onOpenChange(false);
    } catch (error) {
      console.error('Failed to update project:', error);
    } finally {
      setIsSubmitting(false);
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
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Edit Name</DialogTitle>
          </DialogHeader>

          <DialogBody>
            <div className="grid gap-2">
              <Label htmlFor="project-name">Workspace name</Label>
              <Input
                id="project-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Enter workspace name"
                autoFocus
                disabled={isSubmitting}
              />
            </div>
          </DialogBody>

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={handleCancel} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={!isValid || !hasChanged || isSubmitting}>
              {isSubmitting ? 'Updating...' : 'Update'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
