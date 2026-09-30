import { describe, expect, it } from 'vitest';

import { normalizeServerUrl } from './server-url-format';

describe('normalizeServerUrl', () => {
  it('accepts http and https origins', () => {
    expect(normalizeServerUrl('https://coredoc.corp.example')).toBe('https://coredoc.corp.example');
    expect(normalizeServerUrl('http://localhost:3000')).toBe('http://localhost:3000');
  });

  it('trims surrounding whitespace and trailing slashes', () => {
    expect(normalizeServerUrl('  https://coredoc.corp.example//  ')).toBe('https://coredoc.corp.example');
  });

  it('keeps a base path', () => {
    expect(normalizeServerUrl('https://corp.example/coredoc/')).toBe('https://corp.example/coredoc');
  });

  it('rejects empty input, non-URLs and bare hostnames', () => {
    expect(normalizeServerUrl('')).toBeNull();
    expect(normalizeServerUrl('   ')).toBeNull();
    expect(normalizeServerUrl('coredoc.corp.example')).toBeNull();
  });

  it('rejects non-http schemes', () => {
    expect(normalizeServerUrl('file:///etc/passwd')).toBeNull();
    expect(normalizeServerUrl('javascript:alert(1)')).toBeNull();
  });

  it('rejects embedded credentials, query and fragment', () => {
    expect(normalizeServerUrl('https://user:pw@corp.example')).toBeNull();
    expect(normalizeServerUrl('https://corp.example?token=abc')).toBeNull();
    expect(normalizeServerUrl('https://corp.example#frag')).toBeNull();
  });

  it('strips empty ? and # leftovers instead of echoing them into concatenation', () => {
    // `${serverUrl}${path}` on a stored 'https://corp.example#' would turn the
    // whole API path into a fragment.
    expect(normalizeServerUrl('https://corp.example#')).toBe('https://corp.example');
    expect(normalizeServerUrl('https://corp.example?')).toBe('https://corp.example');
    expect(normalizeServerUrl('https://corp.example/coredoc/#')).toBe('https://corp.example/coredoc');
  });

  it('returns a canonical serialization derived from the parsed URL', () => {
    expect(normalizeServerUrl('HTTPS://Coredoc.Corp.Example')).toBe('https://coredoc.corp.example');
    expect(normalizeServerUrl('https://corp.example:443/')).toBe('https://corp.example');
    expect(normalizeServerUrl('https://corp.example/a/../b')).toBe('https://corp.example/b');
  });
});
