import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { IntentReviewQueue } from './review-queue.js';
import {
  AuthoringHintKind,
  IntentAuthority,
  IntentItemKind,
  type IntentContextMatch,
  type IntentReviewQueueItem,
} from './types.js';

afterEach(cleanup);

// One candidate carrying an authoring hint, an item-level condition and rule
// variants (intent-dimensions spec) — the gate that mounts IntentDetails
// inside the queue's decision card, same as the item detail pane.
const CANDIDATE: IntentReviewQueueItem = {
  id: 'br-refunds-window',
  kind: IntentItemKind.BusinessRule,
  title: 'Refunds close after a window that depends on region',
  authority: IntentAuthority.Candidate,
  version: 1,
  domainId: null,
  featureId: null,
  proposedSuccessorOfId: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
  hints: [{ kind: AuthoringHintKind.DeadVariant, variant: 2 }],
};

const RECORD: IntentContextMatch = {
  id: 'br-refunds-window',
  kind: IntentItemKind.BusinessRule,
  title: CANDIDATE.title,
  authority: IntentAuthority.Candidate,
  version: 1,
  domainId: null,
  featureId: null,
  proposedSuccessorOfId: null,
  supersededById: null,
  updatedAt: '2026-09-02T00:00:00.000Z',
  statement: 'Refunds close after a window that depends on region.',
  rationale: null,
  matchReason: 'exact_id',
  sources: [],
  anchors: [],
  appliesWhen: [{ dimension: 'country', in: ['br'] }],
  payload: {
    variants: [{ when: { country: 'br' }, outcome: '60 days', inputs: ['country'] }],
  },
};

describe('IntentReviewQueue candidate details (gates IntentDetails inside the queue)', () => {
  it('shows the hint sentence, the readable appliesWhen clause and a variant table cell', () => {
    render(
      <IntentReviewQueue
        candidates={[CANDIDATE]}
        candidateItems={{ [CANDIDATE.id]: RECORD }}
        predecessorVersions={{}}
        loading={false}
        canReview={false}
        submitting={false}
        results={null}
        onSubmit={() => undefined}
        onRefetchConflicts={() => undefined}
        onRetry={() => undefined}
      />,
    );

    // The hint sentence, from `authoringHintText`.
    expect(screen.getByText("Variant 3 can never apply under the item's conditions")).toBeInTheDocument();
    // The readable clause, from `contextConditionText`.
    expect(screen.getByText('country in br')).toBeInTheDocument();
    // The variant table's "when" cell, from `variantWhenText`, and its outcome.
    expect(screen.getByText('country = br')).toBeInTheDocument();
    expect(screen.getByText('60 days')).toBeInTheDocument();
  });
});
