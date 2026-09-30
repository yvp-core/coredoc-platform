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

interface DeleteSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionName: string;
  onDelete: () => Promise<void>;
}

export function DeleteSessionDialog({ open, onOpenChange, sessionName, onDelete }: DeleteSessionDialogProps) {
  const [isDeleting, setIsDeleting] = React.useState(false);

  // Reset state when dialog closes
  React.useEffect(() => {
    if (!open) {
      setIsDeleting(false);
    }
  }, [open]);

  const handleDelete = async () => {
    if (isDeleting) return;

    setIsDeleting(true);

    try {
      await onDelete();
      onOpenChange(false);
    } catch (error) {
      console.error('Failed to delete session:', error);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleCancel = () => {
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-bg-warning/10">
              <AlertTriangle className="h-5 w-5 text-content-warning" />
            </div>
            <div>
              <DialogTitle>Delete Chat</DialogTitle>
              <DialogDescription>This action cannot be undone</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <DialogBody>
          <p className="text-sm text-content-secondary">
            Are you sure you want to delete <strong>{sessionName}</strong>?
          </p>
          <p className="text-sm text-content-secondary">All messages in this chat will be permanently deleted.</p>
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
