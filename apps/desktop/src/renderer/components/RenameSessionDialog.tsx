import * as React from 'react';
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
import { Input } from './ui/input';
import { Label } from './ui/label';

interface RenameSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentName: string;
  onRename: (newName: string) => Promise<void>;
}

export function RenameSessionDialog({ open, onOpenChange, currentName, onRename }: RenameSessionDialogProps) {
  const [name, setName] = React.useState('');
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  // Reset form when dialog opens
  React.useEffect(() => {
    if (open) {
      setName(currentName);
      setIsSubmitting(false);
    }
  }, [open, currentName]);

  const isValid = name.trim().length > 0;
  const hasChanged = name.trim() !== currentName;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!isValid || !hasChanged || isSubmitting) return;

    setIsSubmitting(true);

    try {
      await onRename(name.trim());
      onOpenChange(false);
    } catch (error) {
      console.error('Failed to rename session:', error);
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
            <DialogTitle>Rename Chat</DialogTitle>
            <DialogDescription>Give this chat session a new name.</DialogDescription>
          </DialogHeader>

          <DialogBody>
            <div className="grid gap-2">
              <Label htmlFor="session-name">Chat name</Label>
              <Input
                id="session-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Enter chat name"
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
              {isSubmitting ? 'Renaming...' : 'Rename'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
