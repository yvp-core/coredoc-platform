import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { INTENT_DIR_NAME, INTENT_FILE_NAME, intentPathsForRepo } from './paths.js';

describe('intentPathsForRepo', () => {
  it('resolves the repo-local .coredoc/intent.json layout', () => {
    const paths = intentPathsForRepo('/repos/sample');
    expect(paths.dir).toBe(path.join('/repos/sample', INTENT_DIR_NAME));
    expect(paths.intentJson).toBe(path.join('/repos/sample', INTENT_DIR_NAME, INTENT_FILE_NAME));
    expect(INTENT_DIR_NAME).toBe('.coredoc');
    expect(INTENT_FILE_NAME).toBe('intent.json');
  });

  it('normalises a trailing separator without changing the resolved file', () => {
    expect(intentPathsForRepo('/repos/sample/').intentJson).toBe(intentPathsForRepo('/repos/sample').intentJson);
  });

  it('rejects an empty or relative repo root at the boundary', () => {
    expect(() => intentPathsForRepo('')).toThrow(/repoRoot/);
    expect(() => intentPathsForRepo('relative/repo')).toThrow(/absolute/);
    expect(() => intentPathsForRepo('   ')).toThrow(/repoRoot/);
  });
});
