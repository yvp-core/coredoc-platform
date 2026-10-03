import { describe, expect, it } from 'vitest';
import {
  IntentAc10Verdict,
  IntentLookupKind,
  IntentToolShape,
  analyzeIntentRun,
  extractIntentInteractions,
} from './analyze-intent.js';
import { IntentPromptShape } from '../cases-intent/tasks.js';

/** Minimal Claude-SDK transcript shape: assistant tool_use + user tool_result. */
function transcript(
  calls: Array<{ name: string; input: unknown; id?: string; result?: string }>,
): unknown[] {
  const messages: unknown[] = [];
  calls.forEach((call, index) => {
    const id = call.id ?? `tu_${index}`;
    messages.push({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: call.name, input: call.input, id }] },
    });
    messages.push({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: call.result ?? 'ok' }] }],
      },
    });
  });
  return messages;
}

const INTENT_TOOL = 'mcp__coredoc-eval__get_intent_context';
const READ_TOOL = 'mcp__coredoc-eval__intent_read';
const ROUTED = { shape: IntentPromptShape.Routed, routedIntentIds: ['BR-2', 'CAP-1'] };
const OPEN = { shape: IntentPromptShape.Open, routedIntentIds: [] as string[] };

describe('extractIntentInteractions', () => {
  it('decodes MCP tool inputs', () => {
    const events = extractIntentInteractions(
      transcript([{ name: INTENT_TOOL, input: { intentIds: ['BR-2'], includeCandidates: true } }]),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      shape: IntentToolShape.Context,
      intentIds: ['BR-2'],
      includeCandidates: true,
      nodeIds: [],
    });
    expect(events[0]!.query).toBeUndefined();
  });

  it('decodes intent_read calls: tree is the index, node and search are discovery', () => {
    const events = extractIntentInteractions(
      transcript([
        { name: READ_TOOL, input: { action: 'tree' } },
        { name: READ_TOOL, input: { action: 'node', domain: 'pricing', includeCandidates: true } },
        { name: READ_TOOL, input: { action: 'search', query: 'rounding' } },
      ]),
    );
    expect(events.map((event) => [event.shape, event.kind, event.broad])).toEqual([
      [IntentToolShape.Read, IntentLookupKind.Index, false],
      [IntentToolShape.Read, IntentLookupKind.Discovery, true],
      [IntentToolShape.Read, IntentLookupKind.Discovery, true],
    ]);
    expect(events[1]).toMatchObject({ includeCandidates: true, intentIds: [] });
    expect(events[2]!.query).toBe('rounding');
  });

  it('counts the cloud context selectors beyond query and nodeIds as discovery', () => {
    const kinds = extractIntentInteractions(
      transcript([
        { name: INTENT_TOOL, input: { task: { text: 'add a service fee' } } },
        { name: INTENT_TOOL, input: { sourceRefs: ['spec/widget-ordering'] } },
        { name: INTENT_TOOL, input: { files: [{ repoKey: 'fixture-repo', path: 'src/a.ts' }] } },
        { name: INTENT_TOOL, input: { domain: 'pricing' } },
        { name: INTENT_TOOL, input: { mode: 'list', domain: 'pricing' } },
        { name: INTENT_TOOL, input: { intentIds: ['BR-2'], task: { text: 'fee' } } },
      ]),
    ).map((event) => event.kind);
    expect(kinds).toEqual([
      IntentLookupKind.Discovery,
      IntentLookupKind.Discovery,
      IntentLookupKind.Discovery,
      IntentLookupKind.Discovery,
      IntentLookupKind.Index,
      IntentLookupKind.Mixed,
    ]);
  });

  it('no longer reads the retired `coredoc intent context` CLI as an intent interaction', () => {
    const events = extractIntentInteractions(
      transcript([{ name: 'Bash', input: { command: 'coredoc intent context -p intent-eval --id BR-2' } }]),
    );
    expect(events).toEqual([]);
  });

  it('ignores unrelated MCP and base tools', () => {
    const events = extractIntentInteractions(
      transcript([
        { name: 'mcp__coredoc-eval__search_symbols', input: { query: 'roundCurrency' } },
        { name: 'Read', input: { file_path: '/repo/src/formatting/money.ts' } },
      ]),
    );
    expect(events).toEqual([]);
  });
});

describe('analyzeIntentRun — routed tasks', () => {
  it('passes when exactly the routed ids are fetched with no broad lookup', () => {
    const analysis = analyzeIntentRun({
      arm: 'intent',
      task: ROUTED,
      transcript: transcript([{ name: INTENT_TOOL, input: { intentIds: ['BR-2', 'CAP-1'] } }]),
    });
    expect(analysis.verdict).toBe(IntentAc10Verdict.Pass);
    expect(analysis.interactions).toBe(1);
    expect(analysis.broadLookups).toBe(0);
  });

  // Verdict must FLIP on a routed id re-fetched broadly (Acceptance 2a).
  it('fails when a routed id is re-fetched through a broad query', () => {
    const analysis = analyzeIntentRun({
      arm: 'intent',
      task: ROUTED,
      transcript: transcript([
        { name: INTENT_TOOL, input: { intentIds: ['BR-2', 'CAP-1'] } },
        { name: INTENT_TOOL, input: { query: 'rounding' } },
      ]),
    });
    expect(analysis.verdict).toBe(IntentAc10Verdict.Violation);
    expect(analysis.reasons.join(' ')).toMatch(/broad lookup/i);
  });

  it('fails when an id nobody routed is fetched', () => {
    const analysis = analyzeIntentRun({
      arm: 'intent',
      task: ROUTED,
      transcript: transcript([{ name: INTENT_TOOL, input: { intentIds: ['BR-2', 'LIM-1'] } }]),
    });
    expect(analysis.verdict).toBe(IntentAc10Verdict.Violation);
    expect(analysis.unroutedIds).toEqual(['LIM-1']);
  });
});

describe('analyzeIntentRun — open tasks', () => {
  it('allows exactly one broad lookup per stage', () => {
    const analysis = analyzeIntentRun({
      arm: 'intent',
      task: OPEN,
      transcript: transcript([
        { name: INTENT_TOOL, input: { query: 'warehouse fulfilment' } },
        { name: INTENT_TOOL, input: { intentIds: ['LIM-1'] } },
      ]),
    });
    expect(analysis.verdict).toBe(IntentAc10Verdict.Pass);
    expect(analysis.broadLookups).toBe(1);
  });

  // Verdict must FLIP on two broad lookups (Acceptance 2b).
  it('fails on a second broad lookup', () => {
    const analysis = analyzeIntentRun({
      arm: 'intent',
      task: OPEN,
      transcript: transcript([
        { name: INTENT_TOOL, input: { query: 'warehouse fulfilment' } },
        { name: INTENT_TOOL, input: { nodeIds: ['abc:function:src/x.ts:y'] } },
      ]),
    });
    expect(analysis.verdict).toBe(IntentAc10Verdict.Violation);
    expect(analysis.broadLookups).toBe(2);
  });
});

describe('analyzeIntentRun — adoption and contamination', () => {
  // Acceptance 2's passes-while-broken: zero calls are vacuously within bounds.
  it('reports no-adoption when the intent arm never touches the tool', () => {
    const analysis = analyzeIntentRun({
      arm: 'intent',
      task: ROUTED,
      transcript: transcript([{ name: 'Read', input: { file_path: '/repo/src/orders/order-service.ts' } }]),
    });
    expect(analysis.verdict).toBe(IntentAc10Verdict.NoAdoption);
  });

  it('marks a leaking baseline arm as a contaminated control and records the overlay reads', () => {
    const analysis = analyzeIntentRun({
      arm: 'baseline',
      task: ROUTED,
      transcript: transcript([
        { name: 'Read', input: { file_path: '/repo/fixture-repo/.coredoc/intent.json' } },
        { name: INTENT_TOOL, input: { intentIds: ['BR-2'] } },
      ]),
    });
    expect(analysis.verdict).toBe(IntentAc10Verdict.ContaminatedControl);
    expect(analysis.overlayFileReads).toBe(1);
    expect(analysis.reasons.join(' ')).toMatch(/leak/i);
  });

  it('counts an overlay read performed through Grep or a shell command', () => {
    const analysis = analyzeIntentRun({
      arm: 'baseline',
      task: OPEN,
      transcript: transcript([
        { name: 'Grep', input: { pattern: 'BR-2', path: '.coredoc/intent.json' } },
        { name: 'Bash', input: { command: 'cat .coredoc/intent.json' } },
      ]),
    });
    expect(analysis.overlayFileReads).toBe(2);
  });
});

describe('analyzeIntentRun — refused calls', () => {
  /** A tool_use whose tool_result came back as an error (permission denial). */
  function deniedTranscript(name: string, input: unknown): unknown[] {
    return [
      { type: 'assistant', message: { content: [{ type: 'tool_use', name, input, id: 'tu_denied' }] } },
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_denied',
              is_error: true,
              content: [{ type: 'text', text: "Claude requested permissions to use it, but you haven't granted it yet." }],
            },
          ],
        },
      },
    ];
  }

  it('does not count a refused call as a baseline leak — the allowlist held', () => {
    const analysis = analyzeIntentRun({
      arm: 'baseline',
      task: OPEN,
      transcript: deniedTranscript(INTENT_TOOL, { query: 'warehouse stock' }),
    });
    expect(analysis.deniedInteractions).toBe(1);
    expect(analysis.interactions).toBe(0);
    expect(analysis.reasons.join(' ')).not.toMatch(/leak/i);
    expect(analysis.reasons.join(' ')).toMatch(/refused|denied/i);
  });

  it('does not let a refused call count toward the broad-lookup bound or toward adoption', () => {
    const analysis = analyzeIntentRun({
      arm: 'intent',
      task: OPEN,
      transcript: [
        ...deniedTranscript(INTENT_TOOL, { query: 'first attempt' }),
        ...transcript([{ name: INTENT_TOOL, input: { query: 'second attempt' } }]),
      ],
    });
    expect(analysis.broadLookups).toBe(1);
    expect(analysis.verdict).toBe(IntentAc10Verdict.Pass);
  });

  it('still reports no-adoption when every interaction was refused', () => {
    const analysis = analyzeIntentRun({
      arm: 'intent',
      task: OPEN,
      transcript: deniedTranscript(INTENT_TOOL, { query: 'only attempt' }),
    });
    expect(analysis.verdict).toBe(IntentAc10Verdict.NoAdoption);
  });
});

describe('analyzeIntentRun — broad-lookup classification (review P1-1, P1-3)', () => {
  // A selector-less call is the BROADEST lookup the engine serves: it returns
  // every accepted item up to the limit.
  it('counts a selector-less call as a broad lookup on a routed task', () => {
    const analysis = analyzeIntentRun({
      arm: 'intent',
      task: ROUTED,
      transcript: transcript([
        { name: INTENT_TOOL, input: { intentIds: ['BR-2', 'CAP-1'] } },
        { name: INTENT_TOOL, input: {} },
      ]),
    });
    expect(analysis.broadLookups).toBe(1);
    expect(analysis.verdict).toBe(IntentAc10Verdict.Violation);
    expect(analysis.reasons.join(' ')).toMatch(/selector-less/i);
  });

  it('counts two selector-less calls as two broad lookups on an open task', () => {
    const analysis = analyzeIntentRun({
      arm: 'intent',
      task: OPEN,
      transcript: transcript([
        { name: INTENT_TOOL, input: {} },
        { name: INTENT_TOOL, input: { includeCandidates: true } },
      ]),
    });
    expect(analysis.broadLookups).toBe(2);
    expect(analysis.verdict).toBe(IntentAc10Verdict.Violation);
  });

  // `mode: "list"` is the payload-free index (issue 10, BR-23/BR-26): cheaper
  // than the query call it replaces, so it must not consume the one broad
  // lookup a stage is allowed.
  it('exempts a list-mode call from the broad-lookup bound and counts it separately', () => {
    const analysis = analyzeIntentRun({
      arm: 'intent',
      task: OPEN,
      transcript: transcript([
        { name: INTENT_TOOL, input: { mode: 'list' } },
        { name: INTENT_TOOL, input: { query: 'rounding' } },
      ]),
    });
    expect(analysis.broadLookups).toBe(1);
    expect(analysis.indexCalls).toBe(1);
    expect(analysis.broadByKind.index).toBe(1);
    expect(analysis.verdict).toBe(IntentAc10Verdict.Pass);
    expect(analysis.reasons.join(' ')).not.toMatch(/selector-less/i);
  });

  it('still flags two query calls on an open task even when a list call preceded them', () => {
    const analysis = analyzeIntentRun({
      arm: 'intent',
      task: OPEN,
      transcript: transcript([
        { name: INTENT_TOOL, input: { mode: 'list' } },
        { name: INTENT_TOOL, input: { query: 'rounding' } },
        { name: INTENT_TOOL, input: { query: 'fees' } },
      ]),
    });
    expect(analysis.broadLookups).toBe(2);
    expect(analysis.indexCalls).toBe(1);
    expect(analysis.verdict).toBe(IntentAc10Verdict.Violation);
  });

  // The MCP tool rejects a list call carrying context selectors (BR-28), so the
  // shape is judged by the selectors it named, not exempted by its mode.
  it('classifies a list-mode call that also names selectors by those selectors', () => {
    const analysis = analyzeIntentRun({
      arm: 'intent',
      task: OPEN,
      transcript: transcript([{ name: INTENT_TOOL, input: { mode: 'list', query: 'rounding' } }]),
    });
    expect(analysis.indexCalls).toBe(0);
    expect(analysis.broadByKind.discovery).toBe(1);
    expect(analysis.broadLookups).toBe(1);
  });

  // intentIds + query in ONE call still runs discovery engine-side.
  it('counts a mixed exact+discovery call as a broad lookup and still records the ids', () => {
    const analysis = analyzeIntentRun({
      arm: 'intent',
      task: { shape: IntentPromptShape.Routed, routedIntentIds: ['BR-2'] },
      transcript: transcript([{ name: INTENT_TOOL, input: { intentIds: ['BR-2'], query: 'rounding' } }]),
    });
    expect(analysis.broadLookups).toBe(1);
    expect(analysis.fetchedIds).toEqual(['BR-2']);
    expect(analysis.verdict).toBe(IntentAc10Verdict.Violation);
    expect(analysis.reasons.join(' ')).toMatch(/discovery|combined/i);
  });

  it('spends the one broad lookup across both cloud tools', () => {
    const analysis = analyzeIntentRun({
      arm: 'intent',
      task: OPEN,
      transcript: transcript([
        { name: READ_TOOL, input: { action: 'tree' } },
        { name: READ_TOOL, input: { action: 'search', query: 'rounding' } },
        { name: INTENT_TOOL, input: { query: 'discount' } },
      ]),
    });
    expect(analysis.indexCalls).toBe(1);
    expect(analysis.broadLookups).toBe(2);
    expect(analysis.verdict).toBe(IntentAc10Verdict.Violation);
  });

  it('treats an intent_read call on a routed task as a broad lookup, never as an exact fetch', () => {
    const analysis = analyzeIntentRun({
      arm: 'intent',
      task: ROUTED,
      transcript: transcript([
        { name: INTENT_TOOL, input: { intentIds: ['BR-2', 'CAP-1'] } },
        { name: READ_TOOL, input: { action: 'node', domain: 'pricing' } },
      ]),
    });
    expect(analysis.fetchedIds).toEqual(['BR-2', 'CAP-1']);
    expect(analysis.broadLookups).toBe(1);
    expect(analysis.verdict).toBe(IntentAc10Verdict.Violation);
  });

  it('flags a control that answered an intent_read call as contaminated', () => {
    const analysis = analyzeIntentRun({
      arm: 'baseline',
      task: OPEN,
      transcript: transcript([{ name: READ_TOOL, input: { action: 'tree' } }]),
    });
    expect(analysis.verdict).toBe(IntentAc10Verdict.ContaminatedControl);
  });
});

describe('analyzeIntentRun — routed ids must actually be fetched (review P1-2)', () => {
  it('fails a routed task whose only call fetched nothing by id', () => {
    const analysis = analyzeIntentRun({
      arm: 'intent',
      task: ROUTED,
      transcript: transcript([{ name: INTENT_TOOL, input: {} }]),
    });
    expect(analysis.verdict).toBe(IntentAc10Verdict.Violation);
    expect(analysis.missingRoutedIds).toEqual(['BR-2', 'CAP-1']);
    expect(analysis.reasons.join(' ')).toMatch(/never fetched/i);
  });

  it('fails when only part of the routed set was fetched', () => {
    const analysis = analyzeIntentRun({
      arm: 'intent',
      task: ROUTED,
      transcript: transcript([{ name: INTENT_TOOL, input: { intentIds: ['BR-2'] } }]),
    });
    expect(analysis.verdict).toBe(IntentAc10Verdict.Violation);
    expect(analysis.missingRoutedIds).toEqual(['CAP-1']);
  });

  it('accepts the routed set fetched across several exact calls', () => {
    const analysis = analyzeIntentRun({
      arm: 'intent',
      task: ROUTED,
      transcript: transcript([
        { name: INTENT_TOOL, input: { intentIds: ['BR-2'] } },
        { name: INTENT_TOOL, input: { intentIds: ['CAP-1'] } },
      ]),
    });
    expect(analysis.verdict).toBe(IntentAc10Verdict.Pass);
    expect(analysis.missingRoutedIds).toEqual([]);
  });
});

describe('analyzeIntentRun — contamination is gating (review P1-5)', () => {
  it('fails the intent arm when it read the overlay file directly', () => {
    const analysis = analyzeIntentRun({
      arm: 'intent',
      task: ROUTED,
      transcript: transcript([
        { name: INTENT_TOOL, input: { intentIds: ['BR-2', 'CAP-1'] } },
        { name: 'Read', input: { file_path: '/repo/fixture-repo/.coredoc/intent.json' } },
      ]),
    });
    expect(analysis.overlayFileReads).toBe(1);
    expect(analysis.verdict).toBe(IntentAc10Verdict.Violation);
  });

  it('marks a baseline arm that was answered intent as a contaminated control', () => {
    const analysis = analyzeIntentRun({
      arm: 'baseline',
      task: OPEN,
      transcript: transcript([{ name: INTENT_TOOL, input: { query: 'warehouse stock' } }]),
    });
    expect(analysis.verdict).toBe(IntentAc10Verdict.ContaminatedControl);
  });

  it('marks a baseline arm that read the overlay file as a contaminated control', () => {
    const analysis = analyzeIntentRun({
      arm: 'baseline',
      task: OPEN,
      transcript: transcript([{ name: 'Bash', input: { command: 'cat .coredoc/intent.json' } }]),
    });
    expect(analysis.verdict).toBe(IntentAc10Verdict.ContaminatedControl);
  });

  it('marks a baseline arm that read the cloud seed file as a contaminated control', () => {
    const analysis = analyzeIntentRun({
      arm: 'baseline',
      task: OPEN,
      transcript: transcript([
        { name: 'Read', input: { file_path: '/repo/evals/cases-intent/seed-intent.json' } },
      ]),
    });
    expect(analysis.overlayFileReads).toBe(1);
    expect(analysis.verdict).toBe(IntentAc10Verdict.ContaminatedControl);
  });

  it('leaves a clean baseline arm as not-applicable', () => {
    const analysis = analyzeIntentRun({
      arm: 'baseline',
      task: OPEN,
      transcript: transcript([{ name: 'Read', input: { file_path: '/repo/src/stock/stock-guard.ts' } }]),
    });
    expect(analysis.verdict).toBe(IntentAc10Verdict.NotApplicable);
  });
});

/**
 * D9 (2026-08-27): on a routed task, fetching an id the SESSION already saw —
 * an item id or a relation endpoint in an earlier tool response — is exactly
 * the exact-ID-first navigation BR-8 asks for, not an unrouted fetch. Only ids
 * that came from nowhere (never routed, never returned) stay violations.
 */
describe('analyzeIntentRun — ids derived from earlier responses (D9)', () => {
  /** The `get_intent_context` payload shape, trimmed to the fields that carry ids. */
  function contextResponse(items: string[], relations: Array<[string, string]>): string {
    return JSON.stringify({
      project: { id: 'intent-eval', repo: 'fixture-repo' },
      overlayStatus: 'ready',
      items: items.map((id) => ({ id, kind: 'business_rule', authority: 'accepted' })),
      relations: relations.map(([from, to]) => ({ from, type: 'governs', to })),
    });
  }

  it('accepts an exact fetch of an id a prior response returned as a relation endpoint', () => {
    const analysis = analyzeIntentRun({
      arm: 'intent',
      task: ROUTED,
      transcript: transcript([
        {
          name: INTENT_TOOL,
          input: { intentIds: ['BR-2', 'CAP-1'] },
          result: contextResponse(['BR-2', 'CAP-1'], [['LIM-1', 'CAP-1']]),
        },
        { name: INTENT_TOOL, input: { intentIds: ['LIM-1'] } },
      ]),
    });
    expect(analysis.verdict).toBe(IntentAc10Verdict.Pass);
    expect(analysis.derivedIds).toEqual(['LIM-1']);
    expect(analysis.unroutedIds).toEqual([]);
  });

  it('accepts an exact fetch of an id a prior response returned as an item id', () => {
    const analysis = analyzeIntentRun({
      arm: 'intent',
      task: ROUTED,
      transcript: transcript([
        {
          name: INTENT_TOOL,
          input: { intentIds: ['BR-2', 'CAP-1'] },
          result: contextResponse(['BR-2', 'CAP-1', 'CAND-BULK-DISCOUNT'], []),
        },
        { name: INTENT_TOOL, input: { intentIds: ['CAND-BULK-DISCOUNT'] } },
      ]),
    });
    expect(analysis.verdict).toBe(IntentAc10Verdict.Pass);
    expect(analysis.derivedIds).toEqual(['CAND-BULK-DISCOUNT']);
  });

  it('still fails an exact fetch of an id no response ever returned', () => {
    const analysis = analyzeIntentRun({
      arm: 'intent',
      task: ROUTED,
      transcript: transcript([
        {
          name: INTENT_TOOL,
          input: { intentIds: ['BR-2', 'CAP-1'] },
          result: contextResponse(['BR-2', 'CAP-1'], [['LIM-1', 'CAP-1']]),
        },
        { name: INTENT_TOOL, input: { intentIds: ['UC-9'] } },
      ]),
    });
    expect(analysis.verdict).toBe(IntentAc10Verdict.Violation);
    expect(analysis.unroutedIds).toEqual(['UC-9']);
    expect(analysis.derivedIds).toEqual([]);
  });

  it('does not derive intent ids from an unrelated tool result', () => {
    const analysis = analyzeIntentRun({
      arm: 'intent',
      task: ROUTED,
      transcript: transcript([
        {
          name: 'Read',
          input: { file_path: '/tmp/unrelated.json' },
          result: contextResponse(['LIM-1'], []),
        },
        { name: INTENT_TOOL, input: { intentIds: ['BR-2', 'CAP-1'] }, result: contextResponse(['BR-2'], []) },
        { name: INTENT_TOOL, input: { intentIds: ['LIM-1'] } },
      ]),
    });
    expect(analysis.derivedIds).toEqual([]);
    expect(analysis.unroutedIds).toEqual(['LIM-1']);
    expect(analysis.verdict).toBe(IntentAc10Verdict.Violation);
  });

  it('judges derivation against STRICTLY earlier responses only', () => {
    const analysis = analyzeIntentRun({
      arm: 'intent',
      task: ROUTED,
      transcript: transcript([
        {
          name: INTENT_TOOL,
          // LIM-1 rides the very call whose own response first mentions it: at
          // request time the agent had not seen it anywhere.
          input: { intentIds: ['BR-2', 'CAP-1', 'LIM-1'] },
          result: contextResponse(['BR-2', 'CAP-1', 'LIM-1'], [['LIM-1', 'CAP-1']]),
        },
      ]),
    });
    expect(analysis.verdict).toBe(IntentAc10Verdict.Violation);
    expect(analysis.unroutedIds).toEqual(['LIM-1']);
  });

  it('leaves the open-task bound untouched: derivation never buys a second broad lookup', () => {
    const analysis = analyzeIntentRun({
      arm: 'intent',
      task: OPEN,
      transcript: transcript([
        { name: INTENT_TOOL, input: { query: 'rounding' }, result: contextResponse(['BR-2'], [['BR-2', 'CAP-1']]) },
        { name: INTENT_TOOL, input: { query: 'fulfilment' } },
      ]),
    });
    expect(analysis.verdict).toBe(IntentAc10Verdict.Violation);
    expect(analysis.broadLookups).toBe(2);
  });

  it('ignores a response it cannot parse instead of crashing the analysis', () => {
    const analysis = analyzeIntentRun({
      arm: 'intent',
      task: ROUTED,
      transcript: transcript([
        { name: INTENT_TOOL, input: { intentIds: ['BR-2', 'CAP-1'] }, result: 'Error: overlay unreadable {' },
        { name: INTENT_TOOL, input: { intentIds: ['LIM-1'] } },
      ]),
    });
    expect(analysis.verdict).toBe(IntentAc10Verdict.Violation);
    expect(analysis.unroutedIds).toEqual(['LIM-1']);
  });
});

/**
 * Hard/soft split of the AC-10 findings (maintainer decision 2026-08-28). The
 * per-session verdict is unchanged everywhere below; what is asserted is the
 * WEIGHT each finding carries into the run-level gate.
 */
describe('analyzeIntentRun — hard/soft classification of findings', () => {
  it('classifies a direct overlay file read as hard', () => {
    const analysis = analyzeIntentRun({
      arm: 'intent',
      task: ROUTED,
      transcript: transcript([
        { name: INTENT_TOOL, input: { intentIds: ['BR-2', 'CAP-1'] } },
        { name: 'Read', input: { file_path: '/repo/fixture-repo/.coredoc/intent.json' } },
      ]),
    });
    expect(analysis.verdict).toBe(IntentAc10Verdict.Violation);
    expect(analysis.hardViolations.join(' ')).toMatch(/overlay contamination/i);
    expect(analysis.softViolations).toEqual([]);
  });

  it('classifies a selector-less call as hard even where the session verdict is pass', () => {
    const violating = analyzeIntentRun({
      arm: 'intent',
      task: ROUTED,
      transcript: transcript([
        { name: INTENT_TOOL, input: { intentIds: ['BR-2', 'CAP-1'] } },
        { name: INTENT_TOOL, input: {} },
      ]),
    });
    expect(violating.hardViolations.join(' ')).toMatch(/selector-less/i);

    // One selector-less lookup sits inside the open-stage budget, so the
    // per-session verdict stays `pass` — the finding is still hard.
    const passing = analyzeIntentRun({
      arm: 'intent',
      task: OPEN,
      transcript: transcript([{ name: INTENT_TOOL, input: {} }]),
    });
    expect(passing.verdict).toBe(IntentAc10Verdict.Pass);
    expect(passing.hardViolations.join(' ')).toMatch(/selector-less/i);
  });

  it('classifies an id neither routed nor returned as hard', () => {
    const analysis = analyzeIntentRun({
      arm: 'intent',
      task: ROUTED,
      transcript: transcript([{ name: INTENT_TOOL, input: { intentIds: ['BR-2', 'CAP-1', 'LIM-1'] } }]),
    });
    expect(analysis.hardViolations.join(' ')).toMatch(/nobody routed/i);
    expect(analysis.softViolations).toEqual([]);
  });

  it('classifies ignored routed ids as hard', () => {
    const analysis = analyzeIntentRun({
      arm: 'intent',
      task: ROUTED,
      transcript: transcript([{ name: INTENT_TOOL, input: { intentIds: ['BR-2'] } }]),
    });
    expect(analysis.hardViolations.join(' ')).toMatch(/routed ids never fetched/i);
    expect(analysis.softViolations).toEqual([]);
  });

  it('classifies a broad-lookup budget overrun as soft — query then query', () => {
    const analysis = analyzeIntentRun({
      arm: 'intent',
      task: OPEN,
      transcript: transcript([
        { name: INTENT_TOOL, input: { query: 'rounding' } },
        { name: INTENT_TOOL, input: { query: 'fees' } },
      ]),
    });
    expect(analysis.verdict).toBe(IntentAc10Verdict.Violation);
    expect(analysis.softViolations.join(' ')).toMatch(/2 broad lookups in one stage/);
    expect(analysis.hardViolations).toEqual([]);
  });

  it('classifies a broad-lookup budget overrun as soft — nodeIds then query', () => {
    const analysis = analyzeIntentRun({
      arm: 'intent',
      task: OPEN,
      transcript: transcript([
        { name: INTENT_TOOL, input: { nodeIds: ['src/pricing/discount.ts'] } },
        { name: INTENT_TOOL, input: { query: 'bulk discount' } },
      ]),
    });
    expect(analysis.softViolations.join(' ')).toMatch(/2 broad lookups in one stage/);
    expect(analysis.hardViolations).toEqual([]);
  });

  it('classifies a broad lookup on a routed task as soft — its budget is zero, not its kind', () => {
    const analysis = analyzeIntentRun({
      arm: 'intent',
      task: ROUTED,
      transcript: transcript([
        { name: INTENT_TOOL, input: { intentIds: ['BR-2', 'CAP-1'] } },
        { name: INTENT_TOOL, input: { query: 'rounding' } },
      ]),
    });
    expect(analysis.softViolations.join(' ')).toMatch(/broad lookup\(s\) on a task that routed exact ids/);
    expect(analysis.hardViolations).toEqual([]);
  });

  it('reports refused calls and D9-derived ids as neither hard nor soft', () => {
    const analysis = analyzeIntentRun({
      arm: 'intent',
      task: ROUTED,
      transcript: transcript([
        {
          name: INTENT_TOOL,
          input: { intentIds: ['BR-2', 'CAP-1'] },
          result: JSON.stringify({ items: [{ id: 'BR-2' }], relations: [{ from: 'BR-2', to: 'LIM-1' }] }),
        },
        { name: INTENT_TOOL, input: { intentIds: ['LIM-1'] } },
      ]),
    });
    expect(analysis.verdict).toBe(IntentAc10Verdict.Pass);
    expect(analysis.reasons.join(' ')).toMatch(/derived from earlier responses/);
    expect(analysis.hardViolations).toEqual([]);
    expect(analysis.softViolations).toEqual([]);
  });

  it('classifies contaminated controls and no-adoption as hard', () => {
    const leaked = analyzeIntentRun({
      arm: 'baseline',
      task: OPEN,
      transcript: transcript([{ name: INTENT_TOOL, input: { query: 'warehouse stock' } }]),
    });
    expect(leaked.verdict).toBe(IntentAc10Verdict.ContaminatedControl);
    expect(leaked.hardViolations.join(' ')).toMatch(/baseline leak/i);

    const unused = analyzeIntentRun({
      arm: 'intent',
      task: ROUTED,
      transcript: transcript([{ name: 'Read', input: { file_path: '/repo/src/orders/order-service.ts' } }]),
    });
    expect(unused.verdict).toBe(IntentAc10Verdict.NoAdoption);
    expect(unused.hardViolations.join(' ')).toMatch(/never used it/i);
  });

  it('keeps hard and soft a partition of reasons, never a rewrite of them', () => {
    const analysis = analyzeIntentRun({
      arm: 'intent',
      task: OPEN,
      transcript: transcript([
        { name: INTENT_TOOL, input: { query: 'rounding' } },
        { name: INTENT_TOOL, input: {} },
        { name: 'Bash', input: { command: 'cat .coredoc/intent.json' } },
      ]),
    });
    for (const finding of [...analysis.hardViolations, ...analysis.softViolations]) {
      expect(analysis.reasons).toContain(finding);
    }
    expect(analysis.hardViolations.length).toBe(2);
    expect(analysis.softViolations.length).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * Codex provider: the transcript is the raw `codex exec --json` event
 * stream, not Claude SDK messages, and one `item.completed` carries the
 * arguments AND the result. The AC-10 verdicts must be identical facts
 * read out of a different vocabulary.
 * ------------------------------------------------------------------ */

/** Synthetic `codex exec --json` stream (see agent-codex.ts for the live shape). */
function codexTranscript(
  items: Array<{
    tool?: string;
    args?: unknown;
    command?: string;
    result?: string;
    status?: 'completed' | 'failed';
    id?: string;
  }>,
): unknown[] {
  const events: unknown[] = [{ type: 'thread.started', thread_id: 'th_1' }, { type: 'turn.started' }];
  items.forEach((item, index) => {
    const id = item.id ?? `item_${index}`;
    events.push(
      item.command !== undefined
        ? {
            type: 'item.completed',
            item: {
              id,
              type: 'command_execution',
              command: item.command,
              aggregated_output: item.result ?? 'ok',
              exit_code: item.status === 'failed' ? 1 : 0,
              status: item.status ?? 'completed',
            },
          }
        : {
            type: 'item.completed',
            item: {
              id,
              type: 'mcp_tool_call',
              server: 'coredoc-eval',
              tool: item.tool ?? 'get_intent_context',
              arguments: item.args ?? {},
              result: { content: [{ type: 'text', text: item.result ?? 'ok' }] },
              status: item.status ?? 'completed',
              ...(item.status === 'failed' ? { error: { message: 'tool call failed' } } : {}),
            },
          },
    );
  });
  events.push({
    type: 'turn.completed',
    usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 20 },
  });
  return events;
}

describe('analyzeIntentRun — codex transcripts', () => {
  it('classifies a codex exact-id fetch as exact and passes a routed task', () => {
    const analysis = analyzeIntentRun({
      arm: 'intent',
      task: ROUTED,
      transcript: codexTranscript([{ args: { intentIds: ['BR-2', 'CAP-1'] } }]),
    });
    expect(analysis.calls[0]).toMatchObject({ shape: IntentToolShape.Context, intentIds: ['BR-2', 'CAP-1'] });
    expect(analysis.broadLookups).toBe(0);
    expect(analysis.exactIdCalls).toBe(1);
    expect(analysis.verdict).toBe(IntentAc10Verdict.Pass);
  });

  it('counts a codex discovery call as one broad lookup on an open task', () => {
    const analysis = analyzeIntentRun({
      arm: 'intent',
      task: OPEN,
      transcript: codexTranscript([{ args: { query: 'stock shortfall' } }]),
    });
    expect(analysis.broadLookups).toBe(1);
    expect(analysis.verdict).toBe(IntentAc10Verdict.Pass);
  });

  it('flags a codex selector-less call as the broadest lookup there is', () => {
    const analysis = analyzeIntentRun({
      arm: 'intent',
      task: OPEN,
      transcript: codexTranscript([{ args: {} }, { args: { query: 'fees' } }]),
    });
    expect(analysis.broadByKind.selectorLess ?? analysis.broadByKind['selector-less']).toBe(1);
    expect(analysis.broadLookups).toBe(2);
    expect(analysis.verdict).toBe(IntentAc10Verdict.Violation);
    expect(analysis.reasons.join(' ')).toMatch(/selector-less/);
  });

  it('derives ids from a codex tool RESULT payload rather than calling them unrouted (D9)', () => {
    const analysis = analyzeIntentRun({
      arm: 'intent',
      task: { shape: IntentPromptShape.Routed, routedIntentIds: ['BR-2'] },
      transcript: codexTranscript([
        {
          args: { intentIds: ['BR-2'] },
          result: JSON.stringify({
            items: [{ id: 'BR-2', title: 'rounding' }],
            relations: [{ from: 'BR-2', to: 'LIM-1', type: 'constrains' }],
          }),
        },
        { args: { intentIds: ['LIM-1'] } },
      ]),
    });
    expect(analysis.fetchedIds).toEqual(['BR-2', 'LIM-1']);
    expect(analysis.derivedIds).toEqual(['LIM-1']);
    expect(analysis.unroutedIds).toEqual([]);
    expect(analysis.verdict).toBe(IntentAc10Verdict.Pass);
  });

  it('treats a failed codex mcp item as a call that delivered no intent', () => {
    const analysis = analyzeIntentRun({
      arm: 'intent',
      task: OPEN,
      transcript: codexTranscript([{ args: { query: 'fees' }, status: 'failed' }]),
    });
    expect(analysis.deniedInteractions).toBe(1);
    expect(analysis.interactions).toBe(0);
    expect(analysis.verdict).toBe(IntentAc10Verdict.NoAdoption);
  });

  it('is a clean control — not a no-adoption failure — when the codex baseline was given no server', () => {
    const analysis = analyzeIntentRun({
      arm: 'baseline',
      task: OPEN,
      transcript: codexTranscript([{ command: "/bin/zsh -lc 'rg orderTotal src'" }]),
    });
    expect(analysis.interactions).toBe(0);
    // No server means no refusable call: "denied" is a claude-allowlist notion.
    expect(analysis.deniedInteractions).toBe(0);
    expect(analysis.overlayFileReads).toBe(0);
    expect(analysis.verdict).toBe(IntentAc10Verdict.NotApplicable);
  });

  it('still catches a codex control that read the overlay file through the shell', () => {
    const analysis = analyzeIntentRun({
      arm: 'baseline',
      task: OPEN,
      transcript: codexTranscript([{ command: "/bin/zsh -lc 'cat .coredoc/intent.json'" }]),
    });
    expect(analysis.overlayFileReads).toBe(1);
    expect(analysis.verdict).toBe(IntentAc10Verdict.ContaminatedControl);
  });
});
