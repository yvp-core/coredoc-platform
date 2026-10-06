import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IntentComments } from './comments.js';
import type { IntentComment, IntentCommentThread } from './types.js';

const ROOT: IntentComment = {
  id: '11111111-1111-4111-8111-111111111111',
  target: { kind: 'feature', id: 'refunds' },
  parentId: null,
  body: 'Should partial refunds count?',
  status: 'open',
  resolvedBy: null,
  resolvedAt: null,
  createdBy: 'user-ana',
  createdAt: '2026-10-01T10:00:00.000Z',
};

let threads: IntentCommentThread[] = [];
let writes: { path: string; body: Record<string, unknown> }[] = [];

beforeEach(() => {
  threads = [{ ...ROOT, replies: [] }];
  writes = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(url, 'http://local.test');
      if (u.pathname.endsWith('/members'))
        return new Response(JSON.stringify([{ userId: 'user-ana', email: 'ana@example.com', displayName: 'Ana' }]));
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        writes.push({ path: u.pathname, body });
        if (u.pathname.endsWith('/status')) {
          const root = threads[0] as IntentCommentThread;
          threads = [{ ...root, status: body.status, resolvedBy: 'user-ana', resolvedAt: '2026-10-02T10:00:00.000Z' }];
          return new Response(JSON.stringify({ comment: threads[0] }));
        }
        const reply = { ...ROOT, id: 'reply-1', parentId: body.parentId, body: body.body, status: null };
        threads = [{ ...(threads[0] as IntentCommentThread), replies: [reply] }];
        return new Response(JSON.stringify({ comment: reply }), { status: 201 });
      }
      const status = u.searchParams.get('status');
      return new Response(
        JSON.stringify({ threads: threads.filter((thread) => !status || thread.status === status), nextCursor: null }),
      );
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderComments() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <IntentComments workspaceId="ws-1" target={{ kind: 'feature', id: 'refunds' }} />
    </QueryClientProvider>,
  );
}

it('replies to a thread under its root and shows the author by name', async () => {
  renderComments();
  await screen.findByText('Should partial refunds count?');
  await screen.findAllByText('Ana');

  fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
  fireEvent.change(screen.getByLabelText('Reply'), { target: { value: 'Yes, pro rata.' } });
  fireEvent.click(screen.getAllByRole('button', { name: 'Reply' }).at(-1) as HTMLElement);

  await screen.findByText('Yes, pro rata.');
  expect(writes).toHaveLength(1);
  expect(writes[0]?.path).toBe('/api/v1/workspaces/ws-1/intent/comments');
  expect(writes[0]?.body).toMatchObject({ parentId: ROOT.id, body: 'Yes, pro rata.' });
  expect(writes[0]?.body.target).toBeUndefined();
  expect(writes[0]?.body.idempotencyKey).toEqual(expect.any(String));
});

it('resolving a thread moves it out of the open filter and into resolved', async () => {
  renderComments();
  await screen.findByText('Should partial refunds count?');
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  await screen.findByRole('button', { name: 'Resolve' });

  fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));
  await screen.findByText('No open comments.');
  expect(writes[0]).toMatchObject({
    path: `/api/v1/workspaces/ws-1/intent/comments/${ROOT.id}/status`,
    body: { id: ROOT.id, status: 'resolved' },
  });

  fireEvent.click(screen.getByRole('button', { name: 'Resolved' }));
  await screen.findByText('Should partial refunds count?');
  expect(screen.getByRole('button', { name: 'Reopen' })).toBeTruthy();
});

it('starts a new thread on the target', async () => {
  renderComments();
  await screen.findByText('Should partial refunds count?');

  fireEvent.change(screen.getByLabelText('New comment'), { target: { value: 'What about store credit?' } });
  fireEvent.click(screen.getByRole('button', { name: 'Comment' }));

  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]?.body).toMatchObject({
    target: { kind: 'feature', id: 'refunds' },
    body: 'What about store credit?',
  });
  await waitFor(() => expect((screen.getByLabelText('New comment') as HTMLTextAreaElement).value).toBe(''));
});
