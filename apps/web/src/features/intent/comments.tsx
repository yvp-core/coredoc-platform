/** Any member may comment, reply, resolve or reopen; a thread's status lives on its first comment. */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { createIntentComment, intentCommentsQueryOptions, setIntentCommentStatus } from '@/api/queries/intent';
import { membersQueryOptions } from '@/api/queries/members';
import { IntentWriteForm } from './intent-attempt-keys.js';
import { formatIntentTimestamp, messageOf } from './intent-presentation.js';
import { useIntentWriter } from './intent-writer.js';
import { Chip } from './items-list.js';
import type { IntentComment, IntentCommentStatus, IntentCommentTarget, IntentCommentThread } from './types.js';

export interface IntentCommentsProps {
  workspaceId: string;
  target: IntentCommentTarget;
}

export function IntentComments({ workspaceId, target }: IntentCommentsProps) {
  const queryClient = useQueryClient();
  const writer = useIntentWriter();
  const [status, setStatus] = useState<IntentCommentStatus | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string>();

  const threadsQuery = useInfiniteQuery(intentCommentsQueryOptions(workspaceId, target, status));
  const threads = useMemo(() => threadsQuery.data?.pages.flatMap((page) => page.threads) ?? null, [threadsQuery.data]);
  const membersQuery = useQuery(membersQueryOptions(workspaceId));
  const authorOf = (userId: string) => {
    const member = membersQuery.data?.find((entry) => entry.userId === userId);
    return member?.displayName || member?.email || userId;
  };

  const write = async (send: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setErrorMessage(undefined);
    try {
      await send();
      // As after any intent write, everything intent-scoped is re-read: open-thread counts show in several views.
      await queryClient.invalidateQueries({ queryKey: ['intent'] });
      return true;
    } catch (error) {
      setErrorMessage(messageOf(error));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const addThread = async () => {
    const body = draft.trim();
    if (body === '') return;
    const sent = await write(() =>
      writer.run(IntentWriteForm.AddComment, { target, body }, (input) => createIntentComment(workspaceId, input)),
    );
    if (sent) setDraft('');
  };

  const reply = (parentId: string, body: string) =>
    write(() =>
      writer.run(IntentWriteForm.ReplyComment, { parentId, body }, (input) => createIntentComment(workspaceId, input)),
    );

  const changeStatus = (id: string, next: IntentCommentStatus) =>
    write(() =>
      writer.run(IntentWriteForm.CommentStatus, { id, status: next }, (input) =>
        setIntentCommentStatus(workspaceId, input),
      ),
    );

  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h4 className="text-[11.5px] uppercase tracking-[0.04em] text-ink-4">Comments</h4>
        <span className="flex items-center gap-1">
          <Chip pressed={status === null} label="All" onClick={() => setStatus(null)} />
          <Chip pressed={status === 'open'} label="Open" onClick={() => setStatus('open')} />
          <Chip pressed={status === 'resolved'} label="Resolved" onClick={() => setStatus('resolved')} />
        </span>
      </div>

      {threadsQuery.isLoading ? (
        <Spinner className="text-ink-4" />
      ) : threadsQuery.error ? (
        <p className="text-[12px] text-danger-text">{messageOf(threadsQuery.error)}</p>
      ) : threads === null || threads.length === 0 ? (
        <p className="text-[12px] text-ink-4">{status === null ? 'No comments yet.' : `No ${status} comments.`}</p>
      ) : (
        <ul className="space-y-2.5">
          {threads.map((thread) => (
            <CommentThread
              key={thread.id}
              thread={thread}
              busy={busy}
              authorOf={authorOf}
              onReply={(body) => reply(thread.id, body)}
              onStatus={(next) => void changeStatus(thread.id, next)}
            />
          ))}
        </ul>
      )}
      {threadsQuery.hasNextPage && (
        <Button
          variant="outline"
          size="sm"
          className="mt-2"
          disabled={threadsQuery.isFetchingNextPage}
          onClick={() => void threadsQuery.fetchNextPage()}
        >
          {threadsQuery.isFetchingNextPage ? 'Loading…' : 'Load more comments'}
        </Button>
      )}

      <div className="mt-3 flex flex-col gap-1.5">
        <Textarea
          aria-label="New comment"
          placeholder={`Comment on this ${target.kind}…`}
          value={draft}
          maxLength={2000}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button size="sm" className="self-end" disabled={busy || draft.trim() === ''} onClick={() => void addThread()}>
          Comment
        </Button>
        {errorMessage && (
          <p role="alert" className="text-[12px] text-danger-text">
            {errorMessage}
          </p>
        )}
      </div>
    </section>
  );
}

function CommentThread({
  thread,
  busy,
  authorOf,
  onReply,
  onStatus,
}: {
  thread: IntentCommentThread;
  busy: boolean;
  authorOf: (userId: string) => string;
  onReply: (body: string) => Promise<boolean>;
  onStatus: (next: IntentCommentStatus) => void;
}) {
  const [replying, setReplying] = useState(false);
  const [draft, setDraft] = useState('');
  const resolved = thread.status === 'resolved';

  const send = async () => {
    const body = draft.trim();
    if (body === '') return;
    if (await onReply(body)) {
      setDraft('');
      setReplying(false);
    }
  };

  return (
    <li className="rounded-lg border border-border-soft px-3 py-2">
      <div className="mb-1 flex items-center gap-1.5">
        <Badge variant={resolved ? 'ok' : 'info'}>{resolved ? 'Resolved' : 'Open'}</Badge>
        {resolved && thread.resolvedBy && (
          <span className="truncate text-[11.5px] text-ink-4">
            by {authorOf(thread.resolvedBy)}
            {thread.resolvedAt ? ` · ${formatIntentTimestamp(thread.resolvedAt)}` : ''}
          </span>
        )}
      </div>
      <CommentBody comment={thread} authorOf={authorOf} />
      {thread.replies.length > 0 && (
        <ul className="mt-2 space-y-2 border-l border-border-soft pl-3">
          {thread.replies.map((entry) => (
            <li key={entry.id}>
              <CommentBody comment={entry} authorOf={authorOf} />
            </li>
          ))}
        </ul>
      )}
      {replying ? (
        <div className="mt-2 flex flex-col gap-1.5">
          <Textarea
            aria-label="Reply"
            placeholder="Reply…"
            value={draft}
            maxLength={2000}
            onChange={(event) => setDraft(event.target.value)}
          />
          <span className="flex justify-end gap-1.5">
            <Button variant="ghost" size="sm" onClick={() => setReplying(false)}>
              Cancel
            </Button>
            <Button size="sm" disabled={busy || draft.trim() === ''} onClick={() => void send()}>
              Reply
            </Button>
          </span>
        </div>
      ) : (
        <span className="mt-1.5 flex gap-1">
          <Button variant="ghost" size="sm" className="px-2" onClick={() => setReplying(true)}>
            Reply
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="px-2"
            disabled={busy}
            onClick={() => onStatus(resolved ? 'open' : 'resolved')}
          >
            {resolved ? 'Reopen' : 'Resolve'}
          </Button>
        </span>
      )}
    </li>
  );
}

function CommentBody({ comment, authorOf }: { comment: IntentComment; authorOf: (userId: string) => string }) {
  return (
    <div>
      <p className="text-[12px] text-ink-3">
        <span className="text-ink-1">{authorOf(comment.createdBy)}</span> · {formatIntentTimestamp(comment.createdAt)}
      </p>
      <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink-1">{comment.body}</p>
    </div>
  );
}
