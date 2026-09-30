/**
 * Minimal glob matcher for substrate scoping — supports the subset the profiles
 * use: `**` (any depth incl. zero), `*` (one segment), brace alternation
 * (`{ts,tsx}`), and exact paths. Repo-relative forward-slash paths only. Mirrors
 * ts-morph's include/exclude semantics: a path is in scope when it matches an
 * include AND no exclude.
 */

function globToRegExp(glob: string): RegExp {
  // Escape regex specials except the glob ones (* / and brace alternation).
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // `**` — match any chars including `/`. Consume an optional following `/`
        // so `**/x` also matches `x` at the root.
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        // single `*` — any chars except `/`.
        re += '[^/]*';
      }
    } else if (ch === '{') {
      // brace alternation `{ts,tsx}` → `(?:ts|tsx)` (one level, no nesting).
      const close = glob.indexOf('}', i);
      if (close > i) {
        const alts = glob
          .slice(i + 1, close)
          .split(',')
          .map((a) => a.replace(/[\\^$+?.()|{}[\]]/g, '\\$&'));
        re += `(?:${alts.join('|')})`;
        i = close;
      } else {
        re += '\\{';
      }
    } else if ('\\^$+?.()|}[]'.includes(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  return new RegExp(`^${re}$`);
}

export function globMatches(path: string, include: string[], exclude: string[] = []): boolean {
  const included = include.some((g) => globToRegExp(g).test(path));
  if (!included) return false;
  return !exclude.some((g) => globToRegExp(g).test(path));
}
