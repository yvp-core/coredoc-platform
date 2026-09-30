import { describe, expect, it } from 'vitest';
import { normalizeMonikerDescriptor } from './moniker.js';

describe('normalizeMonikerDescriptor', () => {
  it('strips the backtick file-namespace prefix and the trailing call suffix', () => {
    expect(normalizeMonikerDescriptor('src/`index.d.ts`/CalculationsClient#dailySummaries().')).toBe(
      'CalculationsClient#dailySummaries',
    );
  });

  it('absorbs the index.d.ts vs src/lib skew to the same key', () => {
    const published = normalizeMonikerDescriptor('src/`index.d.ts`/CalculationsClient#dailySummaries().');
    const source = normalizeMonikerDescriptor('src/lib/clients/`calculations.ts`/CalculationsClient#dailySummaries().');
    expect(source).toBe(published);
    expect(source).toBe('CalculationsClient#dailySummaries');
  });

  it('handles a nested src path file token before the semantic suffix', () => {
    expect(normalizeMonikerDescriptor('src/lib/core/dto/companies/`company.dto.d.ts`/CompanyDto#')).toBe('CompanyDto');
  });

  it('keeps a term-path descriptor (trailing `.`) without the dot', () => {
    expect(normalizeMonikerDescriptor('`index.d.ts`/createClient.')).toBe('createClient');
  });

  it('returns the suffix unchanged when there is no file-namespace prefix', () => {
    expect(normalizeMonikerDescriptor('CalculationsClient#dailySummaries().')).toBe(
      'CalculationsClient#dailySummaries',
    );
  });

  it('preserves a private-member sigil in the suffix', () => {
    expect(normalizeMonikerDescriptor('src/`client.d.ts`/Client#`#refresh`().')).toBe('Client#`#refresh`');
  });

  it('returns empty string for an empty descriptor', () => {
    expect(normalizeMonikerDescriptor('')).toBe('');
  });
});
