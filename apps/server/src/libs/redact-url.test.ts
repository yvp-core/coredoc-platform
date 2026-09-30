import { describe, it, expect } from 'vitest';
import { redactSensitiveQueryParams } from './redact-url.js';

describe('redactSensitiveQueryParams', () => {
  it('returns the URL unchanged when there is no query string', () => {
    expect(redactSensitiveQueryParams('/auth/callback')).toBe('/auth/callback');
    expect(redactSensitiveQueryParams('/api/v1/workspaces/ws_1/repos')).toBe('/api/v1/workspaces/ws_1/repos');
  });

  it('redacts the OAuth authorization code', () => {
    expect(redactSensitiveQueryParams('/auth/callback?code=secret_auth_code')).toBe('/auth/callback?code=[REDACTED]');
  });

  it('redacts code and state together while keeping the path', () => {
    expect(redactSensitiveQueryParams('/auth/callback?code=abc123&state=xyz789')).toBe(
      '/auth/callback?code=[REDACTED]&state=[REDACTED]',
    );
  });

  it('leaves non-sensitive params intact and only masks sensitive ones', () => {
    expect(redactSensitiveQueryParams('/api/v1/workspaces/ws_1/push?sync=true&code=leak&defer=1')).toBe(
      '/api/v1/workspaces/ws_1/push?sync=true&code=[REDACTED]&defer=1',
    );
  });

  it('is case-insensitive on the parameter name', () => {
    expect(redactSensitiveQueryParams('/cb?Code=abc&ACCESS_TOKEN=def')).toBe(
      '/cb?Code=[REDACTED]&ACCESS_TOKEN=[REDACTED]',
    );
  });

  it('redacts a bare sensitive key with no value', () => {
    expect(redactSensitiveQueryParams('/cb?code')).toBe('/cb?code=[REDACTED]');
  });

  it('does not redact non-sensitive params', () => {
    expect(redactSensitiveQueryParams('/metrics?days=30')).toBe('/metrics?days=30');
  });
});
