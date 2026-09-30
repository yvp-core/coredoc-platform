import { describe, it, expect } from 'vitest';
import { auditTranscriptConfinement } from './confinement-audit.js';

const ROOTS = ['/wt', '/pinned/sibling'];

function toolUse(id: string, name: string, input: Record<string, unknown>): unknown {
  return { type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } };
}

function toolResult(id: string, isError: boolean): unknown {
  return {
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'x' }],
    },
  };
}

function audit(messages: unknown[]) {
  return auditTranscriptConfinement({
    transcriptText: JSON.stringify(messages),
    roots: ROOTS,
  });
}

describe('auditTranscriptConfinement', () => {
  it('flags a Read outside every declared root whose result came back successful', () => {
    expect(
      audit([
        toolUse('u1', 'Read', { file_path: '/live-checkout/src/index.ts' }),
        toolResult('u1', false),
      ]),
    ).toEqual([
      { toolName: 'Read', path: '/live-checkout/src/index.ts', toolUseId: 'u1' },
    ]);
  });

  it('does not flag a denied outside-root Read: the envelope did its job', () => {
    expect(
      audit([
        toolUse('u1', 'Read', { file_path: '/live-checkout/src/index.ts' }),
        toolResult('u1', true),
      ]),
    ).toEqual([]);
  });

  it('does not flag an outside-root call that never produced a result', () => {
    expect(audit([toolUse('u1', 'Read', { file_path: '/live-checkout/src/index.ts' })])).toEqual([]);
  });

  it('flags the offending token of a successful Bash command', () => {
    expect(
      audit([
        toolUse('u1', 'Bash', { command: 'cat /live-checkout/src/index.ts | head -5' }),
        toolResult('u1', false),
      ]),
    ).toEqual([
      { toolName: 'Bash', path: '/live-checkout/src/index.ts', toolUseId: 'u1' },
    ]);
  });

  it('accepts declared roots, system prefixes, and relative paths inside the cwd', () => {
    expect(
      audit([
        toolUse('u1', 'Read', { file_path: '/wt/src/index.ts' }),
        toolResult('u1', false),
        toolUse('u2', 'Read', { file_path: '/pinned/sibling/src/api.ts' }),
        toolResult('u2', false),
        toolUse('u3', 'Grep', { path: '/wt', pattern: 'x' }),
        toolResult('u3', false),
        toolUse('u4', 'Bash', { command: '/usr/bin/env grep -r x . 2>/dev/null' }),
        toolResult('u4', false),
        toolUse('u5', 'Read', { file_path: 'src/index.ts' }),
        toolResult('u5', false),
      ]),
    ).toEqual([]);
  });

  it('returns no breaches and does not throw on a malformed transcript', () => {
    expect(
      auditTranscriptConfinement({ transcriptText: '{not json', roots: ROOTS }),
    ).toEqual([]);
    expect(
      auditTranscriptConfinement({ transcriptText: '{"messages":[]}', roots: ROOTS }),
    ).toEqual([]);
    expect(
      auditTranscriptConfinement({ transcriptText: '[null,{"message":7},{}]', roots: ROOTS }),
    ).toEqual([]);
  });

  it('audits nothing when no roots were declared', () => {
    expect(
      auditTranscriptConfinement({
        transcriptText: JSON.stringify([
          toolUse('u1', 'Read', { file_path: '/anywhere/x.ts' }),
          toolResult('u1', false),
        ]),
        roots: [],
      }),
    ).toEqual([]);
  });
});
