import { useMemo, useState } from 'react';
import { AddCircle, ChatLine, MenuDots, Magnifer } from '@solar-icons/react';
import { Input } from '../../../../components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../../../components/ui/dropdown-menu';
import { cn } from '../../../../lib/utils';
import type { ChatSessionMeta } from '../../../../../shared/ipc-types';

export interface ChatLeftPanelBodyProps {
  sessions: ChatSessionMeta[];
  sessionId: string | null;
  onNewSession: () => void;
  onSelectSession: (id: string) => void;
  onRenameSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
}

/** Search + recent-chat list for the Chat tab's left rail. */
export function ChatLeftPanelBody({
  sessions,
  sessionId,
  onNewSession,
  onSelectSession,
  onRenameSession,
  onDeleteSession,
}: ChatLeftPanelBodyProps) {
  const [term, setTerm] = useState('');

  const filtered = useMemo(() => {
    const q = term.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) => s.name.toLowerCase().includes(q));
  }, [sessions, term]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
      <div className="relative">
        <Magnifer className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-content-quaternary" />
        <Input
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Search..."
          aria-label="Search chats"
          className="pl-9"
        />
      </div>

      <div className="flex items-center justify-between">
        <span className="text-sm font-bold leading-5 text-content-primary">Recent Chats:</span>
        <button
          type="button"
          aria-label="New chat"
          title="New chat"
          onClick={onNewSession}
          className="group flex size-7 cursor-pointer items-center justify-center rounded-full"
        >
          <AddCircle className="size-4 text-content-primary transition-colors group-hover:text-content-brand" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
        {filtered.length === 0 ? (
          <p className="px-2 py-3 text-xs leading-4 text-content-quaternary">
            {sessions.length === 0 ? 'No chats yet.' : 'No chats match that search.'}
          </p>
        ) : (
          filtered.map((session) => (
            <div
              key={session.id}
              className={cn(
                'group flex items-center gap-2 rounded-lg px-2 py-1.5',
                session.id === sessionId ? 'bg-bg-primary-selected' : 'hover:bg-bg-primary-hover',
              )}
            >
              <ChatLine className="size-4 shrink-0 text-content-tertiary" />
              <button
                type="button"
                className="min-w-0 flex-1 cursor-pointer truncate text-left text-xs leading-4 text-content-primary"
                onClick={() => onSelectSession(session.id)}
                title={session.name}
              >
                {session.name}
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={`Actions for ${session.name}`}
                    className="shrink-0 cursor-pointer opacity-0 transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100"
                  >
                    <MenuDots className="size-4 text-content-tertiary" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => onRenameSession(session.id)}>Rename</DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" onClick={() => onDeleteSession(session.id)}>
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
