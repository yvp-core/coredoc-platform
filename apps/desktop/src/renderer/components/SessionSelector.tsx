import { useState, useRef, useEffect, type ReactNode } from 'react';
import { Magnifer, DocumentText, Unread, TrashBinTrash, Pen2 } from '@solar-icons/react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from './ui/dropdown-menu';
import { cn } from '../lib/utils';
import type { ChatSessionMeta } from '../../shared/ipc-types';

interface SessionSelectorProps {
  sessions: ChatSessionMeta[];
  currentSessionId: string | null;
  onSelect: (sessionId: string) => void;
  onNew?: () => void;
  onRename: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  showNewChat?: boolean;
  trigger?: ReactNode;
}

export function SessionSelector({
  sessions,
  currentSessionId,
  onSelect,
  onRename,
  onDelete,
  trigger,
}: SessionSelectorProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      setSearch('');
    }
  }, [open]);

  const filtered = sessions.filter((s) => s.name.toLowerCase().includes(search.toLowerCase()));

  const handleSelect = (sessionId: string) => {
    onSelect(sessionId);
    setOpen(false);
  };

  const handleDelete = (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    onDelete(sessionId);
  };

  const handleRename = (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    setOpen(false);
    onRename(sessionId);
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>{trigger || <button type="button">Sessions</button>}</DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        alignOffset={-12}
        className="w-[267px] p-1 bg-bg-primary-hover shadow-surface rounded-md ring-0 border-none"
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        {/* Search input */}
        <div className="pt-2 pb-0.5">
          <div className="flex items-center rounded-md bg-bg-primary border border-border-input px-2.5 py-1.5 gap-1 shadow-field">
            <Magnifer className="size-3.5 text-content-quaternary shrink-0" />
            <input
              ref={inputRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Escape') {
                  e.stopPropagation();
                }
              }}
              placeholder="Search"
              aria-label="Search chats"
              className="flex-1 min-w-0 bg-transparent text-sm leading-5 outline-none placeholder:text-content-quaternary text-content-primary"
            />
          </div>
        </div>

        {/* Label */}
        <div className="px-2 pt-1 pb-px text-xs leading-4 text-content-quaternary select-none">Chats:</div>

        {/* Scrollable session list */}
        <div className="max-h-[480px] overflow-y-auto">
          {filtered.map((session) => {
            const isActive = session.id === currentSessionId;

            return (
              <div
                key={session.id}
                role="option"
                aria-selected={isActive}
                tabIndex={0}
                className={cn(
                  'group/session flex items-center justify-between w-full px-2 py-1.5 rounded-sm text-sm leading-5 cursor-default select-none outline-none focus-visible:ring-2 focus-visible:ring-content-action-secondary gap-1.5',
                  isActive
                    ? 'bg-bg-overlay-hover text-content-action-secondary'
                    : 'text-content-action-secondary hover:bg-bg-primary-hover focus-visible:bg-bg-primary-hover',
                )}
                onClick={() => handleSelect(session.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleSelect(session.id);
                  }
                }}
              >
                <div className="flex items-center gap-1.5 min-w-0 flex-1">
                  <DocumentText className="size-4 shrink-0" />
                  <span className="truncate">{session.name}</span>
                </div>
                {isActive && (
                  <Unread className="size-4 shrink-0 group-hover/session:hidden group-focus-within/session:hidden" />
                )}
                <div className="flex items-center shrink-0 hidden group-hover/session:flex group-focus-within/session:flex">
                  <button
                    type="button"
                    aria-label="Rename chat"
                    className="size-5 flex items-center justify-center rounded-sm text-content-quaternary hover:text-content-primary hover:bg-bg-primary-hover transition-colors outline-none focus-visible:ring-2 focus-visible:ring-content-primary"
                    onClick={(e) => handleRename(e, session.id)}
                  >
                    <Pen2 className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label="Delete chat"
                    className="size-5 flex items-center justify-center rounded-sm text-content-quaternary hover:text-content-warning hover:bg-content-warning/10 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-content-warning"
                    onClick={(e) => handleDelete(e, session.id)}
                  >
                    <TrashBinTrash className="size-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
          {filtered.length === 0 && (
            <div className="px-2 py-3 text-sm text-content-quaternary text-center select-none">
              {search ? 'No matches' : 'No chats yet'}
            </div>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
