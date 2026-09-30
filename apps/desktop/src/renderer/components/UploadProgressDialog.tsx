import { Dialog, DialogContent, DialogHeader, DialogBody, DialogTitle } from './ui/dialog';

interface UploadProgressDialogProps {
  open: boolean;
  title: string;
  description: string;
}

export function UploadProgressDialog({ open, title, description }: UploadProgressDialogProps) {
  return (
    <Dialog open={open}>
      <DialogContent className="sm:max-w-[640px]" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogBody className="text-sm text-content-tertiary">
          {description}
          <div
            role="progressbar"
            aria-label={title}
            aria-valuetext="In progress"
            className="h-1.5 rounded-full bg-bg-overlay overflow-hidden"
          >
            <div className="h-full w-1/3 bg-content-primary animate-indeterminate" />
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
