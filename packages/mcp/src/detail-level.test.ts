/**
 * Tests for detail-level field filtering.
 *
 * Two levels only: `basic` (identity + location) and `full` (everything). The
 * `summary`/`refs` tiers were removed — they collapsed onto `basic` for most node
 * kinds (no AI summary, or a `refs` projection that added no fields), costing the
 * model a decision without changing the payload.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveDetailLevel,
  getDefaultDetailLevel,
  filterCodeElementInfo,
  filterCallerInfo,
  filterEntrypointInfo,
} from './detail-level.js';
import type { CallerInfo, CodeElementInfo, EntrypointInfo } from './types.js';

const fullElement: CodeElementInfo = {
  id: 'abc123:function:src/user.ts:createUser',
  name: 'createUser',
  type: 'function',
  filePath: 'src/user.ts',
  startLine: 10,
  endLine: 42,
  summary: 'Creates a user and emits a UserCreated event.',
  repo: 'users-api',
};

describe('filterCodeElementInfo', () => {
  it('basic: drops summary and endLine, keeps identity + repo', () => {
    const result = filterCodeElementInfo(fullElement, resolveDetailLevel('basic'));
    expect(result).toEqual({
      id: fullElement.id,
      name: 'createUser',
      type: 'function',
      filePath: 'src/user.ts',
      startLine: 10,
      repo: 'users-api',
    });
    expect('summary' in result).toBe(false);
    expect('endLine' in result).toBe(false);
  });

  it('full: returns the element unchanged (summary, endLine, everything)', () => {
    const result = filterCodeElementInfo(fullElement, resolveDetailLevel('full'));
    expect(result).toBe(fullElement);
  });

  it('basic and full produce distinct projections', () => {
    const basic = filterCodeElementInfo(fullElement, resolveDetailLevel('basic'));
    const full = filterCodeElementInfo(fullElement, resolveDetailLevel('full'));
    expect(JSON.stringify(basic)).not.toBe(JSON.stringify(full));
  });

  it('omits repo in single-repo scope (field absent on input)', () => {
    const { repo: _repo, ...singleRepoEl } = fullElement;
    const result = filterCodeElementInfo(singleRepoEl as CodeElementInfo, resolveDetailLevel('basic'));
    expect('repo' in result).toBe(false);
  });

  // The basic contract is "identity + location + the tool's ONE relationship
  // datum". For find_dependents / analyze_change_impact that datum lives in
  // `summary` (the USES_TYPE relation, including the enum member a value-position
  // consumer branches on) — stripping it at basic returned a dependent list that
  // never said how anything depends.
  it('basic: keeps the relationship datum when the caller opts in', () => {
    const memberAccessRow: CodeElementInfo = {
      id: 'abc123:function:src/guard.ts:isLocked',
      name: 'isLocked',
      type: 'function',
      filePath: 'src/guard.ts',
      startLine: 4,
      summary: 'used as member-access — branches on Status.Locked (value)',
    };
    const result = filterCodeElementInfo(memberAccessRow, resolveDetailLevel('basic'), { preserveSummary: true });
    expect(result.summary).toBe('used as member-access — branches on Status.Locked (value)');
    expect(result.summary).toContain('Status.Locked');
  });

  it('basic: still drops summary for tools whose summary is AI prose', () => {
    const result = filterCodeElementInfo(fullElement, resolveDetailLevel('basic'));
    expect('summary' in result).toBe(false);
  });

  // A genuine multi-kind declaration IS both kinds; dropping `kinds` made
  // response-formatter fall back to `type` and render a class+entity as a
  // plain class.
  it('basic: keeps kinds for a genuinely dual-kind declaration', () => {
    const dualKind: CodeElementInfo = {
      id: 'abc123:class:src/models/user.ts:User',
      name: 'User',
      type: 'class',
      kinds: ['class', 'entity'],
      filePath: 'src/models/user.ts',
      startLine: 12,
    };
    const result = filterCodeElementInfo(dualKind, resolveDetailLevel('basic'));
    expect(result.kinds).toEqual(['class', 'entity']);
  });

  it('basic: omits a single-element kinds (type already says it)', () => {
    const singleKind: CodeElementInfo = { ...fullElement, kinds: ['function'] };
    const result = filterCodeElementInfo(singleKind, resolveDetailLevel('basic'));
    expect('kinds' in result).toBe(false);
  });

  // Trust flags are identity, not a detail upgrade: a caveat only visible at
  // `detailLevel: "full"` is a caveat the default response never shows.
  it('basic: keeps the inferred-relationship flag', () => {
    const inferred: CodeElementInfo = { ...fullElement, provenanceInferred: true };
    const result = filterCodeElementInfo(inferred, resolveDetailLevel('basic'));
    expect(result.provenanceInferred).toBe(true);
  });

  it('basic: omits the inferred flag for a proven row', () => {
    const result = filterCodeElementInfo(fullElement, resolveDetailLevel('basic'));
    expect('provenanceInferred' in result).toBe(false);
  });
});

describe('filterCallerInfo', () => {
  const inferredCaller: CallerInfo = {
    id: 'abc123:function:src/svc.ts:run',
    name: 'run',
    type: 'function',
    kind: 'function',
    filePath: 'src/svc.ts',
    startLine: 3,
    distance: 1,
    summary: 'Runs the job.',
    provenanceInferred: true,
  };

  it('basic: keeps the inferred-relationship flag on a caller row', () => {
    const result = filterCallerInfo(inferredCaller, resolveDetailLevel('basic'));
    expect(result.provenanceInferred).toBe(true);
    expect('summary' in result).toBe(false);
  });

  it('basic: omits the flag for a proven caller', () => {
    const { provenanceInferred: _flag, ...proven } = inferredCaller;
    const result = filterCallerInfo(proven as CallerInfo, resolveDetailLevel('basic'));
    expect('provenanceInferred' in result).toBe(false);
  });
});

describe('filterEntrypointInfo', () => {
  const mobileEntrypoint: EntrypointInfo = {
    id: 'abc123:entrypoint:app/src/main/java/a/b/MainActivity.kt:launcher',
    type: 'mobile',
    className: 'MainActivity',
    trigger: 'launcher',
    handlerId: 'abc123:method:app/src/main/java/a/b/MainActivity.kt:MainActivity.onCreate',
    handlerName: 'onCreate',
    filePath: 'app/src/main/java/a/b/MainActivity.kt',
    startLine: 12,
  };

  // `list_entrypoints` defaults to BASIC, so an address dropped here is an address the agent
  // never sees — the row renders anonymous and there is nothing to type back as a pathPattern.
  it('basic: keeps the class name a mobile entrypoint is addressed by, and its trigger', () => {
    const result = filterEntrypointInfo(mobileEntrypoint, resolveDetailLevel('basic'));
    expect(result.className).toBe('MainActivity');
    expect(result.trigger).toBe('launcher');
    expect(result.handlerName).toBe('onCreate');
  });

  it('full: returns the row unchanged', () => {
    const result = filterEntrypointInfo(mobileEntrypoint, resolveDetailLevel('full'));
    expect(result).toBe(mobileEntrypoint);
  });
});

describe('resolveDetailLevel', () => {
  it('defaults to full for an unset level', () => {
    expect(resolveDetailLevel(undefined)).toEqual(resolveDetailLevel('full'));
    expect(getDefaultDetailLevel()).toBe('full');
  });

  it('resolves the compact-by-contract tools to basic', () => {
    // Both carry a bounded-by-default contract: explain previews inline
    // structure, get_intent_context withholds the full typed product payload
    // until the caller asks for it.
    expect(getDefaultDetailLevel('explain')).toBe('basic');
    expect(getDefaultDetailLevel('get_intent_context')).toBe('basic');
  });

  it('resolves EVERY list-shaped tool to basic', () => {
    // The token-cost contract: an inventory/impact list answers "which
    // symbols", so it ships identity + location + the relationship datum and
    // leaves AI summaries behind a deliberate `detailLevel: "full"` re-call.
    const listTools = [
      'search_symbols',
      'list_entrypoints',
      'list_file_symbols',
      'find_callers',
      'find_dependents',
      'find_entity_usage',
      'analyze_change_impact',
      'trace_cross_repo_call',
    ];
    for (const tool of listTools) {
      expect(getDefaultDetailLevel(tool)).toBe('basic');
    }
  });

  it('leaves non-list tools on full', () => {
    // describe_db_schema owns its own compact whole-dump rule inside the
    // formatter; coverage/dependency reports have no per-row detail to tier.
    expect(getDefaultDetailLevel('describe_db_schema')).toBe('full');
    expect(getDefaultDetailLevel('get_extraction_coverage')).toBe('full');
    expect(getDefaultDetailLevel('list_service_dependencies')).toBe('full');
    expect(getDefaultDetailLevel('semantic_search')).toBe('full');
  });

  it('fails soft to full for a stale/removed level (summary, refs)', () => {
    // A stale client still sending the removed tiers must not crash — it gets full.
    expect(resolveDetailLevel('summary' as never)).toEqual(resolveDetailLevel('full'));
    expect(resolveDetailLevel('refs' as never)).toEqual(resolveDetailLevel('full'));
  });
});
