#!/usr/bin/env node
// validate-claude-md.mjs — structural lint for CLAUDE.md / AGENTS.md and skill docs.
//
// Three checks, all reported before exit:
//   - line count: warn above --max-lines (200), hard-fail above --hard-fail-lines
//     (400). Long instruction files reduce adherence; split into `@path` imports.
//   - duplicate top-level (`# `) headings.
//   - unresolved `@path` imports declared in this file (a silent context drop —
//     Claude Code skips an import whose target is missing, with no error).
//
// Markdown-aware: fenced code blocks, HTML comments, and inline `backtick` spans
// are ignored, so example headings / @paths inside them never false-positive.
//
// Import resolution is single-level (the imports declared in THIS file). That
// catches the common bug without a recursive graph walk; add depth later only if
// a real nested-import case appears.
//
// Exit 0 when there are no errors (warnings never fail). Exit 1 on any error
// (hard line cap, duplicate heading, or unresolved import). This is a CI / manual
// lint — never a commit-blocking hook.
//
// Usage:
//   node scripts/validate-claude-md.mjs <path/to/CLAUDE.md> [--json] [--max-lines N] [--hard-fail-lines N]
//
// Pure ESM, Node >=22, node: builtins only.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

const DEFAULT_MAX_LINES = 200;
const DEFAULT_HARD_FAIL_LINES = 400;

const FENCE_RE = /^```/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const IMPORT_RE = /(?<![A-Za-z0-9_])@([~A-Za-z0-9_./-]+)/g;
const INLINE_BACKTICK_RE = /`[^`]*`/g;

// Replace `inline code` spans with equal-width blanks so illustrative @paths and
// # headings inside backticks keep their line position but never match.
function stripInlineCode(line) {
  return line.replace(INLINE_BACKTICK_RE, (m) => ' '.repeat(m.length));
}

// Yield { lineNo, text } for every real content line — skipping fenced code
// blocks and HTML block comments (Claude Code strips comments before injection),
// with inline backtick spans blanked out.
function* contentLines(body) {
  const lines = body.split('\n');
  let inFence = false;
  let inComment = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (FENCE_RE.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    let line = raw;
    if (inComment) {
      const close = line.indexOf('-->');
      if (close === -1) continue;
      line = line.slice(close + 3);
      inComment = false;
    }
    while (true) {
      const open = line.indexOf('<!--');
      if (open === -1) break;
      const close = line.indexOf('-->', open + 4);
      if (close === -1) {
        line = line.slice(0, open);
        inComment = true;
        break;
      }
      line = line.slice(0, open) + line.slice(close + 3);
    }
    yield { lineNo: i + 1, text: stripInlineCode(line) };
  }
}

// Resolve `@path` syntax to a real path, relative to the containing file:
//   @~/foo -> $HOME/foo   @/abs -> /abs   @./rel | @rel -> dir(file)/rel
function resolveImport(raw, file) {
  if (raw.startsWith('~')) {
    return resolve(homedir(), raw.replace(/^~\/?/, ''));
  }
  if (raw.startsWith('/')) return raw;
  return resolve(dirname(file), raw);
}

function lint(file, { maxLines, hardFailLines }) {
  const text = readFileSync(file, 'utf8');
  const findings = [];
  const lineCount = text.split('\n').length;

  if (lineCount > hardFailLines) {
    findings.push({
      severity: 'error',
      rule: 'line_count',
      line: lineCount,
      message: `file has ${lineCount} lines, hard cap is ${hardFailLines}. Split content into @path imports.`,
    });
  } else if (lineCount > maxLines) {
    findings.push({
      severity: 'warn',
      rule: 'line_count',
      line: lineCount,
      message: `file has ${lineCount} lines, target is at most ${maxLines}. Longer files reduce adherence; consider splitting into @path imports.`,
    });
  }

  const seenHeadings = new Map();
  for (const { lineNo, text: line } of contentLines(text)) {
    const heading = HEADING_RE.exec(line);
    if (heading && heading[1].length === 1) {
      const norm = heading[2].trim().toLowerCase();
      if (seenHeadings.has(norm)) {
        findings.push({
          severity: 'error',
          rule: 'duplicate_heading',
          line: lineNo,
          message: `duplicate top-level heading '${heading[2].trim()}' (first occurrence at line ${seenHeadings.get(norm)}).`,
        });
      } else {
        seenHeadings.set(norm, lineNo);
      }
    }

    IMPORT_RE.lastIndex = 0;
    let m;
    while ((m = IMPORT_RE.exec(line)) !== null) {
      const raw = m[1];
      const target = resolveImport(raw, file);
      if (!existsSync(target) || !statSync(target).isFile()) {
        findings.push({
          severity: 'error',
          rule: 'unresolved_import',
          line: lineNo,
          message: `@${raw} -> ${target}: file not found`,
        });
      }
    }
  }

  return { path: file, lineCount, findings };
}

function parseArgs(argv) {
  const args = { file: null, json: false, maxLines: DEFAULT_MAX_LINES, hardFailLines: DEFAULT_HARD_FAIL_LINES };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--max-lines') args.maxLines = Number(argv[++i]);
    else if (a === '--hard-fail-lines') args.hardFailLines = Number(argv[++i]);
    else if (!args.file) args.file = a;
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  if (!args.file) {
    console.error('usage: validate-claude-md.mjs <path/to/CLAUDE.md> [--json] [--max-lines N] [--hard-fail-lines N]');
    return 2;
  }
  if (!existsSync(args.file) || !statSync(args.file).isFile()) {
    console.error(`validate-claude-md: not a file: ${args.file}`);
    return 1;
  }

  const report = lint(args.file, args);
  const errors = report.findings.filter((f) => f.severity === 'error');
  const warnings = report.findings.filter((f) => f.severity === 'warn');

  if (args.json) {
    console.log(JSON.stringify({ ...report, ok: errors.length === 0 }, null, 2));
  } else if (report.findings.length === 0) {
    console.log(`${report.path}: structurally legal, ${report.lineCount} lines. (Not a quality signal.)`);
  } else {
    for (const f of report.findings) {
      console.log(`[${f.severity}] ${f.rule} (line ${f.line}): ${f.message}`);
    }
    console.log(`\n${report.path}: ${errors.length} error(s), ${warnings.length} warning(s), ${report.lineCount} lines.`);
  }

  return errors.length > 0 ? 1 : 0;
}

process.exit(main(process.argv.slice(2)));
