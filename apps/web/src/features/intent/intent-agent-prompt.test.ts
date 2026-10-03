import { describe, expect, it } from 'vitest';
import { agentPrompt } from './intent-agent-prompt.js';
import { IntentAuthority, IntentItemKind, type IntentContextMatch } from './types.js';

const match = (extra: Partial<IntentContextMatch>): IntentContextMatch =>
  ({
    id: 'br-refund-window',
    kind: IntentItemKind.BusinessRule,
    title: 'Refund window',
    authority: IntentAuthority.Accepted,
    version: 2,
    domainId: 'billing',
    featureId: 'refunds',
    statement: 'Refunds within 14 days.',
    payload: null,
    ...extra,
  }) as IntentContextMatch;

describe('agentPrompt', () => {
  it('asks for a successor of an accepted item, carrying the request', () => {
    const prompt = agentPrompt(match({}), 'Make it 30 days');
    expect(prompt).toContain('item br-refund-window (business_rule, accepted, v2) in feature refunds');
    expect(prompt).toContain('Requested change: Make it 30 days');
    expect(prompt).toContain('proposedSuccessorOfId "br-refund-window"');
  });

  it('asks for an answered decision for an open question', () => {
    const prompt = agentPrompt(
      match({ id: 'dec-proration', kind: IntentItemKind.Decision, payload: { choiceStatus: 'open' } }),
      'From the charge date',
    );
    expect(prompt).toContain('This is an open question. Answer: From the charge date');
    expect(prompt).toContain('payload.choiceStatus "proposed"');
  });
});
