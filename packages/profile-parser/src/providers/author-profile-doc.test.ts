import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { allLanguages } from './index.js';

describe('author-profile supported-language guidance', () => {
  it('lists every registered provider in the wired-substrate table', () => {
    const skillPath = fileURLToPath(new URL('../../../../skills/author-profile/SKILL.md', import.meta.url));
    const skill = readFileSync(skillPath, 'utf8');
    const table = skill.match(/\| Language \| Profile type \| Calls \|[\s\S]*?\n\n/)?.[0].toLowerCase();
    expect(table).toBeDefined();

    for (const provider of allLanguages()) {
      expect(table).toContain(`| ${provider.language}`);
    }
    expect(skill).not.toContain('primarily **Go/Java/etc.**');
    expect(skill).not.toContain('exporting one `ExtractionProfile`');
    expect(skill).toContain('selected in Orient: an `ExtractionProfile`');
    expect(skill).toContain('or a `MultiTargetProfile`');
    expect(skill).toContain('Exactly one target per canonical language provider');
    expect(skill).toContain('`ts` and `js` both resolve to the TypeScript provider');
    expect(skill).not.toContain('Two *same-language* targets are allowed');
  });
});
