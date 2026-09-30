// Longest extensions first: JS regex alternation matches the first viable
// alternative, so `\.(ts|tsx|js|jsx|json|...)` would match `package.js` when
// the input was `package.json` (eating `js` and leaving `on`). Order matters.
// Polyglot extensions. `.py` added for Django backends; `.rs` for Rust
// crates; `.go` for any Go target.
// Order: longest extensions first so JS regex alternation doesn't match a
// prefix (e.g. `\.(ts|tsx)` would match `foo.tsx` as `foo.ts` and leak `x`).
const SOURCE_EXT = /\.(yaml|json|tsx|jsx|sql|yml|ts|js|py|rs|go|md)$/i;
// Allow `[]` in path segments so Next.js dynamic routes
// (`apps/web/pages/project/[ref]/settings.tsx`) match.
// A 2026-05-15 eval saw `[ref]` paths silently dropped from the
// cited set because the char class excluded brackets — Next.js route files
// became unreachable to the verifier.
const PATH_RE = /(?<![\w/.])([A-Za-z0-9_.\-/\[\]]+\.(?:yaml|json|tsx|jsx|sql|yml|ts|js|py|rs|go|md))/g;
const IDENT_RE = /`([A-Za-z_][A-Za-z0-9_.]*)`/g;

// Drop paths that don't look like real source paths but happen to match the
// regex. Two patterns we've seen leak through:
//   1. Bare extensions like ".spec.ts" — agent wrote "tests in *.spec.ts" and
//      the wildcard part fell out of the character class, leaving ".spec.ts".
//      Filter: basename starts with "." and there's no directory component.
//   2. Single-segment paths like "ts" — already rejected by SOURCE_EXT but
//      cheap to check; e.g. "POST /v1/users" should not extract anything.
function looksLikeRealPath(p: string): boolean {
  if (p.includes('/')) return true; // has a directory component, fine
  // Single-segment: basename must not start with "." (dotfile-ish junk)
  return !p.startsWith('.');
}

export function extractFilePaths(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(PATH_RE)) {
    const p = m[1];
    if (p && !p.startsWith('/') && SOURCE_EXT.test(p) && looksLikeRealPath(p)) out.add(p);
  }
  return [...out];
}

// MCP tool naming conventions: snake_case verbs and `mcp__` prefix. These
// never name a code symbol in the repos we evaluate against, so when an agent
// quotes a tool in backticks (e.g. "I'll use `find_dependents` here…") the
// citation extractor would otherwise count it as a false-positive consumer
// and tank precision.
const MCP_TOOL_NAME_RE = /^(?:mcp__|(?:find|search|trace|explain|list|describe|analyze|get|push)_[a-z])/;

function isLikelyMcpToolName(s: string): boolean {
  return MCP_TOOL_NAME_RE.test(s);
}

export function extractIdentifiers(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(IDENT_RE)) {
    if (m[1] && !isLikelyMcpToolName(m[1])) out.add(m[1]);
  }
  return [...out];
}

export function extractTouchedFiles(text: string): string[] {
  return [...new Set(extractFilePaths(text).map((p) => p.toLowerCase()))];
}
