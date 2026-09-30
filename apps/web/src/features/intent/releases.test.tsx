import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntentReleases } from './releases.js';
import { useState } from 'react';

const history = {
  entries: [],
  nextBeforeSeq: null,
  headSeq: 4,
  currentReleaseSeq: 2,
  currentRelease: { seq: 2, deliveredRef: 'deploy-a', recordedAt: '2026-09-05T10:00:00Z' },
};
let authority = 'accepted';
let planState = 'none';
let effectivity = 'unknown';
let failWrite = false;
let conflict = false;
let previewHead = 4;
let blockOlder = false;
let releaseTrigger = 'manual';
let writes: { url: string; body: Record<string, unknown> }[];
function mount(role = 'admin', view: 'item' | 'selection' | 'history' = 'item') {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}
    >
      <IntentReleases
        workspaceId="test-ws"
        role={role}
        view={view}
        itemId={view === 'item' ? 'br-a' : undefined}
        selection={[{ id: 'br-a', title: 'Limit uploads' }]}
      />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  authority = 'accepted';
  planState = 'none';
  effectivity = 'unknown';
  failWrite = false;
  conflict = false;
  previewHead = 4;
  blockOlder = false;
  releaseTrigger = 'manual';
  writes = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && !url.endsWith('/items/release-preview')) {
        writes.push({ url, body: JSON.parse(String(init.body)) });
        if (failWrite) throw new TypeError('Connection lost');
        if (conflict)
          return new Response(JSON.stringify({ code: 'release_out_of_order', message: 'Release head changed' }), {
            status: 409,
          });
        return new Response('{}');
      }
      if (url.includes('/release-preview')) {
        const preview = {
          deliveryImpact: {
            ancestors: ['br-old'],
            replaces: [{ itemId: 'br-old', title: 'Old upload rule' }],
            blockingSuccessors: blockOlder ? [{ itemId: 'br-new', title: 'New upload rule' }] : [],
          },
          itemId: 'br-a',
          authority,
          version: 3,
          content: {
            title: 'Limit uploads',
            statement: 'Uploads must be under 10 MB.',
            rationale: null,
            payload: { outcome: 'Safe uploads', boundary: 'Applies to uploads', beneficiary: 'All users' },
          },
          contentHash: 'a'.repeat(64),
          effectivity,
          planState,
          sources: [],
          headSeq: previewHead,
          currentRelease: history.currentRelease,
        };
        return new Response(
          JSON.stringify(
            init?.method === 'POST'
              ? JSON.parse(String(init.body)).itemIds.map((itemId: string) => ({ ...preview, itemId }))
              : preview,
          ),
        );
      }
      if (url.includes('/releases')) return new Response(JSON.stringify(history));
      if (url.endsWith('/workspaces/test-ws'))
        return new Response(JSON.stringify({ id: 'test-ws', intentReleaseTrigger: releaseTrigger }));
      return new Response(
        JSON.stringify({ items: [{ id: 'br-a', title: 'Limit uploads', authority, version: 3 }], nextCursor: null }),
      );
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe('Intent delivery UI', () => {
  it('records an initial state with prose only and a stable generated reference', async () => {
    mount('admin', 'selection');
    fireEvent.click(await screen.findByRole('button', { name: 'Already in production' }));
    await screen.findByRole('dialog');
    expect(screen.queryByLabelText('Delivery reference')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Confirmation'), { target: { value: 'Already running in production' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm record' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.body).toMatchObject({
      kind: 'baseline',
      reason: 'Already running in production',
      deliveredRef: expect.stringMatching(/^initial-state-/),
    });
  });
  it('removes individual selections and clears the basket without finding catalogue rows', async () => {
    function Basket() {
      const [selection, setSelection] = useState([
        { id: 'br-a', title: 'Limit uploads' },
        { id: 'br-b', title: 'Validate input' },
      ]);
      return (
        <IntentReleases
          workspaceId="test-ws"
          role={String('admin')}
          view="selection"
          selection={selection}
          onSelectionChange={setSelection}
        />
      );
    }
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Basket />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByText('Review or edit selected rules (2)'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Limit uploads from selection' }));
    expect(screen.getByText('1 rule selected')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(screen.queryByRole('button', { name: 'Confirm delivery' })).not.toBeInTheDocument();
    expect(writes).toHaveLength(0);
  });
  it('keeps large history events collapsed, uses history names without previews and opens the same rule in Browse', async () => {
    const previews: string[] = [];
    const onOpenItem = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/release-preview')) {
          const id = url.split('/items/')[1]?.split('/')[0] ?? '';
          previews.push(id);
          return new Response(JSON.stringify({ content: { title: `Rule ${id}` } }));
        }
        return new Response(
          JSON.stringify({
            ...history,
            entries: [
              {
                seq: 2,
                kind: 'release',
                reason: 'Upload safety shipped',
                recordedAt: '2026-09-05T10:00:00Z',
                recordedBy: 'Maintainer',
                data: { included: Array.from({ length: 25 }, (_, i) => `br-${i}`) },
                titles: Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`br-${i}`, `Rule br-${i}`])),
              },
            ],
          }),
        );
      }),
    );
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <IntentReleases workspaceId="test-ws" role={String('member')} view="history" onOpenItem={onOpenItem} />
      </QueryClientProvider>,
    );
    await screen.findByText('Delivery confirmed');
    expect(previews).toHaveLength(0);
    const event = container.querySelector('details');
    if (!event) throw new Error('Expected a collapsed history event');
    event.open = true;
    fireEvent(event, new Event('toggle'));
    await screen.findByText('Rule br-0');
    expect(previews).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: /Show more rules/ }));
    await screen.findByText('Rule br-24');
    expect(previews).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: /Available Rule br-24/ }));
    expect(onOpenItem).toHaveBeenCalledWith('br-24');
  });
  it('shows unknown explicitly, keeps member read-only', async () => {
    mount('member');
    expect(await screen.findByText('No recorded evidence establishes delivery or an active plan.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Plan change' })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });
  it('renders readable shared details inside a chevron disclosure', async () => {
    mount('admin', 'selection');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delivery' }));
    await screen.findByRole('dialog');
    const title = screen.getByText('Limit uploads', { selector: 'summary span' });
    const summary = title.closest('summary');
    expect(summary?.querySelector('svg')).toBeInTheDocument();
    expect(screen.getByText('Outcome')).toBeInTheDocument();
    expect(screen.getByText('Safe uploads')).toBeInTheDocument();
    expect(screen.getByText('Boundary')).toBeInTheDocument();
    expect(screen.getByText('Beneficiary')).toBeInTheDocument();
    expect(screen.queryByText('Full rule content')).not.toBeInTheDocument();
    expect(summary?.parentElement?.querySelector('pre')).toBeNull();
  });
  it('previews the rules becoming effective and the effective predecessors being replaced', async () => {
    mount('admin', 'selection');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delivery' }));
    await screen.findByRole('dialog');
    expect(screen.getByText('Will be in production · 1')).toBeInTheDocument();
    expect(screen.getByText('Will be replaced · 1')).toBeInTheDocument();
    expect(screen.getByText('Old upload rule')).toBeInTheDocument();
    expect(writes).toHaveLength(0);
  });
  it('separates already effective rules from newly delivered rules', async () => {
    effectivity = 'effective';
    mount('admin', 'selection');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delivery' }));
    await screen.findByRole('dialog');
    expect(screen.getByText('Already in production · 1')).toBeInTheDocument();
    expect(screen.queryByText('Will be in production · 1')).not.toBeInTheDocument();
  });
  it('stops an older-rule delivery when a newer rule is still effective', async () => {
    blockOlder = true;
    mount('admin', 'selection');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delivery' }));
    await screen.findByText(/has a newer rule in production: New upload rule/);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(writes).toHaveLength(0);
  });
  it('pins delivery hash and head and reuses the exact request after network failure', async () => {
    mount('admin', 'selection');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delivery' }));
    await screen.findByRole('dialog');
    fireEvent.change(screen.getByLabelText('Delivery reference'), { target: { value: 'deploy-b' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Available to users' } });
    failWrite = true;
    fireEvent.click(screen.getByRole('button', { name: 'Confirm record' }));
    await screen.findByRole('alert');
    const first = writes[0];
    expect(first?.body).toMatchObject({
      expectedHeadSeq: 4,
      included: [{ itemId: 'br-a', contentHash: 'a'.repeat(64) }],
      retired: [],
      deliveredRef: 'deploy-b',
    });
    failWrite = false;
    blockOlder = false;
    fireEvent.click(screen.getByRole('button', { name: 'Confirm record' }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]).toEqual(first);
    await screen.findByRole('status');
  });
  it('keeps the form and exact request after a server conflict', async () => {
    mount('admin', 'selection');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delivery' }));
    await screen.findByRole('dialog');
    fireEvent.change(screen.getByLabelText('Delivery reference'), { target: { value: 'deploy-b' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Available to users' } });
    conflict = true;
    fireEvent.click(screen.getByRole('button', { name: 'Confirm record' }));
    await screen.findByRole('alert');
    expect(screen.getByLabelText('Reason')).toHaveValue('Available to users');
    expect(screen.getByRole('alert')).toHaveTextContent('Release head changed');
    expect(screen.getByRole('alert')).not.toHaveTextContent('release_out_of_order:');
    conflict = false;
    fireEvent.click(screen.getByRole('button', { name: 'Confirm record' }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]).toEqual(writes[0]);
  });
  it('mints a new attempt key when the failed form changes', async () => {
    mount('admin', 'selection');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delivery' }));
    await screen.findByRole('dialog');
    fireEvent.change(screen.getByLabelText('Delivery reference'), { target: { value: 'deploy-b' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Available' } });
    failWrite = true;
    fireEvent.click(screen.getByRole('button', { name: 'Confirm record' }));
    await screen.findByRole('alert');
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Corrected evidence' } });
    failWrite = false;
    fireEvent.click(screen.getByRole('button', { name: 'Confirm record' }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]?.body.idempotencyKey).not.toBe(writes[0]?.body.idempotencyKey);
  });
  it('refuses a head change during preparation without opening confirmation', async () => {
    previewHead = 5;
    mount('admin', 'selection');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delivery' }));
    await screen.findByText(/Release evidence changed while preparing/);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(writes).toHaveLength(0);
  });
  it('allows restoring an older rule only while retiring its effective successor', async () => {
    blockOlder = true;
    render(
      <QueryClientProvider client={new QueryClient()}>
        <IntentReleases
          workspaceId="test-ws"
          role={String('admin')}
          view="selection"
          selection={[
            { id: 'br-a', title: 'Limit uploads' },
            { id: 'br-new', title: 'New upload rule', removed: true },
          ]}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByRole('button', { name: 'Already in production' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delivery' }));
    await screen.findByRole('dialog');
    expect(screen.getByRole('heading', { name: 'Will be removed from production · 1' })).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveTextContent('New upload rule');
    fireEvent.change(screen.getByLabelText('Delivery reference'), { target: { value: 'restore-old' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Successor removed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm record' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.body.retired).toEqual(['br-new']);
    expect(writes[0]?.body.included).toEqual([{ itemId: 'br-a', contentHash: 'a'.repeat(64) }]);
  });
  it('refuses selecting two revisions of the same rule', async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <IntentReleases
          workspaceId="test-ws"
          role={String('admin')}
          view="selection"
          selection={[
            { id: 'br-a', title: 'Limit uploads' },
            { id: 'br-old', title: 'Old upload rule' },
          ]}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delivery' }));
    await screen.findByText(/multiple revisions of one rule/);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(writes).toHaveLength(0);
  });
  it('prevents a delivery selection above the 200-rule limit', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <IntentReleases
          workspaceId="test-ws"
          role={String('admin')}
          view="selection"
          selection={Array.from({ length: 201 }, (_, i) => ({ id: `br-${i}`, title: `Rule ${i}` }))}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByRole('button', { name: 'Confirm delivery' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Already in production' })).toBeDisabled();
    expect(writes).toHaveLength(0);
  });
  it('plans against the version observed at preparation', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Plan change' }));
    await screen.findByRole('dialog');
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Approved task' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm record' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({
      url: '/api/v1/workspaces/test-ws/intent/items/br-a/plan',
      body: { expectedHeadSeq: 4, expectedVersion: 3, itemId: 'br-a' },
    });
  });
  it('allows withdrawing a superseded active plan but never reinstating it', async () => {
    authority = 'superseded';
    planState = 'active';
    effectivity = 'planned';
    mount();
    expect(await screen.findByRole('button', { name: 'Withdraw plan' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reinstate plan' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Plan change' })).not.toBeInTheDocument();
  });
  it('rolls back currentReleaseSeq despite later plan events', async () => {
    mount('admin', 'history');
    await screen.findByText('deploy-a');
    fireEvent.click(screen.getByRole('button', { name: 'Record rollback' }));
    await screen.findByRole('dialog');
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Deployment rolled back' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm record' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({
      url: '/api/v1/workspaces/test-ws/intent/releases/2/rollback',
      body: { releaseSeq: 2, expectedHeadSeq: 4 },
    });
  });
  it('records a delivery with no typed reason and sends none, leaving the server default', async () => {
    mount('admin', 'selection');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delivery' }));
    await screen.findByRole('dialog');
    expect(screen.getByLabelText('Reason')).toHaveAttribute('placeholder', 'manual');
    fireEvent.change(screen.getByLabelText('Delivery reference'), { target: { value: 'deploy-b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm record' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.body).not.toHaveProperty('reason');
  });
  it('still requires a typed reason to plan a change', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Plan change' }));
    await screen.findByRole('dialog');
    expect(screen.getByRole('button', { name: 'Confirm record' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Approved task' } });
    expect(screen.getByRole('button', { name: 'Confirm record' })).toBeEnabled();
  });
  it('still requires a typed reason to record a rollback', async () => {
    mount('admin', 'history');
    await screen.findByText('deploy-a');
    fireEvent.click(screen.getByRole('button', { name: 'Record rollback' }));
    await screen.findByRole('dialog');
    expect(screen.getByRole('button', { name: 'Confirm record' })).toBeDisabled();
    expect(writes).toHaveLength(0);
  });
  it('attributes each history event to its actor and links the pull request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ...history,
              entries: [
                {
                  seq: 4,
                  kind: 'release',
                  reason: 'deploy v9',
                  recordedAt: '2026-09-05T10:00:00Z',
                  recordedBy: 'ci',
                  actorKind: 'ci',
                  orderingToken: '2026-09-05T09:00:00Z',
                  pr: { repoKey: 'backend', number: 42, url: 'https://github.com/acme/backend/pull/42' },
                  data: { included: ['br-a'], deployId: 'run-7' },
                },
                {
                  seq: 3,
                  kind: 'release',
                  reason: 'PR frontend#7',
                  recordedAt: '2026-09-04T10:00:00Z',
                  recordedBy: 'connector',
                  actorKind: 'connector',
                  pr: { repoKey: 'frontend', number: 7 },
                  data: { included: ['br-b'] },
                },
                {
                  seq: 2,
                  kind: 'release',
                  reason: 'manual',
                  recordedAt: '2026-09-03T10:00:00Z',
                  recordedBy: 'Maintainer',
                  actorKind: 'maintainer',
                  data: { included: ['br-c'] },
                },
                {
                  seq: 1,
                  kind: 'release',
                  reason: 'legacy',
                  recordedAt: '2026-09-02T10:00:00Z',
                  recordedBy: 'Maintainer',
                  pr: { repoKey: 'legacy', number: 3, url: 'javascript:alert(1)' },
                  data: { included: ['br-d'] },
                },
              ],
            }),
          ),
      ),
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <IntentReleases workspaceId="test-ws" role={String('member')} view="history" />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('ci')).toBeInTheDocument();
    expect(screen.getByText('connector')).toBeInTheDocument();
    expect(screen.getByText('maintainer')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'backend#42' })).toHaveAttribute(
      'href',
      'https://github.com/acme/backend/pull/42',
    );
    expect(screen.queryByRole('link', { name: 'frontend#7' })).not.toBeInTheDocument();
    expect(screen.getByText('frontend#7')).toBeInTheDocument();
    // Only http(s) becomes a link — a `javascript:` url stays plain text.
    expect(screen.queryByRole('link', { name: 'legacy#3' })).not.toBeInTheDocument();
    expect(screen.getByText('legacy#3')).toBeInTheDocument();
    expect(screen.getByText('· ordered at 2026-09-05T09:00:00Z')).toBeInTheDocument();
    expect(screen.getByText('· deploy run-7')).toBeInTheDocument();
  });
  it.each([
    ['manual', 'Manual', 'Deliveries are recorded here, by a maintainer.'],
    ['merge', 'On merge', 'A pull request merged into the production branch records the delivery.'],
    ['deploy', 'On deploy', 'The CI step after a production deploy records the delivery.'],
  ])('names the %s release trigger in the history header', async (mode, label, explanation) => {
    releaseTrigger = mode;
    mount('admin', 'history');
    expect(await screen.findByText(label)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(explanation.slice(0, 30)))).toBeInTheDocument();
  });
  it('reads an absent trigger field (older server) as Manual', async () => {
    const base = fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) =>
        url.endsWith('/workspaces/test-ws') ? new Response(JSON.stringify({ id: 'test-ws' })) : base(url, init),
      ),
    );
    mount('admin', 'history');
    expect(await screen.findByText(/^Release trigger:/)).toHaveTextContent('Release trigger: Manual');
  });
  it('says the trigger is unavailable rather than claiming Manual when the read fails', async () => {
    const base = fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/workspaces/test-ws')) throw new TypeError('Connection lost');
        return base(url, init);
      }),
    );
    mount('admin', 'history');
    expect(await screen.findByText('Release trigger unavailable')).toBeInTheDocument();
    expect(screen.queryByText(/^Release trigger:/)).not.toBeInTheDocument();
  });
  it('keeps the delivery form available in an automatic workspace and says who records normally', async () => {
    releaseTrigger = 'deploy';
    mount('admin', 'selection');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delivery' }));
    await screen.findByRole('dialog');
    expect(screen.getByText(/CI step after a deploy/)).toBeInTheDocument();
    expect(screen.getByLabelText('Delivery reference')).toBeInTheDocument();
  });
});
