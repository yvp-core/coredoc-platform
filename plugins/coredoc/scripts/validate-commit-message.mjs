#!/usr/bin/env node
// validate-commit-message.mjs — Conventional Commits subject validator (coredoc plugin).
//
// Single source of truth for the Conventional Commits regex, the 50/72-char
// subject budget, the banned-vague-pattern catalog (BANNED_PATTERNS), and the
// mandatory Jira ticket reference. A valid subject must:
//   1. match the Conventional Commits shape  (feat|fix|chore|...): lowercase desc
//   2. stay within the 72-char ceiling       (warns above the 50-char target)
//   3. avoid every banned vague pattern       (`fix: bug`, `chore: update`, `wip`, ...)
//   4. reference a Jira ticket in the subject  as ABC-<number>, e.g. `(ABC-123)`
//
// Exit 0 if all four hold; 1 if any fails; 2 on usage error.
//
// Usage:
//   node validate-commit-message.mjs "feat(reports): add csv exporter (ABC-123)"
//   node validate-commit-message.mjs --file .git/COMMIT_EDITMSG   # commit-msg hook
//
// Pure ESM, Node >=22, node: builtins only.

import { readFileSync } from 'node:fs';

const PATTERN =
  /^(feat|feature|fix|bugfix|hotfix|chore|docs|refactor|style|test|perf|build|ci|revert)(\([a-z0-9][a-z0-9._\-/]*\))?!?: [^A-Z].{0,71}$/;

// Mandatory Jira reference: an uppercase project key with a numeric id, e.g. ABC-123.
// ABC is a placeholder — set this to your project's Jira key.
const JIRA_RE = /\bABC-\d+\b/;

const SUBJECT_TARGET = 50;
const SUBJECT_CEILING = 72;

const BANNED_PATTERNS = [
  /^[^:]+:\s*fix\s*bug\s*\.?\s*$/i,
  /^[^:]+:\s*bug(fix)?\s*\.?\s*$/i,
  /^[^:]+:\s*update\s*\.?\s*$/i,
  /^[^:]+:\s*updates?\s+(stuff|things|code|files?)\.?\s*$/i,
  /^[^:]+:\s*wip\b.*$/i,
  /^[^:]+:\s*temp\b.*$/i,
  /^[^:]+:\s*tmp\b.*$/i,
  /^[^:]+:\s*stuff\s*\.?\s*$/i,
  /^[^:]+:\s*misc(\s+changes?|ellaneous)?\s*\.?\s*$/i,
  /^[^:]+:\s*changes?\s*\.?\s*$/i,
  /^[^:]+:\s*minor\s+(changes?|fix(es)?|updates?)\s*\.?\s*$/i,
  /^[^:]+:\s*(small|quick)\s+fix\s*\.?\s*$/i,
  /^[^:]+:\s*tweak\s*\.?\s*$/i,
  /^[^:]+:\s*cleanup\s*\.?\s*$/i,
  /^[^:]+:\s*refactor\s*\.?\s*$/i,
  /^[^:]+:\s*nits?(picks)?\s*\.?\s*$/i,
  /^[^:]+:\s*(address|fix)\s+(review|feedback|pr\s+feedback|comments)\s*\.?\s*$/i,
];

function reason(candidate) {
  if (!candidate) return 'empty candidate';
  if (candidate.includes('\n') || candidate.includes('\r')) return 'subject must be a single line (no newlines)';
  for (const ch of candidate) {
    if (ch.charCodeAt(0) < 0x20) return 'subject must not contain ASCII control characters';
  }
  if (candidate !== candidate.trim()) return 'subject must not have leading or trailing whitespace';
  if (candidate.endsWith('.')) return 'subject must not end with a period';
  if (candidate.length > SUBJECT_CEILING) return `subject is ${candidate.length} chars; ceiling is ${SUBJECT_CEILING}`;
  if (!PATTERN.test(candidate)) return `does not match conventional-commit pattern ${PATTERN}`;
  for (const banned of BANNED_PATTERNS) {
    if (banned.test(candidate)) return `matches banned vague pattern ${banned}`;
  }
  if (!JIRA_RE.test(candidate)) {
    return 'subject must reference a Jira ticket as ABC-<number> (e.g. "feat(x): do thing (ABC-123)")';
  }
  return null;
}

// In a commit-msg file the subject is the first non-blank, non-comment line.
function subjectFromFile(path) {
  const text = readFileSync(path, 'utf8');
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.startsWith('#')) continue;
    return line;
  }
  return '';
}

function main(argv) {
  let candidate;
  if (argv[0] === '--file') {
    if (!argv[1]) {
      console.error('usage: validate-commit-message.mjs --file <path/to/COMMIT_EDITMSG>');
      return 2;
    }
    candidate = subjectFromFile(argv[1]);
  } else if (argv.length === 1) {
    candidate = argv[0];
  } else {
    console.error('usage: validate-commit-message.mjs <subject>   (quote the subject)\n       validate-commit-message.mjs --file <path>');
    return 2;
  }

  const why = reason(candidate);
  if (why === null) {
    if (candidate.length > SUBJECT_TARGET) {
      console.error(`warning: subject is ${candidate.length} chars; target is ${SUBJECT_TARGET} (ceiling ${SUBJECT_CEILING})`);
    }
    return 0;
  }
  console.error(`invalid commit subject \`${candidate}\`: ${why}`);
  return 1;
}

process.exit(main(process.argv.slice(2)));
