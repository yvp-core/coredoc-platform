import React from 'react';
import { DocumentText, Refresh, CodeFile, DangerTriangle, MenuDots, TrashBinTrash } from '@solar-icons/react';
import { GitBranch } from 'lucide-react';
import { Input } from './ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogBody,
  DialogTitle,
  DialogFooter,
} from './ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu';
import { Button } from './ui/button';
import { cn } from '../lib/utils';
import { useDocsStore, useFilteredDocs } from '../stores/docs-store';
import type { DocFileInfo, GitRevision } from '../../shared/ipc-types';

interface DocsListViewProps {
  gitRevisions?: Map<string, GitRevision>;
  isFullScreen?: boolean;
}

export function DocsListView({ gitRevisions, isFullScreen }: DocsListViewProps) {
  const searchQuery = useDocsStore((s) => s.searchQuery);
  const setSearchQuery = useDocsStore((s) => s.setSearchQuery);
  const selectDoc = useDocsStore((s) => s.selectDoc);
  const deleteDoc = useDocsStore((s) => s.deleteDoc);
  const filteredDocs = useFilteredDocs();

  return (
    <div className="flex flex-col gap-4 pt-5 pb-6 px-4 items-center">
      {/* Search */}
      <Input
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        placeholder="Search for document"
        className="max-w-[800px] w-full bg-bg-primary border-border-input rounded-lg shadow-field px-3 py-2 h-auto text-sm leading-5 text-content-primary placeholder:text-content-quaternary focus-visible:ring-0 focus-visible:border-border-input-hover"
      />

      {/* Doc cards */}
      <div className={cn('grid gap-1.5 w-full', isFullScreen ? 'grid-cols-2' : 'grid-cols-1')}>
        {filteredDocs.map((doc) => (
          <DocCard
            key={doc.id}
            doc={doc}
            revision={gitRevisions?.get(doc.repoName)}
            onClick={() => selectDoc(doc)}
            onDelete={(e) => {
              e.stopPropagation();
              deleteDoc(doc.repoName, doc.relativePath);
            }}
          />
        ))}

        {filteredDocs.length === 0 && (
          <p className="text-center text-content-quaternary py-8 text-sm">No documents found.</p>
        )}
      </div>
    </div>
  );
}

function DocCard({
  doc,
  revision,
  onClick,
  onDelete,
}: {
  doc: DocFileInfo;
  revision?: GitRevision;
  onClick: () => void;
  onDelete: (e: React.MouseEvent) => void;
}) {
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = React.useState(false);

  const formattedDate = doc.generatedAt ? formatDate(new Date(doc.generatedAt)) : '—';

  return (
    <div
      role="button"
      tabIndex={0}
      className="w-full flex gap-1.5 items-start px-4 py-3 rounded-lg bg-bg-primary border border-white/50 shadow-surface text-left transition-colors hover:border-primary/50 cursor-pointer group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-input-hover"
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
    >
      {/* Icon box */}
      <div className="bg-bg-supportive flex items-center justify-center p-1.5 rounded-sm shrink-0">
        <DocumentText weight="Bold" className="size-4 text-white" />
      </div>

      {/* Content */}
      <div className="flex-1 flex flex-col gap-1.5 min-w-0 pl-2">
        <span className="text-sm font-medium leading-5 tracking-normal text-content-primary truncate">{doc.title}</span>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1">
            <CodeFile className="size-4 text-content-secondary shrink-0" />
            <span className="text-xs leading-4 tracking-normal text-content-secondary whitespace-nowrap">
              {doc.repoName}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <Refresh weight="Bold" className="size-4 text-content-secondary shrink-0" />
            <span className="text-xs leading-4 tracking-normal text-content-secondary whitespace-nowrap">
              {formattedDate}
            </span>
          </div>
          {revision && (
            <span className="flex items-center gap-1 text-xs leading-4 text-content-secondary whitespace-nowrap">
              <GitBranch className="size-3 shrink-0" />
              {revision.branch} @ {revision.commitShortHash}
            </span>
          )}
        </div>
      </div>

      {/* Right side flex wrapper for vertical centering */}
      <div className="flex flex-col justify-center shrink-0 min-h-[40px]">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="wrapper"
              size="icon"
              className="w-4 h-6 shrink-0 ml-auto"
              onClick={(e) => e.stopPropagation()}
            >
              <MenuDots weight="Bold" className="h-2 w-2 rotate-90" />
              <span className="sr-only">Open menu</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
            <DropdownMenuItem
              variant="destructive"
              onClick={(e) => {
                e.stopPropagation();
                setIsDeleteDialogOpen(true);
              }}
            >
              <TrashBinTrash className="size-4" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
          <DialogContent
            onClick={(e) => e.stopPropagation()}
            onInteractOutside={(e) => {
              // Without this, clicking outside the dialog will immediately trigger the underlying card
              // Let the dialog close, but stop propagation so the card's onClick doesn't fire
              e.stopPropagation();
            }}
          >
            <DialogHeader>
              <div className="flex items-center gap-3">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-bg-danger-hover">
                  <DangerTriangle className="size-5 text-content-danger" />
                </div>
                <div className="space-y-1">
                  <DialogTitle>Delete Document</DialogTitle>
                  <DialogDescription>This action cannot be undone</DialogDescription>
                </div>
              </div>
            </DialogHeader>

            <DialogBody className="text-sm text-content-primary">
              <p>
                Are you sure you want to delete <strong>{doc.title}</strong>?
              </p>
              <p className="text-content-secondary">This will permanently delete the file from the filesystem.</p>
            </DialogBody>

            <DialogFooter>
              <Button
                variant="secondary"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsDeleteDialogOpen(false);
                }}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsDeleteDialogOpen(false);
                  onDelete(e);
                }}
              >
                Delete
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}

function formatDate(date: Date): string {
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  const hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const displayHour = hours % 12 || 12;
  return `${day}.${month}.${year} / ${displayHour}:${minutes} ${ampm}`;
}
