import { describe, expect, it } from 'vitest';
import { INTENT_ERROR_REPORT_LIMITS, IntentValidationCode, validateIntentPayload } from './schema.js';
import { IntentKind } from './types.js';

const VALID_PAYLOADS: Record<IntentKind, unknown> = {
  [IntentKind.Capability]: {
    outcome: 'A store operator can place a widget order and see its state',
    beneficiary: 'Store operator',
    boundary: 'Single warehouse; no cross-warehouse transfers',
  },
  [IntentKind.UseCase]: {
    primaryActor: 'Store operator',
    trigger: 'The operator submits an order form',
    preconditions: ['The operator is signed in'],
    successOutcome: 'An order exists in state accepted',
    failureOutcomes: ['Stock is insufficient and the order is refused'],
  },
  [IntentKind.Flow]: {
    trigger: 'The operator submits the order form',
    terminationCondition: 'The order is accepted or refused',
    steps: [
      {
        id: 's1',
        actor: 'Ordering service',
        action: 'Checks available stock',
        outcome: 'Stock is sufficient',
        branches: [{ condition: 'Stock is insufficient', toStepId: 's2' }],
      },
      { id: 's2', actor: 'Ordering service', action: 'Refuses the order', outcome: 'The operator is told why' },
    ],
  },
  [IntentKind.BusinessRule]: {
    condition: 'An order requests more units than the warehouse holds',
    requiredOutcome: 'The order is refused and no stock is reserved',
    observer: 'Store operator',
    exceptions: ['A backorder-enabled operator may exceed stock by one unit'],
  },
  [IntentKind.Limitation]: {
    constraint: 'Orders cover one warehouse only',
    reason: 'Cross-warehouse transfer has no reviewed product decision',
    affects: 'Widget ordering',
  },
  [IntentKind.Decision]: {
    question: 'How should the product handle an order that exceeds stock?',
    choice: 'Refuse the order at submission time',
    choiceStatus: 'accepted',
    rationale: 'Refusing early keeps stock and order state consistent',
    alternatives: ['Reserve stock optimistically and reconcile later'],
    consequences: ['Operators retry after restock'],
  },
};

describe('validateIntentPayload — error reports are bounded (BR-14 reporting half)', () => {
  it('truncates a message that would echo a huge attacker-authored key', () => {
    const hugeKey = 'x'.repeat(50_000);
    const errors = validateIntentPayload(IntentKind.Limitation, {
      ...(VALID_PAYLOADS[IntentKind.Limitation] as object),
      [hugeKey]: 'payload',
    });
    expect(errors.length).toBeGreaterThan(0);
    for (const error of errors) {
      expect(error.message.length).toBeLessThanOrEqual(INTENT_ERROR_REPORT_LIMITS.messageChars);
    }
  });

  it('caps the error array and states how many were omitted', () => {
    const steps = Array.from({ length: 30 }, (_, index) => ({ id: `s${index}`, extraneous: 'nope' }));
    const errors = validateIntentPayload(IntentKind.Flow, { trigger: 't', terminationCondition: 'c', steps });

    expect(errors).toHaveLength(INTENT_ERROR_REPORT_LIMITS.errors + 1);
    const omitted = errors[errors.length - 1];
    expect(omitted?.code).toBe(IntentValidationCode.ErrorsOmitted);
    expect(omitted?.message).toMatch(/further validation error/);
  });
});

describe('validateIntentPayload — one payload, no file around it', () => {
  it('accepts a representative payload of every kind', () => {
    for (const [kind, payload] of Object.entries(VALID_PAYLOADS) as [IntentKind, unknown][]) {
      expect({ kind, errors: validateIntentPayload(kind, payload) }).toEqual({ kind, errors: [] });
    }
  });

  it('refuses an empty payload for every kind, always naming a field', () => {
    for (const kind of Object.values(IntentKind)) {
      const errors = validateIntentPayload(kind, {});
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.every((error) => error.path.length > 0)).toBe(true);
    }
  });

  it('paths a missing field relative to the payload itself', () => {
    const errors = validateIntentPayload(IntentKind.Capability, {
      outcome: 'An operator can place an order',
      beneficiary: 'Store operator',
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toEqual(['boundary']);
  });

  it('rejects an unknown payload key — the payload is not an escape hatch', () => {
    const errors = validateIntentPayload(IntentKind.Limitation, {
      constraint: 'One warehouse only',
      reason: 'Stock is modelled per warehouse',
      affects: 'Ordering',
      transcript: 'a pasted conversation',
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('transcript');
  });

  it('paths a nested payload failure exactly', () => {
    const errors = validateIntentPayload(IntentKind.Flow, {
      trigger: 'Operator submits the order form',
      terminationCondition: 'The order reaches accepted or refused',
      steps: [
        { id: 'submit', actor: 'Operator', action: 'Submit', outcome: 'Order created' },
        { id: 'check', actor: 'System', action: 'Check stock', outcome: 'Stock reserved', branches: [{}] },
      ],
    });
    expect(errors.map((error) => error.path)).toEqual([
      ['steps', 1, 'branches', 0, 'condition'],
      ['steps', 1, 'branches', 0, 'toStepId'],
    ]);
  });

  it('applies the flow semantics zod cannot express, without inventing a flow id', () => {
    const errors = validateIntentPayload(IntentKind.Flow, {
      trigger: 'Operator submits the order form',
      terminationCondition: 'The order reaches accepted or refused',
      steps: [
        {
          id: 'submit',
          actor: 'Operator',
          action: 'Submit',
          outcome: 'Order created',
          branches: [{ condition: 'stock missing', toStepId: 'nowhere' }],
        },
      ],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe(IntentValidationCode.InvalidFlowBranchTarget);
    expect(errors[0].path).toEqual(['steps', 0, 'branches', 0, 'toStepId']);
    expect(errors[0].message).not.toContain("flow '");
  });

  it('refuses a payload that is not an object at all', () => {
    expect(validateIntentPayload(IntentKind.Decision, 'a decision').length).toBeGreaterThan(0);
  });

  it('accepts an open decision only without a choice', () => {
    const open = {
      question: 'Should unsent punches upload before a forced logout?',
      choiceStatus: 'open',
      rationale: 'Employees lost punches after a forced logout; no rule was recorded.',
      alternatives: [],
      consequences: [],
    };
    expect(validateIntentPayload(IntentKind.Decision, open)).toEqual([]);
    expect(validateIntentPayload(IntentKind.Decision, { ...open, choice: 'Upload first' })).toEqual([
      expect.objectContaining({ path: ['choice'] }),
    ]);
    expect(validateIntentPayload(IntentKind.Decision, { ...open, choiceStatus: 'accepted' })).toEqual([
      expect.objectContaining({ path: ['choice'] }),
    ]);
  });
});
