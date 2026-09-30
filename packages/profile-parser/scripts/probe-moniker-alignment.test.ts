import { describe, expect, it } from 'vitest';
import { normalizeMonikerDescriptor } from './probe-moniker-alignment.js';

describe('normalizeMonikerDescriptor', () => {
  // Consumer side: published .d.ts barrel, version 0.208.0.
  it('strips the file-namespace prefix and the trailing arg suffix', () => {
    expect(normalizeMonikerDescriptor('src/lib/auth-sessions/`auth-sessions.d.ts`/AuthSessions#createSession().')).toBe(
      'AuthSessions#createSession',
    );
  });

  // SDK source side: real .ts source, version 0.1.0 — must collapse
  // to the SAME key as the consumer's .d.ts form (file + version skew absorbed).
  it('collapses the source-side .ts variant to the same semantic key', () => {
    expect(normalizeMonikerDescriptor('src/lib/`acme-api-response.ts`/AcmeApiResponse#getBody().')).toBe(
      'AcmeApiResponse#getBody',
    );
  });

  // Accessor getter — AcmeApiClient#`<get>schedules`() unwraps to a plain member.
  it('unwraps a backtick-wrapped <get> accessor', () => {
    expect(normalizeMonikerDescriptor('src/lib/`api-client.d.ts`/AcmeApiClient#`<get>schedules`().')).toBe(
      'AcmeApiClient#schedules',
    );
  });

  // Term/type descriptor (no `().`) — only the trailing `.` and prefix are stripped.
  it('handles a term descriptor with a trailing dot but no call parens', () => {
    expect(normalizeMonikerDescriptor('src/lib/core/types/`company.d.ts`/Locale#ptBR.')).toBe('Locale#ptBR');
  });

  // No file-namespace prefix at all — returned unchanged apart from suffix trim.
  it('is a no-op on an already-bare descriptor', () => {
    expect(normalizeMonikerDescriptor('Plans#createCustomer().')).toBe('Plans#createCustomer');
  });
});
