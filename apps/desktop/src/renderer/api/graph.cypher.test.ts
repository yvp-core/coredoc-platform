import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GraphScope } from '../../shared/ipc-types.js';
import { fetchCypher, fetchGenerateCypher } from './graph.js';

// Fully mocked window.electronAPI — no real IPC, no LLM. Component/api tests in
// this repo MUST mock the bridge completely: a real graphGenerateCypher would
// spend LLM tokens transitively (see feedback_storybook_no_real_ipc_in_ci).
const scope: GraphScope = { source: 'local', id: 'proj-1' };

describe('graph cypher api helpers', () => {
  const graphGenerateCypher = vi.fn();
  const graphCypher = vi.fn();

  beforeEach(() => {
    graphGenerateCypher.mockReset();
    graphCypher.mockReset();
    (globalThis as { window?: unknown }).window = { electronAPI: { graphGenerateCypher, graphCypher } };
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('fetchGenerateCypher forwards scope + text and unwraps the generated query', async () => {
    graphGenerateCypher.mockResolvedValue({ success: true, data: { cypher: 'MATCH (n) RETURN n' } });

    const result = await fetchGenerateCypher(scope, 'all classes that call the push service');

    expect(graphGenerateCypher).toHaveBeenCalledWith(scope, 'all classes that call the push service');
    expect(result).toEqual({ cypher: 'MATCH (n) RETURN n' });
  });

  it('fetchGenerateCypher throws the envelope error when generation fails', async () => {
    graphGenerateCypher.mockResolvedValue({ success: false, error: "couldn't generate a query" });

    await expect(fetchGenerateCypher(scope, 'gibberish')).rejects.toThrow("couldn't generate a query");
  });

  it('fetchCypher forwards the (edited) query + limit and unwraps the graph result', async () => {
    const data = { nodes: [{ id: 'a' }], edges: [{ id: 'e' }], truncated: true };
    graphCypher.mockResolvedValue({ success: true, data });

    // The query string here stands in for the user-EDITED draft the Run button sends.
    const result = await fetchCypher(scope, 'MATCH (c:Class) RETURN c LIMIT 10', 10);

    expect(graphCypher).toHaveBeenCalledWith(scope, 'MATCH (c:Class) RETURN c LIMIT 10', 10);
    expect(result).toBe(data);
  });

  it('fetchCypher throws the envelope error when execution fails (guard / sqlite / invalid query)', async () => {
    graphCypher.mockResolvedValue({
      success: false,
      error: 'Cypher needs a Ladybug or Neo4j graph — this project is on SQLite',
    });

    await expect(fetchCypher(scope, 'DETACH DELETE n')).rejects.toThrow('Ladybug or Neo4j');
  });
});
