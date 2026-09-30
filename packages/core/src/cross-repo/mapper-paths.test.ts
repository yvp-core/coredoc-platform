import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { mapperPathsForProject, assertSafeProjectId } from './mapper-paths.js';

describe('mapperPathsForProject', () => {
  it('returns the conventional mapper artifact paths for a project', () => {
    const p = mapperPathsForProject('/parsers', 'demo');
    expect(p.mapperJson).toBe(path.join('/parsers', 'demo', 'mapper.json'));
    expect(p.mapperMeta).toBe(path.join('/parsers', 'demo', 'mapper.meta.json'));
    expect(p.backup).toBe(path.join('/parsers', 'demo', '.mapper.json.bak'));
  });

  it('accepts projectIds composed of slug-safe characters', () => {
    expect(() => mapperPathsForProject('/parsers', 'my-project_1.0')).not.toThrow();
  });

  it('rejects projectIds containing path-traversal segments', () => {
    expect(() => mapperPathsForProject('/parsers', '../etc')).toThrow(/Invalid projectId/);
    expect(() => mapperPathsForProject('/parsers', '..')).toThrow(/Invalid projectId/);
  });

  it('rejects projectIds containing path separators', () => {
    expect(() => mapperPathsForProject('/parsers', 'a/b')).toThrow(/Invalid projectId/);
    expect(() => mapperPathsForProject('/parsers', 'a\\b')).toThrow(/Invalid projectId/);
  });

  it('rejects empty projectIds and ids that start with a separator', () => {
    expect(() => mapperPathsForProject('/parsers', '')).toThrow(/Invalid projectId/);
    expect(() => mapperPathsForProject('/parsers', '.hidden')).toThrow(/Invalid projectId/);
  });
});

describe('assertSafeProjectId', () => {
  it('is the underlying guard used by mapperPathsForProject', () => {
    expect(() => assertSafeProjectId('ok')).not.toThrow();
    expect(() => assertSafeProjectId('../escape')).toThrow();
  });
});
