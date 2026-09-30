import { describe, expect, it } from 'vitest';
import { preprocess } from './preprocess.js';

describe('C# configured conditional compilation', () => {
  it('passes region, pragma and nullable directives through unchanged', () => {
    const source = '#region Example\n#pragma warning disable CS0168\n#nullable enable\nclass Example {}\n#endregion\n';
    expect(preprocess(source, [])).toBe(source);
  });
  it('selects nested branches and preserves source offsets', () => {
    const source = 'Start()\n#if DEBUG && (!EXCLUDE || EXTRA)\n.Debug()\n#else\n.Release()\n#endif\n.End();';
    const parsed = preprocess(source, ['DEBUG']);
    expect(parsed.length).toBe(source.length);
    expect(parsed.indexOf('.Debug()')).toBe(source.indexOf('.Debug()'));
    expect(parsed).not.toContain('.Release()');
    expect(preprocess(source, [])).toContain('.Release()');
  });
  it('keeps directive-like text inside multiline comments and raw/verbatim strings', () => {
    const source = '/*\n#if NO\n*/\nvar a = """\n#if NO\n""";\nvar b = @"\n#if NO\n";';
    expect(preprocess(source, [])).toBe(source);
  });
  it('rewrites only code-position empty interpolated strings, preserving offsets', () => {
    const source = 'Log(ex, $"");\nvar s = "$\\"\\"";\n// $""\nvar r = $"{x}";';
    const parsed = preprocess(source, []);
    expect(parsed.length).toBe(source.length);
    expect(parsed).toBe(source.replace('Log(ex, $"")', 'Log(ex,  "")'));
  });
  it('refuses broken or unsupported directive expressions', () => {
    expect(() => preprocess('#if DEBUG + RELEASE\nx\n#endif', [])).toThrow();
    expect(() => preprocess('#if DEBUG\nx', [])).toThrow('Unterminated');
    expect(() => preprocess('#else\nx', [])).toThrow('Unmatched');
  });
});
