#!/usr/bin/env node
// check-plugin-test-enrolment.mjs — the anti-vacuity gate in front of the
// repository's plugin test run.
//
// A test glob that matches none of its files passes for the wrong reason and is
// not evidence. Probed on this repository's Node:
//
//   node --test 'a/nope-*.test.mjs'                  -> exit 0   (zero tests)
//   node --test a/missing.test.mjs                   -> exit 1
//   node --test a/missing.test.mjs 'a/*.test.mjs'    -> exit 0   (!)
//   node --test 'a/*.test.mjs' 'a/nope-*.test.mjs'   -> exit 0
//
// So a missing literal path only fails when it is the SOLE argument: beside a
// pattern that matched anything, the missing argument is silently ignored. That
// forecloses the obvious guard — an anchor path first in the argument list — and
// is why this gate is its own clause in the test script instead. `node <path>`
// on a missing file exits 1, which makes the gate itself unfakeable: delete it
// and the clause fails.
//
// It asserts two things about the repository's own `test` script:
//   1. every `node --test` pattern in it matches at least one file on disk;
//   2. every plugin test file on disk is matched by one of those patterns, or is
//      named in DECLARED_ORPHANS below.
//
// Unenrolled files are permitted only through that explicit list, so a file
// leaves the gate deliberately and never by drifting out of a glob. The list is
// also the seam a non-gating scenario file enters through: a scenario that must
// not gate a release still must not be silently unaccounted for.
//
// Read-only. Exit 0 when everything is enrolled, 1 otherwise.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Phase B enrolled the legacy coredoc plugin suites in the root test command;
// new plugin tests must likewise enter through an executable pattern.
const DECLARED_ORPHANS = new Map();

function fail(lines) {
  console.error("check-plugin-test-enrolment: FAIL");
  for (const l of lines) console.error(`  ${l}`);
  process.exitCode = 1;
}

// Every *.test.mjs under plugins/, relative to the repo root, POSIX-separated.
// Returns { files, unreadable } — an unreadable subtree is NOT treated as empty.
// Swallowing it would make every test file inside it vanish from the enrolment
// check with nothing reported, which is the same vacuous pass this whole script
// exists to prevent, one level up.
export function pluginTestFiles(repo = REPO) {
  const out = [];
  const unreadable = [];
  const walk = (abs) => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      unreadable.push(relative(repo, abs).split("\\").join("/"));
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const child = join(abs, e.name);
      if (e.isDirectory()) walk(child);
      else if (e.isFile() && e.name.endsWith(".test.mjs")) {
        out.push(relative(repo, child).split("\\").join("/"));
      }
    }
  };
  walk(join(repo, "plugins"));
  return { files: out.sort(), unreadable };
}

// The `node --test` patterns in the repository's own test script. Parsed from
// package.json rather than restated here, so the gate cannot drift from the
// command it is guarding — restating them is the very defect this gate exists
// to catch, one level up.
export function declaredPatterns(repo = REPO) {
  const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
  const script = pkg?.scripts?.test;
  if (typeof script !== "string" || script.trim() === "") {
    return null;
  }
  const patterns = [];
  for (const clause of script.split("&&")) {
    const trimmed = clause.trim();
    if (!/^node\s+--test(\s|$)/.test(trimmed)) continue;
    for (const token of trimmed.split(/\s+/).slice(2)) {
      if (token.startsWith("-")) continue;
      patterns.push(token.replace(/^['"]|['"]$/g, ""));
    }
  }
  return patterns;
}

// A single `*` matches within one path segment. That is the whole of the glob
// syntax the repository's test script uses, and nothing more is implemented on
// purpose: an unsupported construct then reads as a literal, matches nothing, and
// FAILS the gate — which is the safe direction. Approximating `**` as if it were
// supported would let a pattern look enrolled while matching nothing.
export function patternToRegExp(pattern) {
  let re = "^";
  for (const c of pattern) {
    if (c === "*") re += "[^/]*";
    else re += c.replace(/[.+^${}()|[\]\\?]/g, "\\$&");
  }
  return new RegExp(`${re}$`);
}

// The whole judgment, as a pure function over (patterns, files, unreadable,
// orphans) so it can be exercised directly. Returns the list of problems; empty
// means enrolled. `existsOnDisk` is how a metacharacter-free pattern is checked,
// injected so a corpus test needs no filesystem.
export function enrolmentProblems({ patterns, files, unreadable = [], orphans, existsOnDisk }) {
  const problems = [];
  if (patterns === null) return ["package.json has no `test` script to read patterns from"];
  if (patterns.length === 0) {
    return ["the `test` script runs no `node --test` clause, so no plugin test file is enrolled at all"];
  }
  for (const dir of unreadable) {
    problems.push(`could not read a directory under plugins/, so its test files were not checked: ${dir}`);
  }

  // 1. No pattern may match nothing. A zero-match pattern exits 0 in the runner,
  //    so this is the only place it can be caught.
  const matchers = patterns.map((p) => ({ pattern: p, re: patternToRegExp(p) }));
  for (const { pattern, re } of matchers) {
    // Patterns may point outside plugins/ (a literal path to this gate's own
    // sibling, say), so a pattern with no metacharacter is checked on disk.
    if (!pattern.includes("*")) {
      if (!existsOnDisk(pattern)) problems.push(`pattern matches no file on disk: ${pattern}`);
      continue;
    }
    if (!files.some((f) => re.test(f))) {
      problems.push(`pattern matches no plugin test file on disk: ${pattern}`);
    }
  }

  // 2. No plugin test file may be unaccounted for.
  for (const f of files) {
    if (matchers.some(({ re }) => re.test(f))) continue;
    if (orphans.has(f)) continue;
    problems.push(`test file is enrolled by no pattern and is not a declared orphan: ${f}`);
  }

  // 3. A declared orphan that no longer exists, or that has since been enrolled,
  //    is a stale exemption. Silent staleness here is how the list rots into a
  //    blanket permission.
  for (const [f, reason] of orphans) {
    if (!files.includes(f)) {
      problems.push(`declared orphan no longer exists, remove it from the list: ${f} (${reason})`);
    } else if (matchers.some(({ re }) => re.test(f))) {
      problems.push(`declared orphan is now enrolled, remove it from the list: ${f}`);
    }
  }
  return problems;
}

function main() {
  const patterns = declaredPatterns();
  const { files, unreadable } = pluginTestFiles();
  const problems = enrolmentProblems({
    patterns,
    files,
    unreadable,
    orphans: DECLARED_ORPHANS,
    existsOnDisk: (p) => {
      try {
        statSync(join(REPO, p));
        return true;
      } catch {
        return false;
      }
    },
  });

  if (problems.length > 0) {
    fail(problems);
    return;
  }
  const orphans = DECLARED_ORPHANS.size;
  console.log(
    `check-plugin-test-enrolment: ok — ${files.length - orphans} plugin test file(s) enrolled by ${(patterns ?? []).length} pattern(s)` +
      (orphans > 0 ? `, ${orphans} declared orphan(s)` : ""),
  );
}

// Importable so the judgment above can be exercised against a corpus. Its own
// absence is what makes the clause it occupies fail, so it must stay a script.
const invokedDirectly = argv[1] && resolve(argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
