import { describe, expect, it } from 'vitest';
import { httpMethodMatches, splitHttpMethodPrefix } from './http-method.js';

describe('httpMethodMatches', () => {
  it('matches an exact verb', () => {
    expect(httpMethodMatches('POST', 'POST')).toBe(true);
    expect(httpMethodMatches('post', 'POST')).toBe(true);
  });

  it('does not match a different concrete verb', () => {
    expect(httpMethodMatches('POST', 'GET')).toBe(false);
  });

  it('matches a concrete request against a stored ALL handler', () => {
    // Pages-API / file-convention routes are stored with method 'ALL'.
    expect(httpMethodMatches('POST', 'ALL')).toBe(true);
    expect(httpMethodMatches('GET', 'ALL')).toBe(true);
  });

  it('matches a requested ALL/ANY against any stored verb', () => {
    expect(httpMethodMatches('ALL', 'GET')).toBe(true);
    expect(httpMethodMatches('ANY', 'POST')).toBe(true);
    expect(httpMethodMatches('ALL', 'ALL')).toBe(true);
  });

  it('matches everything when no method was requested', () => {
    expect(httpMethodMatches(undefined, 'GET')).toBe(true);
    expect(httpMethodMatches(undefined, undefined)).toBe(true);
  });

  it('does not match a concrete request against an entrypoint with no stored method', () => {
    expect(httpMethodMatches('POST', undefined)).toBe(false);
  });
});

describe('splitHttpMethodPrefix', () => {
  it('splits a concrete verb prefix', () => {
    expect(splitHttpMethodPrefix('POST /api/foo')).toEqual({ method: 'POST', path: '/api/foo' });
  });

  it('splits the ALL / ANY wildcard prefixes', () => {
    expect(splitHttpMethodPrefix('ALL /api/ai/sql/generate-v4')).toEqual({
      method: 'ALL',
      path: '/api/ai/sql/generate-v4',
    });
    expect(splitHttpMethodPrefix('any /api/foo')).toEqual({ method: 'ANY', path: '/api/foo' });
  });

  it('leaves a bare path untouched', () => {
    expect(splitHttpMethodPrefix('/api/foo')).toEqual({ path: '/api/foo' });
  });

  it('does not treat a non-verb word as a method', () => {
    expect(splitHttpMethodPrefix('FETCH /api/foo')).toEqual({ path: 'FETCH /api/foo' });
  });
});
