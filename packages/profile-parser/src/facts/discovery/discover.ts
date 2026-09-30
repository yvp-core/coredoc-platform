import { gitListFiles } from './git-files.js';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { DEFAULT_IGNORE_DIRS, isDefaultIgnored } from './ignore.js';

export type DetectedLanguage = 'typescript' | 'javascript';

export interface LanguagePlan {
  fileCount: number;
  files: string[]; // repo-relative, forward-slash
  scipPrereqsMet: boolean;
  degradeReason?: string;
}

export interface WorkPlan {
  repoRoot: string;
  languages: Record<DetectedLanguage, LanguagePlan>;
  /**
   * Vue single-file components. Not a `DetectedLanguage`: a `.vue` file's script block is
   * TS/JS (parsed with the same grammar), and scip-typescript does not index `.vue` at all,
   * so they carry no SCIP prerequisites of their own.
   */
  vueFiles: string[];
}

/** Every source extension consumed by the TS/JS provider, including structural-only Vue SFCs. */
export const TS_JS_SOURCE_EXTENSIONS = ['.ts', '.mts', '.cts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue'] as const;

const EXT_TO_LANG: Record<string, DetectedLanguage> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
};

function toRel(root: string, abs: string): string {
  return relative(root, abs).split(sep).join('/');
}

/** Filesystem-walk fallback for a non-git checkout: skip default-ignored dirs, return repo-relative paths. */
function walk(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const d = stack.pop()!;
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (!DEFAULT_IGNORE_DIRS.has(entry)) stack.push(full);
      } else {
        out.push(toRel(root, full));
      }
    }
  }
  return out;
}

/**
 * Language-neutral repo file enumeration: git-tracked + untracked-non-ignored (honoring
 * `.gitignore`, incl. nested), falling back to a filesystem walk for a non-git checkout,
 * with default-ignored directories (`isDefaultIgnored`) pruned — so vendored/build blobs
 * are dropped even when TRACKED. Returns repo-relative, forward-slash paths.
 *
 * This is the shared enumerator: `discover()` classifies its output into TS/JS buckets,
 * and other language substrates (e.g. Ruby) filter it by their own extensions — getting
 * the same `.gitignore`-honoring behavior instead of a bespoke walk.
 */
export function enumerateRepoFiles(repoRoot: string): string[] {
  return (gitListFiles(repoRoot) ?? walk(repoRoot)).filter((rel) => !isDefaultIgnored(rel));
}

export function discover(repoRoot: string): WorkPlan {
  const relFiles = enumerateRepoFiles(repoRoot);
  const tsFiles: string[] = [];
  const jsFiles: string[] = [];
  const vueFiles: string[] = [];
  for (const rel of relFiles) {
    const dot = rel.lastIndexOf('.');
    const ext = dot >= 0 ? rel.slice(dot) : '';
    const lang = EXT_TO_LANG[ext];
    if (lang === 'typescript') tsFiles.push(rel);
    else if (lang === 'javascript') jsFiles.push(rel);
    else if (ext === '.vue') vueFiles.push(rel);
  }

  const hasNodeModules = existsSync(join(repoRoot, 'node_modules'));

  // scip-typescript needs node_modules to resolve cross-package monikers; tsconfig is optional (--infer-tsconfig).
  const tsDegrade = !hasNodeModules
    ? 'node_modules not installed — scip-typescript cannot resolve cross-package symbols'
    : undefined;

  return {
    repoRoot,
    vueFiles,
    languages: {
      typescript: {
        fileCount: tsFiles.length,
        files: tsFiles,
        scipPrereqsMet: tsFiles.length > 0 && hasNodeModules,
        degradeReason: tsFiles.length > 0 ? tsDegrade : undefined,
      },
      javascript: {
        fileCount: jsFiles.length,
        files: jsFiles,
        scipPrereqsMet: jsFiles.length > 0 && hasNodeModules,
        degradeReason: jsFiles.length > 0 ? tsDegrade : undefined,
      },
    },
  };
}

export { EXT_TO_LANG, toRel as toRepoRelative };
