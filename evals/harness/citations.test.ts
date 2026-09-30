import { describe, it, expect } from 'vitest';
import { extractFilePaths, extractIdentifiers, extractTouchedFiles } from './citations.js';

describe('citations', () => {
  it('extracts file paths from prose', () => {
    const text = `
      The function lives in \`packages/core/src/parser.ts\`.
      See also packages/db/src/transformer.ts and apps/desktop/main.ts.
      Skip non-source like /etc/hosts.
    `;
    const paths = extractFilePaths(text);
    expect(paths).toContain('packages/core/src/parser.ts');
    expect(paths).toContain('packages/db/src/transformer.ts');
    expect(paths).toContain('apps/desktop/main.ts');
    expect(paths).not.toContain('/etc/hosts');
  });

  it('extracts backticked identifiers', () => {
    const ids = extractIdentifiers('Calls `parseConfig` and `Foo.bar`. Not `kebab-case`.');
    expect(ids).toContain('parseConfig');
    expect(ids).toContain('Foo.bar');
  });

  it('extractTouchedFiles dedupes and lower-cases', () => {
    const text = 'edit Packages/A.ts and packages/a.ts';
    expect(extractTouchedFiles(text)).toEqual(['packages/a.ts']);
  });

  it('drops bare-extension fragments like ".spec.ts" that come from wildcard prose', () => {
    // Agent wrote "Update *.spec.ts files" — the wildcard fell outside the
    // path char class, leaving ".spec.ts" as a fake path. Blast-radius scoring
    // then over-cited it and dropped precision.
    const paths = extractFilePaths('Touch `src/foo.ts` and update *.spec.ts patterns.');
    expect(paths).toContain('src/foo.ts');
    expect(paths).not.toContain('.spec.ts');
  });

  it('keeps single-segment filenames like package.json', () => {
    // The dotfile filter must not eat legitimate root files.
    expect(extractFilePaths('Bump `package.json` and `tsconfig.json`.')).toEqual(
      expect.arrayContaining(['package.json', 'tsconfig.json']),
    );
  });

  it('filters out MCP tool names from cited identifiers', () => {
    // Regression: with-MCP agents tend to narrate tool usage ("I'll call
    // `find_dependents` first") and the verifier was counting those backticked
    // tool names as false-positive consumer citations. The type-impact run on
    // 2026-05-12 saw precision drop from ~0.85 to 0.46 from this alone.
    const ids = extractIdentifiers(
      'Using `find_dependents` and `mcp__coredoc__search_symbols` I see `BookingService` consumes `SampleAuthedApi`.',
    );
    expect(ids).toContain('BookingService');
    expect(ids).toContain('SampleAuthedApi');
    expect(ids).not.toContain('find_dependents');
    expect(ids).not.toContain('mcp__coredoc__search_symbols');
  });

  it('does not over-filter — keeps camelCase and PascalCase symbols', () => {
    // The MCP-tool filter is snake_case + verb-prefix. Real code symbols use
    // camelCase / PascalCase / kebab via dot, so they pass through.
    const ids = extractIdentifiers(
      'Functions: `findUserById`, `searchProjects`, `Component.render`, `getCompanyUuid`.',
    );
    expect(ids).toContain('findUserById');
    expect(ids).toContain('searchProjects');
    expect(ids).toContain('Component.render');
    expect(ids).toContain('getCompanyUuid');
  });
});
