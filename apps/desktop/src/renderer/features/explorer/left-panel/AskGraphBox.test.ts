import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { CypherUiState } from '../explorer-context.js';
import { AskGraphBox, syncGeneratedDraft } from './AskGraphBox.js';

// Presentational test: the box reads everything from the explorer context, so
// useExplorer is mocked to a hand-built api value. No real IPC/LLM (repo rule).
// This renderer has no jsdom/@testing-library setup (vitest 'node' env), so the
// component is exercised with renderToStaticMarkup per state — interaction
// (Generate/Run firing the bridge) is proven at the context+api seam instead
// (explorer-context.cypher.test.ts, graph.cypher.test.ts).
const mock = vi.hoisted(() => ({ api: {} as Record<string, unknown> }));
vi.mock('../explorer-context.js', () => ({ useExplorer: () => mock.api }));

async function render(overrides: {
  cypherEnabled: boolean | undefined;
  cypher: Partial<CypherUiState>;
}): Promise<string> {
  mock.api = {
    caps: overrides.cypherEnabled === undefined ? undefined : { cypher: overrides.cypherEnabled, edgesAmong: true },
    cypher: {
      query: '',
      generationRevision: 0,
      generating: false,
      running: false,
      error: null,
      truncated: false,
      ...overrides.cypher,
    },
    generateCypher: vi.fn(),
    runCypher: vi.fn(),
  };
  return renderToStaticMarkup(createElement(AskGraphBox));
}

describe('AskGraphBox', () => {
  it('re-seeds an edited draft when the same Cypher is generated again', () => {
    const query = 'MATCH (n) RETURN n';
    const editedDraft = { generationRevision: 1, value: '' };

    expect(syncGeneratedDraft(editedDraft, { generationRevision: 1, query })).toBe(editedDraft);
    expect(syncGeneratedDraft(editedDraft, { generationRevision: 2, query })).toEqual({
      generationRevision: 2,
      value: query,
    });
  });

  it('is hidden when the backend cannot run Cypher', async () => {
    const html = await render({ cypherEnabled: false, cypher: {} });

    expect(html).toBe('');
  });

  it('is hidden while capabilities are still loading', async () => {
    const html = await render({ cypherEnabled: undefined, cypher: {} });

    expect(html).toBe('');
  });

  it('renders the question input + Generate when Cypher is supported', async () => {
    const html = await render({ cypherEnabled: true, cypher: {} });

    expect(html).toContain('Ask a question about the graph');
    expect(html).toContain('Generate query');
    // No generated query yet → no editable Cypher field / Run button.
    expect(html).not.toContain('Generated Cypher query');
    expect(html).not.toContain('Run query');
  });

  it('shows the generated query in an EDITABLE field with a Run button', async () => {
    const html = await render({ cypherEnabled: true, cypher: { query: 'MATCH (c:Class) RETURN c' } });

    expect(html).toContain('Generated Cypher query');
    // The generated query is pre-filled into the editable textarea.
    expect(html).toContain('MATCH (c:Class) RETURN c');
    expect(html).toContain('Run query');
  });

  it('hints to refine with LIMIT when the last run was truncated', async () => {
    const html = await render({ cypherEnabled: true, cypher: { query: 'MATCH (n) RETURN n', truncated: true } });

    expect(html).toContain('refine with a smaller LIMIT');
  });

  it('surfaces a generate/run error in a banner', async () => {
    const html = await render({ cypherEnabled: true, cypher: { error: 'Cypher generation failed' } });

    expect(html).toContain('Cypher generation failed');
  });
});
