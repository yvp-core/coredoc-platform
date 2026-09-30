import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { Dialog, DialogContent, DialogHeader, DialogBody, DialogFooter, DialogTitle } from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { useProjectsStore } from '../stores/projects-store';
import { FolderSelector } from './FolderSelector';
import type { NewFolderInput } from '../types/project';
import { Label } from './ui/label';

interface AddProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AddProjectDialog({ open, onOpenChange }: AddProjectDialogProps) {
  const navigate = useNavigate();
  const [name, setName] = React.useState('');
  const [selectedFolders, setSelectedFolders] = React.useState<NewFolderInput[]>([]);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const addProject = useProjectsStore((state) => state.addProject);
  const loadProjects = useProjectsStore((state) => state.loadProjects);
  const projects = useProjectsStore((state) => state.projects);

  // Reset form and load available repos when dialog opens
  React.useEffect(() => {
    if (open) {
      setName('');
      setSelectedFolders([]);
      setIsSubmitting(false);
      loadProjects(); // Refresh available repos
    }
  }, [open, loadProjects]);

  // Duplicate-name detection — surface the error inline (under the input) once
  // the user has typed something. Comparison is trimmed + case-insensitive.
  const trimmedName = name.trim();
  const isDuplicateName = React.useMemo(() => {
    if (trimmedName.length === 0) return false;
    const lower = trimmedName.toLowerCase();
    return projects.some((p) => p.name.trim().toLowerCase() === lower);
  }, [trimmedName, projects]);

  const isValid = trimmedName.length > 0 && !isDuplicateName && selectedFolders.length > 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!isValid || isSubmitting) return;

    setIsSubmitting(true);

    try {
      const project = await addProject({
        name: name.trim(),
        newFolders: selectedFolders,
      });
      onOpenChange(false);
      navigate(`/project/${encodeURIComponent(project.id)}`);
    } catch (error) {
      console.error('Failed to create project:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancel = () => {
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Create new workspace</DialogTitle>
          </DialogHeader>

          <DialogBody>
            <div className="grid gap-2">
              <Label htmlFor="project-name" className="text-sm">
                Workspace name
              </Label>
              <Input
                id="project-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Enter workspace name"
                autoFocus
                disabled={isSubmitting}
                aria-invalid={isDuplicateName || undefined}
              />
              {isDuplicateName && (
                <p className="text-xs text-content-warning">
                  A workspace named &quot;{trimmedName}&quot; already exists. Choose a different name.
                </p>
              )}
            </div>

            <FolderSelector
              selectedFolders={selectedFolders}
              onFoldersChange={setSelectedFolders}
              disabled={isSubmitting}
            />
          </DialogBody>

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={handleCancel} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={!isValid || isSubmitting}>
              {isSubmitting ? 'Creating...' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
