import { describe, expect, it } from 'vitest';
import { parseIntentError } from './intent-error-body.js';

describe('parseIntentError', () => {
  it('recovers the server contract body so the code and field paths survive to the renderer', () => {
    const body = JSON.stringify({
      statusCode: 400,
      timestamp: '2026-09-01T00:00:00.000Z',
      requestPath: '/api/v1/workspaces/ws-1/intent/features/refunds/seeds',
      code: 'unknown_repo_key',
      message: "repo key 'acme/nope' is not registered in this workspace",
      path: ['repoKey'],
      details: [{ code: 'unknown_repo_key', message: 'acme/api (api)', path: ['repoKey'] }],
    });

    expect(parseIntentError(body)).toEqual({
      statusCode: 400,
      timestamp: '2026-09-01T00:00:00.000Z',
      requestPath: '/api/v1/workspaces/ws-1/intent/features/refunds/seeds',
      code: 'unknown_repo_key',
      message: "repo key 'acme/nope' is not registered in this workspace",
      path: ['repoKey'],
      details: [{ code: 'unknown_repo_key', message: 'acme/api (api)', path: ['repoKey'] }],
    });
  });

  it('tolerates a contract body without the optional members', () => {
    expect(parseIntentError(JSON.stringify({ code: 'version_conflict', message: 'changed' }))).toEqual({
      statusCode: 0,
      timestamp: '',
      code: 'version_conflict',
      message: 'changed',
      path: [],
    });
  });

  it('completes a details entry that omits the field path instead of letting the renderer throw', () => {
    // The renderer joins `detail.path` while rendering; a wire entry without one
    // used to be forwarded verbatim and crashed the window mid-render.
    const parsed = parseIntentError(
      JSON.stringify({
        code: 'seed_node_type_unsupported',
        message: 'node type not covered',
        details: [{ code: 'covered_type', message: 'function' }],
      }),
    );

    expect(parsed?.details).toEqual([{ code: 'covered_type', message: 'function', path: [] }]);
  });

  it.each([
    ['details as a scalar', { details: 'nope' }],
    ['details entries that are not objects', { details: ['nope', 42, null] }],
    ['a details entry with a scalar path', { details: [{ code: 'c', message: 'm', path: 'repoKey' }] }],
    ['a details entry with non-string path segments', { details: [{ code: 'c', message: 'm', path: [1, { a: 2 }] }] }],
    ['a top-level path that is not an array', { path: 'repoKey' }],
    ['a top-level path with non-string segments', { path: [null, 7] }],
  ])('stays total over %s', (_label, extra) => {
    const parsed = parseIntentError(JSON.stringify({ code: 'unknown_repo_key', message: 'nope', ...extra }));

    expect(parsed).toBeDefined();
    expect(Array.isArray(parsed?.path)).toBe(true);
    // Every surviving entry is renderable: three fields, `path` always joinable.
    for (const detail of parsed?.details ?? []) {
      expect(typeof detail.code).toBe('string');
      expect(typeof detail.message).toBe('string');
      expect(() => detail.path.join('.')).not.toThrow();
    }
  });

  it('drops a details entry that carries neither a code nor a message', () => {
    const parsed = parseIntentError(
      JSON.stringify({ code: 'c', message: 'm', details: [{ path: ['repoKey'] }, { code: 'kept', message: '' }] }),
    );

    expect(parsed?.details).toEqual([{ code: 'kept', message: '', path: [] }]);
  });

  it.each([
    ['an empty body', ''],
    ['an HTML proxy page', '<html><body>502 Bad Gateway</body></html>'],
    ['valid JSON that is not the contract', JSON.stringify({ statusCode: 500, error: 'Internal Server Error' })],
    ['a JSON scalar', '"nope"'],
  ])('returns undefined for %s rather than inventing a shape', (_label, body) => {
    // Guessing here would put fabricated field paths in front of a reviewer; the
    // caller falls back to the transport message instead.
    expect(parseIntentError(body)).toBeUndefined();
  });
});
