import { describe, expect, it } from 'vitest';
// Importing the barrel registers every shipped language provider.
import { allLanguages, getLanguage, providerForExport } from './index.js';

const tsProfile = { parserId: 'p', substrate: { language: 'ts', include: [] } };
const jsProfile = { parserId: 'p', substrate: { language: 'js', include: [] } };
const rubyProfile = { parserId: 'p', substrate: { language: 'ruby', include: [] } };
const swiftProfile = { parserId: 'p', substrate: { language: 'swift', include: [] } };
const pythonProfile = { parserId: 'p', substrate: { language: 'python', include: [] } };
const rustProfile = { parserId: 'p', substrate: { language: 'rust', include: [] } };
const goProfile = { parserId: 'p', substrate: { language: 'go', include: [] } };
const zigProfile = { parserId: 'p', substrate: { language: 'zig', include: [] } };
const kotlinProfile = { parserId: 'p', substrate: { language: 'kotlin', include: [] } };

describe('LanguageProvider registry', () => {
  it('registers the built-in providers under their keys (ts, js, ruby, swift, python, rust, go, zig, kotlin)', () => {
    expect(getLanguage('ts')?.language).toBe('ts');
    expect(getLanguage('js')?.language).toBe('ts'); // TS provider serves js via alias
    expect(getLanguage('ruby')?.language).toBe('ruby');
    expect(getLanguage('swift')?.language).toBe('swift');
    expect(getLanguage('python')?.language).toBe('python');
    expect(getLanguage('rust')?.language).toBe('rust');
    expect(getLanguage('go')?.language).toBe('go');
    expect(getLanguage('zig')?.language).toBe('zig');
    expect(getLanguage('kotlin')?.language).toBe('kotlin');
  });

  it('de-dupes providers registered under multiple keys', () => {
    const languages = allLanguages().map((provider) => provider.language);
    expect(languages.filter((language) => language === 'ts')).toHaveLength(1);
    expect(languages).toContain('csharp');
    expect(getLanguage('csharp')?.discovery.extensions).toEqual(['.cs']);
  });

  it('providerForExport dispatches on substrate.language (positive, not by negation)', () => {
    expect(providerForExport(tsProfile)?.provider.language).toBe('ts');
    expect(providerForExport(jsProfile)?.provider.language).toBe('ts');
    expect(providerForExport(rubyProfile)?.provider.language).toBe('ruby');
    expect(providerForExport(swiftProfile)?.provider.language).toBe('swift');
    expect(providerForExport(pythonProfile)?.provider.language).toBe('python');
    expect(providerForExport(rustProfile)?.provider.language).toBe('rust');
    expect(providerForExport(goProfile)?.provider.language).toBe('go');
    expect(providerForExport(zigProfile)?.provider.language).toBe('zig');
    expect(providerForExport(kotlinProfile)?.provider.language).toBe('kotlin');
  });

  it('rejects non-profile values and unknown languages', () => {
    expect(providerForExport(null)).toBeUndefined();
    expect(providerForExport({})).toBeUndefined();
    expect(providerForExport({ substrate: { language: 'cobol' } })).toBeUndefined();
    expect(providerForExport({ parserId: 'p', substrate: { language: 'fortran', include: [] } })).toBeUndefined();
  });

  it('a TS profile and a Ruby profile resolve to different providers', () => {
    expect(providerForExport(tsProfile)?.provider).not.toBe(providerForExport(rubyProfile)?.provider);
  });
});
