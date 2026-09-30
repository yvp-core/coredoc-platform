import { describe, it, expect } from 'vitest';
import { scrubPaths } from './sanitize.js';
import { homedir } from 'node:os';

describe('scrubPaths', () => {
  it('redacts a home-rooted path (incl. the project/file tail)', () => {
    expect(scrubPaths(`Error at ${homedir()}/projects/secret/app.ts:10`)).toBe('Error at <path>:10');
  });
  it('redacts a non-home absolute path', () => {
    expect(scrubPaths('open /Users/someoneelse/x/y.ts failed')).toBe('open <path> failed');
  });
  it('redacts a home path CONTAINING SPACES fully (no leaked tail)', () => {
    expect(scrubPaths(`at ${homedir()}/My Projects/client-x/main.ts`)).toBe('at <path>');
  });
  it('redacts a git remote (org/repo would otherwise leak)', () => {
    expect(scrubPaths("fatal: 'git@github.com:acme-corp/secret.git' not found")).toBe("fatal: '<repo>' not found");
  });
  it('leaves non-path text untouched', () => {
    expect(scrubPaths('parse failed: 888 errors')).toBe('parse failed: 888 errors');
  });
  it('is null-safe', () => {
    expect(scrubPaths('')).toBe('');
  });
});

describe('scrubPaths — review fix regressions', () => {
  it('redacts a Windows drive-letter path with its line number (Critical fix)', () => {
    expect(scrubPaths('Error at C:\\Users\\bob\\project\\app.ts:10 failed')).toBe('Error at <path>:10 failed');
  });

  it('redacts a UNC path', () => {
    expect(scrubPaths('\\\\server\\share\\secret\\x.ts')).toBe('<path>');
  });

  it('preserves message tail after a home-rooted path followed by prose', () => {
    expect(scrubPaths(`Error at ${homedir()}/proj/a.ts failed to open`)).toBe('Error at <path> failed to open');
  });

  it('does not let the home anchor bleed into a sibling directory name', () => {
    expect(scrubPaths(`${homedir()}2/other/x.ts done`)).toBe('<path> done');
  });

  it('preserves the :line:col suffix across a 2-frame V8 stack trace', () => {
    const stack =
      'Error: boom\n' + `    at foo (${homedir()}/proj/a.js:10:5)\n` + `    at bar (${homedir()}/proj/b.js:20:3)`;
    expect(scrubPaths(stack)).toBe('Error: boom\n    at foo (<path>:10:5)\n    at bar (<path>:20:3)');
  });

  it('does not swallow prose following an email-like address', () => {
    expect(scrubPaths('contact admin@example.com: for access, thanks')).toBe(
      'contact admin@example.com: for access, thanks',
    );
  });

  it('redacts a bare self-hosted SSH remote with no org namespace and no .git suffix', () => {
    expect(scrubPaths("fatal: 'git@internal-host:reponame' not found")).toBe("fatal: '<repo>' not found");
  });
});
