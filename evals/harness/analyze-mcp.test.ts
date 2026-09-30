import { describe, it, expect } from 'vitest';
import {
  classifyMcpResult,
  extractToolEvents,
  analyzeTranscript,
  aggregateGaps,
  renderGapSection,
} from './analyze-mcp.js';

describe('classifyMcpResult', () => {
  it('flags is_error true', () => {
    expect(classifyMcpResult('whatever', true)).toEqual({ isEmpty: true, reason: 'tool-error' });
  });
  it('flags 0 of 0 search results', () => {
    expect(classifyMcpResult('## Search results for "X" (showing 0 of 0)', false))
      .toEqual({ isEmpty: true, reason: 'zero-of-zero' });
  });
  it('flags entity-not-found', () => {
    expect(classifyMcpResult("Entity 'OutputFormat' not found in scope", false))
      .toEqual({ isEmpty: true, reason: 'not-found-in-scope' });
  });
  it('flags no-results phrasing', () => {
    expect(classifyMcpResult('No callers found for foo', false))
      .toEqual({ isEmpty: true, reason: 'no-results' });
  });
  it('does not flag a substantive response', () => {
    expect(classifyMcpResult('Found 12 callers across 5 files…', false))
      .toEqual({ isEmpty: false, reason: null });
  });

  // Regression fixtures for `not-found-in-scope`, both directions — captured
  // from evals/runs/2026-08-21T05-46-02-529Z-codex-ladybug/mcp-gaps.jsonl,
  // where analyze_change_impact was called with a file path as `target`
  // (agents pass file paths despite the tool wanting a declaration name).
  describe('not-found-in-scope on analyze_change_impact responses', () => {
    // The stored `resultPreview` in mcp-gaps.jsonl (record: coredoc-parser /
    // feature-implementation-plan / withMcp / run-0) is truncated to 200
    // chars for the report and cuts off mid-sentence before the "not found in
    // scope" wording, so classification is tested here against the FULL
    // response text from that record's transcript.json — the exact text
    // `classifyMcpResult` actually saw. Beyond the boilerplate staleness
    // header and the `## Impact Analysis` / `**Risk Level:** LOW` scaffolding
    // every response gets, there is no caller/entrypoint data, so this is a
    // genuinely empty result (the tool never resolved the file-path target to
    // a declaration). The `analyze_change_impact` file-path-target handling
    // is fixed separately (the handler now rejects a file-path `target`
    // before ever reaching this response shape) — this fixture guards the
    // classifier's OWN correctness on that legacy response shape,
    // independent of that handler fix.
    const realNotFoundFullText =
      '> Data reflects parsed stable branch, not local changes\n' +
      '> Last parsed: 2026-08-21T01:35:14.763Z\n' +
      '> Parsed at commit: 643dcc4ff04104379a4e61031c9cf9384449e99d\n\n' +
      '## Impact Analysis: `apps/server/src/modules/members/members.controller.ts`\n\n' +
      '**Risk Level:**  LOW\n\n' +
      "Target 'apps/server/src/modules/members/members.controller.ts' not found in scope\n";

    it('still flags the real not-found response as empty (no substantive content present)', () => {
      expect(classifyMcpResult(realNotFoundFullText, false)).toEqual({
        isEmpty: true,
        reason: 'not-found-in-scope',
      });
    });

    it('does not flag a response with substantive content that also mentions "not found in scope"', () => {
      // Shape a genuinely substantive analyze_change_impact response could
      // take if a not-found phrase ever ends up mixed into real results
      // (e.g. a secondary lookup within the same response) — the classifier
      // must not let an incidental phrase override real content.
      const substantiveButMentionsNotFound =
        '## Impact Analysis: `createUser`\n\n' +
        '**Risk Level:** MEDIUM\n\n' +
        "Changing `createUser` would affect:\n" +
        '- 4 direct caller(s)\n' +
        '- 2 transitive caller(s)\n' +
        '- 1 API endpoint(s)\n\n' +
        "Note: related helper 'legacyCreateUser' not found in scope.";
      expect(classifyMcpResult(substantiveButMentionsNotFound, false)).toEqual({
        isEmpty: false,
        reason: null,
      });
    });
  });
});

describe('extractToolEvents', () => {
  it('walks tool_use and tool_result blocks in order', () => {
    const transcript = [
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'u1', name: 'mcp__coredoc__search_symbols', input: { query: 'X' } },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'u1', is_error: false, content: [{ type: 'text', text: 'showing 0 of 0' }] },
          ],
        },
      },
    ];
    const ev = extractToolEvents(transcript);
    expect(ev).toHaveLength(2);
    expect(ev[0]).toMatchObject({ kind: 'use', toolName: 'mcp__coredoc__search_symbols' });
    expect(ev[1]).toMatchObject({ kind: 'result', toolUseId: 'u1', isError: false });
  });

  it('expands codex item.completed events into use/result pairs', () => {
    const transcript = [
      { type: 'thread.started', thread_id: 't1' },
      {
        type: 'item.completed',
        item: {
          id: 'item_1',
          type: 'mcp_tool_call',
          server: 'coredoc',
          tool: 'search_symbols',
          arguments: { query: 'X' },
          result: { content: [{ type: 'text', text: 'showing 0 of 0' }] },
          error: null,
          status: 'completed',
        },
      },
      {
        type: 'item.completed',
        item: {
          id: 'item_2',
          type: 'command_execution',
          command: "/bin/zsh -lc 'rg X'",
          aggregated_output: 'src/a.ts',
          exit_code: 0,
          status: 'completed',
        },
      },
    ];
    const ev = extractToolEvents(transcript);
    expect(ev).toHaveLength(4);
    expect(ev[0]).toMatchObject({ kind: 'use', toolName: 'mcp__coredoc__search_symbols' });
    expect(ev[1]).toMatchObject({ kind: 'result', text: 'showing 0 of 0', isError: false });
    expect(ev[2]).toMatchObject({ kind: 'use', toolName: 'Bash' });
  });

  it('treats a failed codex MCP item as an errored result', () => {
    const ev = extractToolEvents([
      {
        type: 'item.completed',
        item: {
          id: 'item_1',
          type: 'mcp_tool_call',
          server: 'coredoc',
          tool: 'explain',
          arguments: {},
          result: null,
          error: { message: 'MCP tool call requires approval' },
          status: 'failed',
        },
      },
    ]);
    expect(ev[1]).toMatchObject({ kind: 'result', isError: true });
  });
});

describe('analyzeTranscript (codex provider)', () => {
  it('flags empty codex MCP calls and the shell fallback that follows', () => {
    const records = analyzeTranscript({
      target: 'coredoc-parser',
      case: 'explain-function',
      arm: 'withMcp',
      runIndex: 0,
      transcript: [
        {
          type: 'item.completed',
          item: {
            id: 'item_1',
            type: 'mcp_tool_call',
            server: 'coredoc',
            tool: 'find_callers',
            arguments: { symbol: 'foo' },
            result: { content: [{ type: 'text', text: 'No callers found for foo' }] },
            error: null,
            status: 'completed',
          },
        },
        {
          type: 'item.completed',
          item: {
            id: 'item_2',
            type: 'command_execution',
            command: "/bin/zsh -lc 'rg foo'",
            aggregated_output: 'src/a.ts',
            exit_code: 0,
            status: 'completed',
          },
        },
      ],
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      toolName: 'mcp__coredoc__find_callers',
      emptyReason: 'no-results',
    });
    expect(records[0]!.followedByBase).toEqual([
      { toolName: 'Bash', input: "/bin/zsh -lc 'rg foo'" },
    ]);
  });
});

describe('analyzeTranscript', () => {
  it('records empty MCP calls and the base tools that immediately follow', () => {
    const transcript = [
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'u1', name: 'mcp__coredoc__search_symbols', input: { query: 'OutputFormat' } },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'u1', is_error: false, content: [{ type: 'text', text: 'showing 0 of 0' }] },
          ],
        },
      },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'u2', name: 'Grep', input: { pattern: 'OutputFormat' } },
          ],
        },
      },
    ];
    const recs = analyzeTranscript({ target: 't', case: 'blast-radius', arm: 'withMcp', runIndex: 0, transcript });
    expect(recs).toHaveLength(1);
    expect(recs[0]?.toolName).toBe('mcp__coredoc__search_symbols');
    expect(recs[0]?.emptyReason).toBe('zero-of-zero');
    expect(recs[0]?.followedByBase).toEqual([{ toolName: 'Grep', input: { pattern: 'OutputFormat' } }]);
  });

  it('does not flag MCP calls that returned substantive content', () => {
    const transcript = [
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'u1', name: 'mcp__coredoc__describe_repository', input: {} },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'u1', is_error: false, content: [{ type: 'text', text: 'Repository: foo. Packages: 3. Entrypoints: 12.' }] },
          ],
        },
      },
    ];
    expect(analyzeTranscript({ target: 't', case: 'explain-repo', arm: 'withMcp', runIndex: 0, transcript })).toHaveLength(0);
  });

  it('ignores base-tool failures (we only score MCP gaps)', () => {
    const transcript = [
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'u1', name: 'Grep', input: { pattern: 'X' } }] },
      },
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'u1', is_error: false, content: [{ type: 'text', text: 'No matches found' }] }] },
      },
    ];
    expect(analyzeTranscript({ target: 't', case: 'blast-radius', arm: 'withMcp', runIndex: 0, transcript })).toHaveLength(0);
  });
});

describe('aggregateGaps', () => {
  it('computes per-tool failure rates and counts fallback patterns', () => {
    const counts = new Map([
      ['mcp__coredoc__search_symbols', 3],
      ['mcp__coredoc__find_callers', 2],
    ]);
    const records = [
      {
        target: 't', case: 'blast-radius' as const, arm: 'withMcp' as const, runIndex: 0,
        toolName: 'mcp__coredoc__search_symbols', input: { query: 'X' },
        resultPreview: '', isError: false, isEmpty: true, emptyReason: 'zero-of-zero',
        followedByBase: [{ toolName: 'Grep', input: { pattern: 'X' } }],
      },
      {
        target: 't', case: 'blast-radius' as const, arm: 'withMcp' as const, runIndex: 1,
        toolName: 'mcp__coredoc__search_symbols', input: { query: 'X' },
        resultPreview: '', isError: false, isEmpty: true, emptyReason: 'zero-of-zero',
        followedByBase: [{ toolName: 'Grep', input: { pattern: 'X' } }],
      },
    ];
    const agg = aggregateGaps(counts, records);
    expect(agg.totalMcpCalls).toBe(5);
    expect(agg.emptyOrErrorCount).toBe(2);
    expect(agg.perTool.get('mcp__coredoc__search_symbols')).toEqual({ calls: 3, empty: 2 });
    expect(agg.perTool.get('mcp__coredoc__find_callers')).toEqual({ calls: 2, empty: 0 });
    expect(agg.fallbackPatterns.get('mcp__coredoc__search_symbols(query=X) → Grep')).toBe(2);
  });
});

describe('renderGapSection', () => {
  it('renders a no-data placeholder when there are no MCP calls', () => {
    const lines = renderGapSection({
      totalMcpCalls: 0, emptyOrErrorCount: 0,
      perTool: new Map(), fallbackPatterns: new Map(),
    });
    expect(lines.join('\n')).toContain('No MCP calls observed');
  });
});
