import { describe, expect, it } from 'vitest';
import { NodeType } from '../types/graph.js';
import { readLegacyIntentFixtureJson, readValidIntentFixtureJson } from './__fixtures__/load.js';
import {
  INTENT_ERROR_REPORT_LIMITS,
  INTENT_LIMITS,
  IntentValidationCode,
  LEGACY_SCHEMA_REMEDIATION,
  formatIntentValidationErrors,
  validateIntentFile,
  validateIntentPayload,
} from './schema.js';
import {
  INTENT_ID_MAX_LENGTH,
  INTENT_ID_PREFIX_BY_KIND,
  INTENT_SLUG_PATTERN,
  IntentAuthority,
  IntentKind,
  IntentRelationType,
  IntentSourceKind,
} from './types.js';

function expectValid(input: unknown) {
  const result = validateIntentFile(input);
  if (!result.ok) {
    throw new Error(`expected valid file, got: ${formatIntentValidationErrors(result.errors)}`);
  }
  return result.file;
}

function expectErrors(input: unknown, options?: { expectedProjectId?: string }) {
  const result = validateIntentFile(input, options);
  if (result.ok) throw new Error('expected validation to fail');
  return result.errors;
}

describe('validateIntentFile — AC-1 every kind round-trips with its typed payload', () => {
  it('accepts one valid file carrying a representative item of every semantic kind', () => {
    const file = expectValid(readValidIntentFixtureJson());

    expect(file.schemaVersion).toBe(2);
    expect(file.projectId).toBe('sample-project');
    expect(file.items.map((i) => i.kind)).toEqual([
      IntentKind.Capability,
      IntentKind.UseCase,
      IntentKind.Flow,
      IntentKind.BusinessRule,
      IntentKind.Limitation,
      IntentKind.Decision,
    ]);
  });

  it('narrows each payload to its kind-specific required semantics', () => {
    const file = expectValid(readValidIntentFixtureJson());
    const byKind = new Map(file.items.map((item) => [item.kind, item]));

    const capability = byKind.get(IntentKind.Capability);
    if (capability?.kind !== IntentKind.Capability) throw new Error('missing capability');
    expect(capability.payload.outcome.length).toBeGreaterThan(0);
    expect(capability.payload.beneficiary).toBe('Store operator');
    expect(capability.payload.boundary.length).toBeGreaterThan(0);
    expect(capability.authority).toBe(IntentAuthority.Accepted);
    expect(capability.sources[0]?.kind).toBe(IntentSourceKind.Spec);
    expect(capability.codeAnchors?.[0]?.nodeType).toBe(NodeType.Function);

    const useCase = byKind.get(IntentKind.UseCase);
    if (useCase?.kind !== IntentKind.UseCase) throw new Error('missing use case');
    expect(useCase.payload.primaryActor).toBe('Store operator');
    expect(useCase.payload.trigger.length).toBeGreaterThan(0);
    expect(useCase.payload.preconditions).toHaveLength(2);
    expect(useCase.payload.successOutcome.length).toBeGreaterThan(0);
    expect(useCase.payload.failureOutcomes).toHaveLength(2);

    const flow = byKind.get(IntentKind.Flow);
    if (flow?.kind !== IntentKind.Flow) throw new Error('missing flow');
    expect(flow.payload.trigger.length).toBeGreaterThan(0);
    expect(flow.payload.terminationCondition.length).toBeGreaterThan(0);
    expect(flow.payload.steps.map((s) => s.id)).toEqual(['s1', 's2', 's3', 's4']);
    expect(flow.payload.steps[1]?.branches?.[0]?.toStepId).toBe('s4');
    expect(flow.payload.steps[0]?.actor).toBe('Store operator');
    expect(flow.payload.steps[0]?.action.length).toBeGreaterThan(0);
    expect(flow.payload.steps[0]?.outcome.length).toBeGreaterThan(0);

    const rule = byKind.get(IntentKind.BusinessRule);
    if (rule?.kind !== IntentKind.BusinessRule) throw new Error('missing business rule');
    expect(rule.payload.condition.length).toBeGreaterThan(0);
    expect(rule.payload.requiredOutcome.length).toBeGreaterThan(0);
    expect(rule.payload.observer).toBe('Store operator');
    expect(rule.payload.exceptions).toHaveLength(1);

    const limitation = byKind.get(IntentKind.Limitation);
    if (limitation?.kind !== IntentKind.Limitation) throw new Error('missing limitation');
    expect(limitation.payload.constraint.length).toBeGreaterThan(0);
    expect(limitation.payload.reason.length).toBeGreaterThan(0);
    expect(limitation.payload.affects).toBe('Widget ordering');

    const decision = byKind.get(IntentKind.Decision);
    if (decision?.kind !== IntentKind.Decision) throw new Error('missing decision');
    expect(decision.payload.question.length).toBeGreaterThan(0);
    expect(decision.payload.choice.length).toBeGreaterThan(0);
    expect(decision.payload.choiceStatus).toBe('accepted');
    expect(decision.payload.rationale.length).toBeGreaterThan(0);
    expect(decision.payload.alternatives).toHaveLength(1);
    expect(decision.payload.consequences).toHaveLength(2);
  });

  it('accepts every controlled relation type present in the fixture', () => {
    const file = expectValid(readValidIntentFixtureJson());
    expect(new Set(file.relations.map((r) => r.type))).toEqual(
      new Set([
        IntentRelationType.Contains,
        IntentRelationType.Governs,
        IntentRelationType.Constrains,
        IntentRelationType.Decides,
        IntentRelationType.DependsOn,
      ]),
    );
  });
});

describe('validateIntentFile — AC-2 semantic rejections carry actionable paths', () => {
  it('rejects a newer schema version distinctly, with remediation', () => {
    const raw = readValidIntentFixtureJson();
    raw.schemaVersion = 3;
    const errors = expectErrors(raw);
    expect(errors[0]?.code).toBe(IntentValidationCode.NewerSchemaVersion);
    expect(errors[0]?.path).toEqual(['schemaVersion']);
    expect(errors[0]?.message).toMatch(/upgrade/i);
  });

  it('rejects a non-numeric or unsupported schema version as a schema error', () => {
    const raw = readValidIntentFixtureJson();
    raw.schemaVersion = 'one';
    const errors = expectErrors(raw);
    expect(errors[0]?.code).toBe(IntentValidationCode.Schema);
    expect(errors[0]?.path).toEqual(['schemaVersion']);
  });

  it('rejects duplicate item IDs at the offending item path', () => {
    const raw = readValidIntentFixtureJson();
    const items = raw.items as Record<string, unknown>[];
    items.push({
      ...items[0],
      sources: [{ kind: IntentSourceKind.Spec, ref: 'spec/widget-ordering', localId: 'CAP-1-COPY' }],
    });
    const errors = expectErrors(raw);
    const dup = errors.find((e) => e.code === IntentValidationCode.DuplicateItemId);
    expect(dup?.path).toEqual(['items', 6, 'id']);
    expect(formatIntentValidationErrors(errors)).toContain('items[6].id');
  });

  it('rejects the same exact source identity used by two candidate items', () => {
    const raw = readValidIntentFixtureJson();
    const items = raw.items as Record<string, unknown>[];
    items[0] = { ...items[0], authority: IntentAuthority.Candidate };
    items[1] = {
      ...items[1],
      authority: IntentAuthority.Candidate,
      sources: [{ kind: IntentSourceKind.Spec, ref: 'spec/widget-ordering', localId: 'CAP-1' }],
    };
    const errors = expectErrors(raw);
    const dup = errors.find((e) => e.code === IntentValidationCode.DuplicateSourceIdentity);
    expect(dup?.path).toEqual(['items', 1, 'sources', 0]);
  });

  it('allows an accepted item and a candidate proposal to share one source identity', () => {
    const raw = readValidIntentFixtureJson();
    const items = raw.items as Record<string, unknown>[];
    items.push({
      ...items[0],
      id: 'cap-widget-ordering-proposal',
      authority: IntentAuthority.Candidate,
    });
    expectValid(raw);
  });

  it('rejects the same exact source identity repeated inside one item', () => {
    const raw = readValidIntentFixtureJson();
    const items = raw.items as Record<string, unknown>[];
    items[0] = {
      ...items[0],
      sources: [
        { kind: IntentSourceKind.Spec, ref: 'spec/widget-ordering', localId: 'CAP-1' },
        { kind: IntentSourceKind.Spec, ref: 'spec/widget-ordering', localId: 'CAP-1' },
      ],
    };
    const errors = expectErrors(raw);
    const dup = errors.find((e) => e.code === IntentValidationCode.DuplicateSourceIdentity);
    expect(dup?.path).toEqual(['items', 0, 'sources', 1]);
  });

  it('rejects an item with no source reference (BR-5)', () => {
    const raw = readValidIntentFixtureJson();
    const items = raw.items as Record<string, unknown>[];
    items[0] = { ...items[0], sources: [] };
    const errors = expectErrors(raw);
    expect(errors[0]?.path).toEqual(['items', 0, 'sources']);
  });

  it('rejects dangling relation endpoints on both sides', () => {
    const raw = readValidIntentFixtureJson();
    const relations = raw.relations as Record<string, unknown>[];
    relations[0] = { from: 'ghost-1', type: IntentRelationType.Contains, to: 'uc-place-widget-order' };
    relations[1] = { from: 'cap-widget-ordering', type: IntentRelationType.Contains, to: 'ghost-2' };
    const errors = expectErrors(raw);
    const dangling = errors.filter((e) => e.code === IntentValidationCode.DanglingRelationEndpoint);
    expect(dangling.map((e) => e.path)).toEqual([
      ['relations', 0, 'from'],
      ['relations', 1, 'to'],
    ]);
  });

  it('rejects a relation whose endpoint kinds are outside the controlled registry', () => {
    const raw = readValidIntentFixtureJson();
    const relations = raw.relations as Record<string, unknown>[];
    relations[0] = { from: 'cap-widget-ordering', type: IntentRelationType.Governs, to: 'uc-place-widget-order' };
    const errors = expectErrors(raw);
    const invalid = errors.find((e) => e.code === IntentValidationCode.InvalidRelationKindPair);
    expect(invalid?.path).toEqual(['relations', 0]);
    expect(invalid?.message).toMatch(/governs/);
  });

  it('rejects supersedes between two different kinds', () => {
    const raw = readValidIntentFixtureJson();
    const relations = raw.relations as Record<string, unknown>[];
    relations[0] = { from: 'cap-widget-ordering', type: IntentRelationType.Supersedes, to: 'uc-place-widget-order' };
    const errors = expectErrors(raw);
    expect(errors[0]?.code).toBe(IntentValidationCode.InvalidRelationKindPair);
  });

  it('accepts every allowed relation pair in the controlled registry', () => {
    const raw = readValidIntentFixtureJson();
    const items = raw.items as Record<string, unknown>[];
    // Its own source identity: two accepted items may not share one (BR-6).
    items.push({
      ...items[0],
      id: 'cap-widget-ordering-successor',
      sources: [{ kind: IntentSourceKind.Spec, ref: 'spec/widget-ordering', localId: 'cap-widget-ordering-successor' }],
    });
    raw.relations = [
      { from: 'cap-widget-ordering', type: IntentRelationType.Contains, to: 'uc-place-widget-order' },
      { from: 'uc-place-widget-order', type: IntentRelationType.Contains, to: 'flow-order-submission' },
      { from: 'br-orders-never-exceed-stock', type: IntentRelationType.Governs, to: 'cap-widget-ordering' },
      { from: 'lim-single-warehouse-orders', type: IntentRelationType.Constrains, to: 'br-orders-never-exceed-stock' },
      { from: 'dec-refuse-over-stock-orders', type: IntentRelationType.Decides, to: 'lim-single-warehouse-orders' },
      { from: 'flow-order-submission', type: IntentRelationType.DependsOn, to: 'uc-place-widget-order' },
      { from: 'cap-widget-ordering-successor', type: IntentRelationType.Supersedes, to: 'cap-widget-ordering' },
    ];
    expectValid(raw);
  });

  it('rejects a flow branch whose target step does not exist in the same flow', () => {
    const raw = readValidIntentFixtureJson();
    const items = raw.items as Record<string, unknown>[];
    const flow = items[2] as { payload: { steps: Record<string, unknown>[] } };
    flow.payload.steps[1] = {
      ...flow.payload.steps[1],
      branches: [{ condition: 'Stock is insufficient', toStepId: 's9' }],
    };
    const errors = expectErrors(raw);
    const invalid = errors.find((e) => e.code === IntentValidationCode.InvalidFlowBranchTarget);
    expect(invalid?.path).toEqual(['items', 2, 'payload', 'steps', 1, 'branches', 0, 'toStepId']);
  });

  it('rejects duplicate flow step IDs inside one flow', () => {
    const raw = readValidIntentFixtureJson();
    const items = raw.items as Record<string, unknown>[];
    const flow = items[2] as { payload: { steps: Record<string, unknown>[] } };
    flow.payload.steps[2] = { ...flow.payload.steps[2], id: 's1' };
    const errors = expectErrors(raw);
    const dup = errors.find((e) => e.code === IntentValidationCode.DuplicateFlowStepId);
    expect(dup?.path).toEqual(['items', 2, 'payload', 'steps', 2, 'id']);
  });

  it('rejects a project mismatch against the expected project', () => {
    const raw = readValidIntentFixtureJson();
    const errors = expectErrors(raw, { expectedProjectId: 'other-project' });
    const mismatch = errors.find((e) => e.code === IntentValidationCode.ProjectMismatch);
    expect(mismatch?.path).toEqual(['projectId']);
    expect(mismatch?.message).toContain('other-project');
  });

  it('accepts a matching expected project', () => {
    expectValid(readValidIntentFixtureJson());
    const result = validateIntentFile(readValidIntentFixtureJson(), { expectedProjectId: 'sample-project' });
    expect(result.ok).toBe(true);
  });

  it('reports an unsupported anchor node type at the anchor path', () => {
    const raw = readValidIntentFixtureJson();
    const items = raw.items as Record<string, unknown>[];
    const anchors = (items[0] as { codeAnchors: Record<string, unknown>[] }).codeAnchors;
    anchors[0] = { ...anchors[0], nodeType: NodeType.Route };
    const errors = expectErrors(raw);
    expect(errors[0]?.path).toEqual(['items', 0, 'codeAnchors', 0, 'nodeType']);
  });
});

describe('validateIntentFile — AC-11 the file cannot carry arbitrary or unbounded content', () => {
  it('rejects unknown keys at the file level', () => {
    const raw = readValidIntentFixtureJson();
    (raw as Record<string, unknown>).transcript = 'tool call log';
    const errors = expectErrors(raw);
    expect(errors[0]?.code).toBe(IntentValidationCode.Schema);
    expect(formatIntentValidationErrors(errors)).toMatch(/transcript/);
  });

  it('rejects unknown keys on an item, payload, source, and anchor', () => {
    for (const mutate of [
      (raw: Record<string, unknown>) => {
        const items = raw.items as Record<string, unknown>[];
        items[0] = { ...items[0], sourceBody: 'the whole spec text' };
      },
      (raw: Record<string, unknown>) => {
        const items = raw.items as Record<string, unknown>[];
        const item = items[0] as { payload: Record<string, unknown> };
        item.payload = { ...item.payload, prompt: 'system prompt' };
      },
      (raw: Record<string, unknown>) => {
        const items = raw.items as Record<string, unknown>[];
        const item = items[0] as { sources: Record<string, unknown>[] };
        item.sources[0] = { ...item.sources[0], body: 'raw markdown' };
      },
      (raw: Record<string, unknown>) => {
        const items = raw.items as Record<string, unknown>[];
        const item = items[0] as { codeAnchors: Record<string, unknown>[] };
        item.codeAnchors[0] = { ...item.codeAnchors[0], sourceCode: 'function placeOrder() {}' };
      },
    ]) {
      const raw = readValidIntentFixtureJson();
      mutate(raw);
      const errors = expectErrors(raw);
      expect(errors[0]?.code).toBe(IntentValidationCode.Schema);
    }
  });

  it('rejects an oversized statement, title, and payload text', () => {
    const raw = readValidIntentFixtureJson();
    const items = raw.items as Record<string, unknown>[];
    items[0] = { ...items[0], statement: 'x'.repeat(INTENT_LIMITS.statement + 1) };
    const errors = expectErrors(raw);
    expect(errors[0]?.path).toEqual(['items', 0, 'statement']);

    const raw2 = readValidIntentFixtureJson();
    const items2 = raw2.items as Record<string, unknown>[];
    items2[0] = { ...items2[0], title: 'x'.repeat(INTENT_LIMITS.title + 1) };
    expect(expectErrors(raw2)[0]?.path).toEqual(['items', 0, 'title']);

    const raw3 = readValidIntentFixtureJson();
    const items3 = raw3.items as Record<string, unknown>[];
    const item3 = items3[0] as { payload: Record<string, unknown> };
    item3.payload = { ...item3.payload, outcome: 'x'.repeat(INTENT_LIMITS.text + 1) };
    expect(expectErrors(raw3)[0]?.path).toEqual(['items', 0, 'payload', 'outcome']);
  });

  it('rejects an unbounded number of items, sources, list entries, and anchors', () => {
    const raw = readValidIntentFixtureJson();
    const items = raw.items as Record<string, unknown>[];
    raw.items = Array.from({ length: INTENT_LIMITS.items + 1 }, (_, i) => ({
      ...items[0],
      id: `cap-${i}`,
      sources: [{ kind: IntentSourceKind.Spec, ref: 'spec/widget-ordering', localId: `CAP-${i}` }],
    }));
    expect(expectErrors(raw)[0]?.path).toEqual(['items']);

    const raw2 = readValidIntentFixtureJson();
    const items2 = raw2.items as Record<string, unknown>[];
    items2[0] = {
      ...items2[0],
      sources: Array.from({ length: INTENT_LIMITS.sourcesPerItem + 1 }, (_, i) => ({
        kind: IntentSourceKind.Spec,
        ref: 'spec/widget-ordering',
        localId: `S-${i}`,
      })),
    };
    expect(expectErrors(raw2)[0]?.path).toEqual(['items', 0, 'sources']);

    const raw3 = readValidIntentFixtureJson();
    const items3 = raw3.items as Record<string, unknown>[];
    const useCase = items3[1] as { payload: Record<string, unknown> };
    useCase.payload = {
      ...useCase.payload,
      preconditions: Array.from({ length: INTENT_LIMITS.listEntries + 1 }, (_, i) => `p${i}`),
    };
    expect(expectErrors(raw3)[0]?.path).toEqual(['items', 1, 'payload', 'preconditions']);

    const raw4 = readValidIntentFixtureJson();
    const items4 = raw4.items as Record<string, unknown>[];
    const anchor = (items4[0] as { codeAnchors: Record<string, unknown>[] }).codeAnchors[0];
    items4[0] = {
      ...items4[0],
      codeAnchors: Array.from({ length: INTENT_LIMITS.anchorsPerItem + 1 }, (_, i) => ({
        ...anchor,
        nodeId: `aaaa:function:src/widgets/order.ts:fn${i}`,
      })),
    };
    expect(expectErrors(raw4)[0]?.path).toEqual(['items', 0, 'codeAnchors']);
  });
});

describe('validateIntentFile — error reports are bounded (BR-14 reporting half)', () => {
  it('truncates a message that would echo a huge attacker-authored key', () => {
    const raw = readValidIntentFixtureJson();
    const hugeKey = 'x'.repeat(50_000);
    (raw as Record<string, unknown>)[hugeKey] = 'payload';
    const errors = expectErrors(raw);
    for (const error of errors) {
      expect(error.message.length).toBeLessThanOrEqual(INTENT_ERROR_REPORT_LIMITS.messageChars);
    }
    expect(formatIntentValidationErrors(errors).length).toBeLessThan(hugeKey.length);
  });

  it('caps the error array and states how many were omitted', () => {
    const raw = readValidIntentFixtureJson();
    const items = raw.items as Record<string, unknown>[];
    // 30+ independent shape failures: every item loses its title and gains an unknown key.
    const broken: Record<string, unknown>[] = [];
    for (let i = 0; i < 6; i++) {
      for (const item of items) {
        broken.push({ ...item, id: `${item.id}-${i}`, title: 123, extraneous: 'nope' });
      }
    }
    raw.items = broken;
    raw.relations = [];

    const errors = expectErrors(raw);

    expect(errors).toHaveLength(INTENT_ERROR_REPORT_LIMITS.errors + 1);
    const omitted = errors[errors.length - 1];
    expect(omitted?.code).toBe(IntentValidationCode.ErrorsOmitted);
    expect(omitted?.message).toMatch(/further validation error/);
  });
});

describe('validateIntentFile — source identity is (ref, localId) within an authority class', () => {
  it('rejects two accepted items sharing one source identity, naming both positions', () => {
    const raw = readValidIntentFixtureJson();
    const items = raw.items as Record<string, unknown>[];
    items[1] = {
      ...items[1],
      sources: [{ kind: IntentSourceKind.Spec, ref: 'spec/widget-ordering', localId: 'CAP-1' }],
    };
    const errors = expectErrors(raw);
    const dup = errors.find((e) => e.code === IntentValidationCode.DuplicateSourceIdentity);
    expect(dup?.path).toEqual(['items', 1, 'sources', 0]);
    expect(dup?.message).toContain('cap-widget-ordering');
    expect(dup?.message).toContain('items[0].sources[0]');
  });

  it('still allows an accepted item and a candidate to share one source identity (BR-2)', () => {
    const raw = readValidIntentFixtureJson();
    const items = raw.items as Record<string, unknown>[];
    items.push({ ...items[0], id: 'cap-widget-ordering-proposal', authority: IntentAuthority.Candidate });
    expectValid(raw);
  });

  it('rejects one identity shared by two items even when their source kinds differ', () => {
    const raw = readValidIntentFixtureJson();
    const items = raw.items as Record<string, unknown>[];
    items[1] = {
      ...items[1],
      sources: [{ kind: IntentSourceKind.Issue, ref: 'spec/widget-ordering', localId: 'CAP-1' }],
    };
    const errors = expectErrors(raw);
    expect(errors.some((e) => e.code === IntentValidationCode.DuplicateSourceIdentity)).toBe(true);
  });
});

// AC-14 — slug identity and the domain registry
describe('validateIntentFile — AC-14 slug ids carry their kind prefix (BR-16)', () => {
  it('accepts the fixture ids and reports each kind prefix', () => {
    const file = expectValid(readValidIntentFixtureJson());
    for (const item of file.items) {
      expect(item.id.startsWith(`${INTENT_ID_PREFIX_BY_KIND[item.kind]}-`)).toBe(true);
      expect(INTENT_SLUG_PATTERN.test(item.id)).toBe(true);
    }
  });

  it('rejects a legacy numeric id at the item path', () => {
    const raw = readValidIntentFixtureJson();
    const items = raw.items as Record<string, unknown>[];
    items[0] = { ...items[0], id: 'CAP-1' };
    const errors = expectErrors(raw);
    const invalid = errors.find((e) => e.code === IntentValidationCode.InvalidItemId);
    expect(invalid?.path).toEqual(['items', 0, 'id']);
    expect(invalid?.message).toContain('cap-');
  });

  it('rejects an id whose prefix belongs to another kind', () => {
    const raw = readValidIntentFixtureJson();
    const items = raw.items as Record<string, unknown>[];
    // items[3] is the business rule; a `cap-` prefix is a kind mismatch.
    items[3] = { ...items[3], id: 'cap-orders-never-exceed-stock' };
    const errors = expectErrors(raw);
    const invalid = errors.find((e) => e.code === IntentValidationCode.InvalidItemId);
    expect(invalid?.path).toEqual(['items', 3, 'id']);
    expect(invalid?.message).toContain("'br-' prefix");
  });

  it('rejects a bare prefix with no slug word of its own', () => {
    const raw = readValidIntentFixtureJson();
    const items = raw.items as Record<string, unknown>[];
    items[0] = { ...items[0], id: 'cap' };
    expect(expectErrors(raw)[0]?.code).toBe(IntentValidationCode.InvalidItemId);
  });

  it('rejects an id longer than the cap as a schema bound', () => {
    const raw = readValidIntentFixtureJson();
    const items = raw.items as Record<string, unknown>[];
    items[0] = { ...items[0], id: `cap-${'x'.repeat(INTENT_ID_MAX_LENGTH)}` };
    expect(expectErrors(raw)[0]?.path).toEqual(['items', 0, 'id']);
  });

  it('rejects two items sharing one slug id', () => {
    const raw = readValidIntentFixtureJson();
    const items = raw.items as Record<string, unknown>[];
    items.push({
      ...items[0],
      sources: [{ kind: IntentSourceKind.Spec, ref: 'spec/widget-ordering', localId: 'CAP-1-DUPLICATE' }],
    });
    expect(expectErrors(raw).some((e) => e.code === IntentValidationCode.DuplicateItemId)).toBe(true);
  });
});

describe('validateIntentFile — AC-14 the domain registry is controlled (BR-18/BR-19)', () => {
  it('accepts a declared-but-unused domain', () => {
    const file = expectValid(readValidIntentFixtureJson());
    const used = new Set(file.items.map((item) => item.domain));
    expect(file.domains.some((domain) => !used.has(domain.id))).toBe(true);
  });

  it('rejects an item referencing an undeclared domain, naming the declared ids', () => {
    const raw = readValidIntentFixtureJson();
    const items = raw.items as Record<string, unknown>[];
    items[0] = { ...items[0], domain: 'payments' };
    const errors = expectErrors(raw);
    const undeclared = errors.find((e) => e.code === IntentValidationCode.UndeclaredDomain);
    expect(undeclared?.path).toEqual(['items', 0, 'domain']);
    expect(undeclared?.message).toContain('ordering');
    expect(undeclared?.message).toContain('stock');
  });

  it('rejects removing a domain that items still reference (the stranded-item case)', () => {
    const raw = readValidIntentFixtureJson();
    raw.domains = (raw.domains as Record<string, unknown>[]).filter((domain) => domain.id !== 'stock');
    const errors = expectErrors(raw);
    const stranded = errors.filter((e) => e.code === IntentValidationCode.UndeclaredDomain);
    expect(stranded.length).toBeGreaterThan(0);
    expect(stranded[0]?.message).toContain('stock');
  });

  it('rejects a non-slug domain id', () => {
    const raw = readValidIntentFixtureJson();
    const domains = raw.domains as Record<string, unknown>[];
    domains[0] = { ...domains[0], id: 'Order Capture' };
    const errors = expectErrors(raw);
    const invalid = errors.find((e) => e.code === IntentValidationCode.InvalidDomainId);
    expect(invalid?.path).toEqual(['domains', 0, 'id']);
  });

  it('rejects a duplicate domain id', () => {
    const raw = readValidIntentFixtureJson();
    const domains = raw.domains as Record<string, unknown>[];
    domains.push({ id: 'ordering', title: 'Ordering (again)' });
    const errors = expectErrors(raw);
    const dup = errors.find((e) => e.code === IntentValidationCode.DuplicateDomainId);
    expect(dup?.path).toEqual(['domains', 3, 'id']);
  });

  it('rejects a missing domain registry and a missing item domain as shape errors', () => {
    const { domains: _domains, ...withoutRegistry } = readValidIntentFixtureJson();
    expect(expectErrors(withoutRegistry)[0]?.path).toEqual(['domains']);

    const withoutItemDomain = readValidIntentFixtureJson();
    const items = withoutItemDomain.items as Record<string, unknown>[];
    const { domain: _domain, ...noDomain } = items[0] as Record<string, unknown>;
    items[0] = noDomain;
    expect(expectErrors(withoutItemDomain)[0]?.path).toEqual(['items', 0, 'domain']);
  });
});

// AC-20 / BR-22 — a v1 overlay is refused with migration remediation
describe('validateIntentFile — AC-20 the pre-migration v1 shape is refused', () => {
  it('refuses a real v1 file with the migration remediation, not a shape error', () => {
    const errors = expectErrors(readLegacyIntentFixtureJson());
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe(IntentValidationCode.LegacySchemaVersion);
    expect(errors[0]?.path).toEqual(['schemaVersion']);
    expect(errors[0]?.message).toBe(LEGACY_SCHEMA_REMEDIATION);
    expect(errors[0]?.message).toMatch(/migration/i);
  });

  it('is distinct from the newer-schema refusal and from a generic invalid file', () => {
    const newer = readValidIntentFixtureJson();
    newer.schemaVersion = 3;
    expect(expectErrors(newer)[0]?.code).toBe(IntentValidationCode.NewerSchemaVersion);

    const generic = readValidIntentFixtureJson();
    (generic.items as Record<string, unknown>[])[0] = { ...(generic.items as Record<string, unknown>[])[0], title: 12 };
    expect(expectErrors(generic)[0]?.code).toBe(IntentValidationCode.Schema);
  });

  it('never partially loads a v1 file', () => {
    const result = validateIntentFile(readLegacyIntentFixtureJson());
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('file');
  });
});

describe('validateIntentFile — relations connect two distinct items', () => {
  it('rejects a self-referential relation', () => {
    const raw = readValidIntentFixtureJson();
    const relations = raw.relations as Record<string, unknown>[];
    relations[0] = { from: 'cap-widget-ordering', type: IntentRelationType.Supersedes, to: 'cap-widget-ordering' };
    const errors = expectErrors(raw);
    const self = errors.find((e) => e.code === IntentValidationCode.SelfReferentialRelation);
    expect(self?.path).toEqual(['relations', 0]);
    expect(self?.message).toContain('cap-widget-ordering');
  });
});

describe('validateIntentPayload — one payload, no file around it', () => {
  it('accepts every payload the valid fixture ships', () => {
    const items = readValidIntentFixtureJson().items as { id: string; kind: IntentKind; payload: unknown }[];
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect({ id: item.id, errors: validateIntentPayload(item.kind, item.payload) }).toEqual({
        id: item.id,
        errors: [],
      });
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
});
