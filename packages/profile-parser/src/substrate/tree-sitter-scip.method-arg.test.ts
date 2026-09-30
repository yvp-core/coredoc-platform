import { describe, expect, it } from 'vitest';
import { bareStringVerb } from './tree-sitter-scip.js';

/**
 * `methodArg` primitive — reads the HTTP verb from a POSITIONAL string-literal
 * method argument, e.g. the `'POST'` in `sendRequest(data, 'POST', url)`. This is
 * what lets the bareCallee matcher recover non-GET methods for wrappers whose verb
 * is a positional arg rather than a `{ method }` option (the sample-admin
 * sendRequest gap from the cross-repo recovery forensic).
 */
describe('bareStringVerb (methodArg positional HTTP verb)', () => {
  it('reads an upper-cased verb from a single/double/backtick string literal', () => {
    expect(bareStringVerb("'POST'")).toBe('POST');
    expect(bareStringVerb('"put"')).toBe('PUT');
    expect(bareStringVerb('`delete`')).toBe('DELETE');
    expect(bareStringVerb("'get'")).toBe('GET');
    expect(bareStringVerb(' "patch" ')).toBe('PATCH');
  });

  it('returns undefined for a non-string-literal arg (variable/expression) so the caller falls back', () => {
    expect(bareStringVerb('method')).toBeUndefined();
    expect(bareStringVerb('opts.method')).toBeUndefined();
    expect(bareStringVerb('`${verb}`')).toBeUndefined();
  });

  it('returns undefined for a string that is not a known HTTP verb', () => {
    expect(bareStringVerb("'fetch'")).toBeUndefined();
    expect(bareStringVerb("'connectx'")).toBeUndefined();
  });

  it('returns undefined for an absent arg', () => {
    expect(bareStringVerb(undefined)).toBeUndefined();
    expect(bareStringVerb('')).toBeUndefined();
  });
});
