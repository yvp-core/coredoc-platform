/**
 * The §3.1 transition table, row by row. Pure input → pure output: no database,
 * no ledger, no PR payloads — the connector's only job is to feed this the state.
 */
import { describe, expect, it } from 'vitest';
import type { PlanState } from './intent-release.fold.js';
import {
  IntentPlanEventKind,
  intentPlanEvents,
  type IntentPlanChange,
  type IntentPlanItemState,
} from './intent-plan-transitions.js';

const accepted = (planState: PlanState = 'none', effective = false): IntentPlanItemState => ({
  authority: 'accepted',
  planState,
  effective,
});

function events(args: {
  change?: Partial<IntentPlanChange>;
  items?: Record<string, IntentPlanItemState>;
  namedByOtherChanges?: string[];
  connectorPlanned?: string[];
}) {
  return intentPlanEvents({
    change: {
      state: 'open',
      isDraft: false,
      delivers: [{ itemId: 'cap-alpha', version: 2 }],
      ...args.change,
    },
    items: new Map(Object.entries(args.items ?? { 'cap-alpha': accepted() })),
    namedByOtherChanges: new Set(args.namedByOtherChanges ?? []),
    connectorPlanned: args.connectorPlanned ?? [],
  });
}

describe('intentPlanEvents — §3.1 transition table', () => {
  it('plans an accepted, unplanned item an open non-draft PR names, at the trailer version', () => {
    expect(events({})).toEqual([{ kind: IntentPlanEventKind.Plan, itemId: 'cap-alpha', expectedVersion: 2 }]);
  });

  it('reinstates rather than re-planning a withdrawn item (reopen, or re-added to the trailer)', () => {
    expect(events({ items: { 'cap-alpha': accepted('withdrawn') }, connectorPlanned: [] })).toEqual([
      { kind: IntentPlanEventKind.Reinstate, itemId: 'cap-alpha' },
    ]);
  });

  it('emits nothing for an already active plan — a second PR naming it adds no event', () => {
    expect(events({ items: { 'cap-alpha': accepted('active') }, connectorPlanned: ['cap-alpha'] })).toEqual([]);
  });

  it('emits nothing for an item that is not accepted, or already effective', () => {
    expect(events({ items: { 'cap-alpha': { authority: 'candidate', planState: 'none', effective: false } } })).toEqual(
      [],
    );
    expect(events({ items: { 'cap-alpha': accepted('none', true) } })).toEqual([]);
    expect(events({ items: {} })).toEqual([]);
  });

  it('does not plan from a draft PR, and withdraws when a PR is converted to draft', () => {
    expect(events({ change: { isDraft: true } })).toEqual([]);
    expect(
      events({
        change: { isDraft: true },
        items: { 'cap-alpha': accepted('active') },
        connectorPlanned: ['cap-alpha'],
      }),
    ).toEqual([{ kind: IntentPlanEventKind.Withdraw, itemId: 'cap-alpha' }]);
  });

  it('withdraws on close without merge', () => {
    expect(
      events({
        change: { state: 'closed' },
        items: { 'cap-alpha': accepted('active') },
        connectorPlanned: ['cap-alpha'],
      }),
    ).toEqual([{ kind: IntentPlanEventKind.Withdraw, itemId: 'cap-alpha' }]);
  });

  it('withdraws an item removed from the trailer of a still-open PR', () => {
    expect(
      events({ change: { delivers: [] }, items: { 'cap-alpha': accepted('active') }, connectorPlanned: ['cap-alpha'] }),
    ).toEqual([{ kind: IntentPlanEventKind.Withdraw, itemId: 'cap-alpha' }]);
  });

  it('keeps a plan while ANOTHER open non-draft PR still names the item', () => {
    expect(
      events({
        change: { state: 'closed' },
        items: { 'cap-alpha': accepted('active') },
        connectorPlanned: ['cap-alpha'],
        namedByOtherChanges: ['cap-alpha'],
      }),
    ).toEqual([]);
  });

  it('never withdraws a plan the connector did not write (a maintainer roadmap plan)', () => {
    expect(events({ change: { state: 'closed' }, items: { 'cap-alpha': accepted('active') } })).toEqual([]);
  });

  it('does nothing at all on the plan side when the PR merged — the delivery consumes the plan', () => {
    expect(
      events({
        change: { state: 'merged' },
        items: { 'cap-alpha': accepted('active') },
        connectorPlanned: ['cap-alpha'],
      }),
    ).toEqual([]);
  });

  it('emits nothing on a re-sync that changed nothing (idempotent by construction)', () => {
    const steady = { items: { 'cap-alpha': accepted('active') }, connectorPlanned: ['cap-alpha'] };
    expect(events(steady)).toEqual([]);
    expect(events(steady)).toEqual([]);
  });
});
