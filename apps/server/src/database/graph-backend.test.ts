import { describe, expect, it } from 'vitest';
import { GraphBackend, resolveGraphBackend } from './graph-backend.js';
import { GraphSnapshotError } from '../libs/pipeline/graph-snapshot.errors.js';

describe('resolveGraphBackend', () => {
  it('maps the two stored values onto the enum', () => {
    expect(resolveGraphBackend({ graphBackend: 'turso' })).toBe(GraphBackend.Turso);
    expect(resolveGraphBackend({ graphBackend: 'file_snapshot' })).toBe(GraphBackend.FileSnapshot);
  });

  it('resolves an absent value to the file-snapshot default', () => {
    expect(resolveGraphBackend({})).toBe(GraphBackend.FileSnapshot);
    expect(resolveGraphBackend({ graphBackend: null })).toBe(GraphBackend.FileSnapshot);
  });

  it('refuses anything outside the enum instead of defaulting to a plane', () => {
    for (const raw of ['neo4j', '']) {
      expect(() => resolveGraphBackend({ graphBackend: raw })).toThrow(GraphSnapshotError);
      expect(() => resolveGraphBackend({ graphBackend: raw })).toThrow(
        expect.objectContaining({ code: 'graph_backend_conflict' }),
      );
    }
  });
});
