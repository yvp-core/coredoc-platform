import { homedir } from 'node:os';

/**
 * Redacts absolute file paths and git remotes from a string for the anon
 * telemetry channel, which promises "no file paths."
 *
 * This is full redaction, not `~`-relativization: keeping
 * `~/projects/secret/app.ts` still leaks the project/file structure.
 * Over-redaction is acceptable here; under-redaction is a privacy leak.
 *
 * Order matters: git remotes are matched before generic absolute paths (a
 * git remote like `git@github.com:org/repo` is not an absolute path but
 * would otherwise be partially caught by the path patterns), Windows/UNC
 * paths are matched next (distinct prefixes, never overlap with the POSIX
 * passes), and the home-rooted pass runs before the general absolute-path
 * pass so it can anchor precisely on the current user's home directory.
 */
export function scrubPaths(text: string): string {
  if (!text) {
    return text;
  }

  let result = text;

  // Shared boundary fragments. The home-rooted and general passes MUST use
  // the identical boundary logic (a prior asymmetry between them let a home
  // path swallow trailing prose); factoring it out here makes that class of
  // drift impossible to reintroduce. Windows/UNC paths get their own flavor
  // since backslash is also a valid separator there.
  //
  // - LINE_COL_SUFFIX: an optional trailing `:line` or `:line:col` (e.g. a
  //   V8 stack frame's `y.js:10:5`), captured as one group so it survives
  //   outside the `<path>` placeholder instead of being swallowed.
  // - *_BOUNDARY: where a path token ends — a closing quote/paren/newline,
  //   end of string, or a whitespace that isn't itself followed by more
  //   path-like content (so ordinary message prose after a path survives).
  const LINE_COL_SUFFIX = String.raw`(:\d+(?::\d+)?)?`;
  const UNIX_BOUNDARY = String.raw`(?=[)'"\n]|$|\s(?!\S*\/))`;
  const WINDOWS_BOUNDARY = String.raw`(?=[)'"\n]|$|\s(?!\S*[\\/]))`;

  // 1. Git remotes: `user@host:org/repo(.git)?` (SSH form) and
  //    `https?://host/org/repo` (HTTPS form). Must run first, since a
  //    scp-style remote (`git@github.com:acme-corp/secret.git`) is not an
  //    absolute path but shares `:`-separated structure with one.
  //
  //    The post-colon part is a contiguous non-space token (`[\w./-]+` —
  //    word chars, dot, slash, hyphen, no space). This covers bare
  //    self-hosted remotes with no org namespace and no `.git` suffix
  //    (`git@internal-host:reponame`) as well as `org/repo` and
  //    `org/repo.git` forms. Excluding space from the class is what keeps
  //    this from over-matching `word: prose` — `admin@example.com: for
  //    access` has a space right after the colon, so the class fails to
  //    match there and the prose survives untouched.
  result = result.replace(/\b[\w.-]+@[\w.-]+:[\w./-]+/g, '<repo>');
  result = result.replace(/\bhttps?:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+/g, '<repo>');

  // 2. Windows drive-letter paths (`C:\Users\bob\...`, `C:/Users/bob/...`)
  //    and UNC paths (`\\server\share\...`). Desktop ships a Windows build,
  //    and these paths leak the OS username the same way a POSIX absolute
  //    path leaks the account name — this must never survive un-redacted.
  const winPathPattern = new RegExp(
    String.raw`\b[A-Za-z]:[\\/][\w.-]+(?:[\\/][^'"\n]*?)?${LINE_COL_SUFFIX}${WINDOWS_BOUNDARY}`,
    'g',
  );
  result = result.replace(winPathPattern, (_match, lineNumber) => `<path>${lineNumber ?? ''}`);

  const uncPathPattern = new RegExp(
    String.raw`\\\\[\w.-]+\\[\w.-]+(?:\\[^'"\n]*?)?${LINE_COL_SUFFIX}${WINDOWS_BOUNDARY}`,
    'g',
  );
  result = result.replace(uncPathPattern, (_match, lineNumber) => `<path>${lineNumber ?? ''}`);

  // 3. Home-rooted paths: anchor on the actual homedir() (regex-escaped, so
  //    literal dots/slashes in the path don't act as regex metacharacters),
  //    then consume everything up to the shared UNIX boundary. A naive
  //    `\S+` would stop at the first space and leak the rest of a path like
  //    `/Users/me/My Projects/client-x/main.ts`, so the boundary is defined
  //    negatively (same logic as the general pass below, so the two can't
  //    drift out of sync again). A segment-boundary lookahead right after
  //    the escaped home directory (`/` or end-of-string) stops the anchor
  //    from matching a sibling directory that merely shares the prefix
  //    (e.g. home `/Users/alex` must not match inside `/Users/alex2/...`) —
  //    that sibling path is still fully redacted by the general pass below,
  //    so this never leaks, it only avoids mis-attributing it as "home".
  const escapedHome = homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const homePathPattern = new RegExp(`${escapedHome}(?=\\/|$)[^'"\\n]*?${LINE_COL_SUFFIX}${UNIX_BOUNDARY}`, 'g');
  result = result.replace(homePathPattern, (_match, lineNumber) => `<path>${lineNumber ?? ''}`);

  // 4. General absolute paths (non-home): a leading `/` followed by
  //    path-like segments, consuming spaces the same way as above so a
  //    space-containing non-home path doesn't leak its tail either.
  const absPathPattern = new RegExp(String.raw`\/[\w.-]+(?:\/[^'"\n]*?)?${LINE_COL_SUFFIX}${UNIX_BOUNDARY}`, 'g');
  result = result.replace(absPathPattern, (_match, lineNumber) => `<path>${lineNumber ?? ''}`);

  return result;
}
