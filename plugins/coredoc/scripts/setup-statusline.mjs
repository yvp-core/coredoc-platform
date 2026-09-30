#!/usr/bin/env node
// Idempotently install the coredoc status line into the user's
// ~/.claude/settings.json under the top-level "statusLine" key.
//
// The status line script (coredoc-statusline.sh) ships beside this file; its
// absolute path is resolved at install time, so the setting works regardless of
// where the plugin is installed. The command is written as `bash "<abs-path>"`
// so it does not depend on the file's executable bit surviving install.
//
// Safety:
//   - Never clobbers an EXISTING, non-coredoc status line — it refuses (exit 2)
//     and prints a manual snippet instead.
//   - If a coredoc status line is already present, the run is idempotent (or just
//     refreshes a stale path).
//   - Writes are atomic (temp file + rename) so an interrupted run can never
//     corrupt or empty the user's global settings.json. Every other key is
//     preserved untouched.
//
// Pure ESM, Node >=22, node: builtins only. Never throws uncaught.

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, rename, unlink, stat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const STATUSLINE_PATH = join(SCRIPT_DIR, "coredoc-statusline.sh");
const COMMAND = `bash "${STATUSLINE_PATH}"`;
// How we recognize a coredoc-owned status line in an existing settings file.
const MARKER = "coredoc-statusline.sh";

const CLAUDE_DIR = join(homedir(), ".claude");
const SETTINGS_PATH = join(CLAUDE_DIR, "settings.json");
const MANUAL = `Add this to ${SETTINGS_PATH} manually under the top level:\n  "statusLine": { "type": "command", "command": ${JSON.stringify(COMMAND)} }`;

const statusLineValue = () => ({ type: "command", command: COMMAND });

async function main() {
  // --force replaces an existing, non-coredoc status line (its previous value is
  // printed first, for recovery). Without it, a foreign status line is left as-is.
  const force = process.argv.slice(2).includes("--force");

  // The status line script must exist beside us, or the setting would be dead.
  if (!existsSync(STATUSLINE_PATH)) {
    console.error(`coredoc setup: status line script not found at ${STATUSLINE_PATH}`);
    return 1;
  }

  let raw = null;
  try {
    raw = await readFile(SETTINGS_PATH, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return await createFresh();
    }
    console.error(`coredoc setup: cannot read ${SETTINGS_PATH}: ${err?.message ?? err}`);
    console.error(MANUAL);
    return 1;
  }

  // Strip a leading UTF-8 BOM (some Windows editors add one) so JSON.parse works.
  if (raw.charCodeAt(0) === 0xfeff) {
    raw = raw.slice(1);
  }

  // File exists but is empty / whitespace-only -> treat as fresh.
  if (raw.trim() === "") {
    return await createFresh();
  }

  let settings;
  try {
    settings = JSON.parse(raw);
  } catch (err) {
    console.error(`coredoc setup: ${SETTINGS_PATH} exists but is not valid JSON (${err?.message ?? err}).`);
    console.error("The file was left unchanged to avoid clobbering it.");
    console.error(MANUAL);
    return 2;
  }

  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
    console.error(`coredoc setup: ${SETTINGS_PATH} does not contain a JSON object at its root.`);
    console.error("The file was left unchanged to avoid clobbering it.");
    console.error(MANUAL);
    return 2;
  }

  const existing = settings.statusLine;
  if (existing !== undefined && existing !== null) {
    const isOurs =
      typeof existing === "object" &&
      typeof existing.command === "string" &&
      existing.command.includes(MARKER);

    // Already exactly ours -> idempotent no-op.
    if (isOurs && existing.type === "command" && existing.command === COMMAND) {
      console.log(`coredoc setup: status line already points at ${STATUSLINE_PATH}. Nothing to do.`);
      return 0;
    }

    // Someone else's status line -> never clobber unless explicitly forced.
    if (!isOurs && !force) {
      console.error(`coredoc setup: a different "statusLine" is already configured in ${SETTINGS_PATH}.`);
      console.error("Left unchanged so your existing status line is not clobbered.");
      console.error("Re-run with --force to replace it (the current value is printed below for recovery), or edit by hand:");
      console.error(`current statusLine: ${JSON.stringify(existing)}`);
      console.error(MANUAL);
      return 2;
    }

    // Forced replace of a foreign status line -> echo the old value so it can be restored.
    if (!isOurs && force) {
      console.log("coredoc setup: replacing the existing status line (--force).");
      console.log(`previous statusLine (save this to restore it): ${JSON.stringify(existing)}`);
    }

    // Single write path: ours-but-stale refresh, or a forced replace.
    settings.statusLine = statusLineValue();
    const writeErr = await atomicWrite(settings);
    if (writeErr) {
      console.error(`coredoc setup: failed to write ${SETTINGS_PATH}: ${writeErr}`);
      console.error(MANUAL);
      return 1;
    }
    console.log(
      isOurs
        ? `coredoc setup: refreshed the coredoc status line path in ${SETTINGS_PATH}.`
        : `coredoc setup: installed the coredoc status line in ${SETTINGS_PATH}.`,
    );
    console.log("Restart Claude Code (or start a new session) for the change to take effect.");
    return 0;
  }

  // No status line yet -> add it, preserving every other key and its order.
  settings.statusLine = statusLineValue();
  const writeErr = await atomicWrite(settings);
  if (writeErr) {
    console.error(`coredoc setup: failed to write ${SETTINGS_PATH}: ${writeErr}`);
    console.error(MANUAL);
    return 1;
  }
  console.log(`coredoc setup: added the coredoc status line to ${SETTINGS_PATH}.`);
  console.log("Restart Claude Code (or start a new session) for the change to take effect.");
  return 0;
}

async function createFresh() {
  const settings = { statusLine: statusLineValue() };
  try {
    await mkdir(CLAUDE_DIR, { recursive: true });
  } catch (err) {
    console.error(`coredoc setup: cannot create directory ${CLAUDE_DIR}: ${err?.message ?? err}`);
    console.error(MANUAL);
    return 1;
  }
  const writeErr = await atomicWrite(settings);
  if (writeErr) {
    console.error(`coredoc setup: failed to create ${SETTINGS_PATH}: ${writeErr}`);
    console.error(MANUAL);
    return 1;
  }
  console.log(`coredoc setup: created ${SETTINGS_PATH} with the coredoc status line.`);
  console.log("Restart Claude Code (or start a new session) for the change to take effect.");
  return 0;
}

// Atomically replace SETTINGS_PATH: write a sibling temp file then rename over
// the target. rename(2) is atomic within one filesystem, so a crash mid-write
// leaves EITHER the old file intact OR the new one -- never a truncated/empty
// global settings.json. Resolve symlinks first so a dotfiles-repo symlink at
// ~/.claude/settings.json keeps pointing at its (now updated) real target, and
// so the temp file lands on the same filesystem as the target (a cross-device
// rename is not atomic and would EXDEV-fail). Preserve the existing file's
// permission bits since settings.json can hold secrets.
async function atomicWrite(settings) {
  const out = `${JSON.stringify(settings, null, 2)}\n`;

  let target = SETTINGS_PATH;
  try {
    target = await realpath(SETTINGS_PATH);
  } catch {
    // Path does not exist yet (fresh create) or the link is broken -> write the
    // literal path; its parent dir already exists (createFresh mkdir'd it).
  }

  const dir = dirname(target);
  const tmp = join(dir, `.${basename(target)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);

  let mode;
  try {
    mode = (await stat(target)).mode & 0o777;
  } catch {
    // No existing file -> let the umask decide.
  }

  try {
    await writeFile(tmp, out, mode === undefined ? { encoding: "utf8" } : { encoding: "utf8", mode });
    await rename(tmp, target);
    return null;
  } catch (err) {
    try {
      await unlink(tmp);
    } catch {
      // ignore cleanup failure
    }
    return err?.message ?? String(err);
  }
}

main()
  .then((code) => {
    process.exit(code ?? 0);
  })
  .catch((err) => {
    console.error(`coredoc setup: unexpected error: ${err?.message ?? err}`);
    console.error(MANUAL);
    process.exit(1);
  });
