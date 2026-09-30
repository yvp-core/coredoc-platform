import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogBody, DialogFooter, DialogTitle } from './ui/dialog';
import { Button } from './ui/button';
import type { McpInfoResult } from '../../shared/ipc-types';
import { McpConfigView } from './McpConfigView';
import { cn } from '../lib/utils';

// ---------------------------------------------------------------------------
// McpConnectDialog
// ---------------------------------------------------------------------------

interface McpConnectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  /**
   * 'manual' (default) → triggered by the "Connect MCP" button. Header "Your graph is ready",
   * footer shows the "Close" CTA.
   * 'first-completion' → auto-opened once after the wizard finishes. Header "Your Graph is ready!",
   * single "Finish Setup" CTA.
   */
  variant?: 'manual' | 'first-completion';
}

export function McpConnectDialog({ open, onOpenChange, projectId, variant = 'manual' }: McpConnectDialogProps) {
  const [mcpInfo, setMcpInfo] = useState<McpInfoResult | null>(null);
  const isFirstCompletion = variant === 'first-completion';

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      window.electronAPI.getMcpInfo(projectId).then(setMcpInfo);
    }
  }, [open, projectId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          'max-h-[85vh] flex flex-col overflow-hidden',
          // After-wizard "Finish setup" flow shows a single tab at a time and
          // is constrained to 640px; the manual "Connect MCP" entry stays wider.
          isFirstCompletion ? 'sm:max-w-[640px]' : 'sm:max-w-[954px]',
        )}
      >
        <DialogHeader>
          <DialogTitle>{isFirstCompletion ? 'Your Graph is ready!' : 'Local MCP Server'}</DialogTitle>
          <p className="text-sm text-content-primary">Add this Local MCP server to your AI client.</p>
        </DialogHeader>

        <DialogBody className="flex-1 overflow-y-auto min-h-0">
          <McpConfigView mcpInfo={mcpInfo} />
        </DialogBody>

        <DialogFooter className="shrink-0">
          {isFirstCompletion ? (
            <Button variant="default" onClick={() => onOpenChange(false)}>
              Finish Setup
            </Button>
          ) : (
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
