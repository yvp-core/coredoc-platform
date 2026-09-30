#!/usr/bin/env node
// Idempotently add the coredoc MCP permission rule to the user's
// ~/.claude/settings.json under permissions.allow.
//
// The rule pre-approves every tool exposed by the coredoc MCP server so the
// user is not prompted on each call. The wildcard prefix is mcp__<server>__*,
// where <server> is the name the user gave the server when adding it. The
// plugin no longer ships the MCP entry itself (its URL is workspace-specific),
// so this assumes the name the README tells users to use: `claude mcp add
// --transport http coredoc …`. A user who picks a different name must adjust
// the rule — the manual-remediation message below states the shape.
//
// Pure ESM, Node >=22, node: builtins only. Never throws uncaught; every error
// path prints a clear message and exits with an appropriate code. Writes are
// atomic (temp file + rename) so an interrupted run can never corrupt or empty
// the user's global settings.json.

import { mkdir, readFile, writeFile, rename, unlink, stat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, basename } from "node:path";
import { randomBytes } from "node:crypto";

const RULE = "mcp__coredoc__*";

const CLAUDE_DIR = join(homedir(), ".claude");
const SETTINGS_PATH = join(CLAUDE_DIR, "settings.json");
const MANUAL =
  `Add this rule manually under permissions.allow: "${RULE}"\n` +
  `(if you named the MCP server something other than "coredoc", use mcp__<your-server-name>__* instead)`;

async function main() {
  let raw = null;
  try {
    raw = await readFile(SETTINGS_PATH, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      // File does not exist yet -> create it fresh.
      return await createFresh();
    }
    console.error(
      `coredoc setup: cannot read ${SETTINGS_PATH}: ${err?.message ?? err}`,
    );
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
    // Invalid JSON: do NOT touch the file. Tell the user to edit it manually.
    console.error(
      `coredoc setup: ${SETTINGS_PATH} exists but is not valid JSON (${err?.message ?? err}).`,
    );
    console.error("The file was left unchanged to avoid clobbering it.");
    console.error(MANUAL);
    return 2;
  }

  // Parsed JSON must be a plain object (not array / null / scalar).
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
    console.error(
      `coredoc setup: ${SETTINGS_PATH} does not contain a JSON object at its root.`,
    );
    console.error("The file was left unchanged to avoid clobbering it.");
    console.error(MANUAL);
    return 2;
  }

  // Ensure permissions is an object.
  if (
    settings.permissions === undefined ||
    settings.permissions === null
  ) {
    settings.permissions = {};
  } else if (
    typeof settings.permissions !== "object" ||
    Array.isArray(settings.permissions)
  ) {
    console.error(
      `coredoc setup: ${SETTINGS_PATH} has a "permissions" key that is not an object.`,
    );
    console.error("The file was left unchanged to avoid clobbering it.");
    console.error(MANUAL);
    return 2;
  }

  // Ensure permissions.allow is an array.
  if (
    settings.permissions.allow === undefined ||
    settings.permissions.allow === null
  ) {
    settings.permissions.allow = [];
  } else if (!Array.isArray(settings.permissions.allow)) {
    console.error(
      `coredoc setup: ${SETTINGS_PATH} has a "permissions.allow" key that is not an array.`,
    );
    console.error("The file was left unchanged to avoid clobbering it.");
    console.error(MANUAL);
    return 2;
  }

  // Idempotent: already present -> nothing to do.
  if (settings.permissions.allow.includes(RULE)) {
    console.log(`coredoc setup: "${RULE}" is already allowed. Nothing to do.`);
    return 0;
  }

  // Append the rule, preserving all existing entries and their order.
  settings.permissions.allow.push(RULE);

  const writeErr = await atomicWrite(settings);
  if (writeErr) {
    console.error(
      `coredoc setup: failed to write ${SETTINGS_PATH}: ${writeErr}`,
    );
    console.error(MANUAL);
    return 1;
  }

  console.log(`coredoc setup: added "${RULE}" to permissions.allow in ${SETTINGS_PATH}.`);
  console.log(
    "Restart Claude Code (or start a new session) for the change to take effect.",
  );
  return 0;
}

async function createFresh() {
  const settings = { permissions: { allow: [RULE] } };
  try {
    await mkdir(CLAUDE_DIR, { recursive: true });
  } catch (err) {
    console.error(
      `coredoc setup: cannot create directory ${CLAUDE_DIR}: ${err?.message ?? err}`,
    );
    console.error(MANUAL);
    return 1;
  }
  const writeErr = await atomicWrite(settings);
  if (writeErr) {
    console.error(
      `coredoc setup: failed to create ${SETTINGS_PATH}: ${writeErr}`,
    );
    console.error(MANUAL);
    return 1;
  }
  console.log(`coredoc setup: created ${SETTINGS_PATH} with "${RULE}" in permissions.allow.`);
  console.log(
    "Restart Claude Code (or start a new session) for the change to take effect.",
  );
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
  const tmp = join(
    dir,
    `.${basename(target)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );

  // Preserve the existing file's permission bits when one is present.
  let mode;
  try {
    mode = (await stat(target)).mode & 0o777;
  } catch {
    // No existing file -> let the umask decide.
  }

  try {
    await writeFile(
      tmp,
      out,
      mode === undefined ? { encoding: "utf8" } : { encoding: "utf8", mode },
    );
    await rename(tmp, target);
    return null;
  } catch (err) {
    // Best-effort: remove the temp file so we never litter ~/.claude.
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
    // Last-resort guard: nothing above should reach here.
    console.error(`coredoc setup: unexpected error: ${err?.message ?? err}`);
    console.error(`Add this rule manually under permissions.allow: "${RULE}"`);
    process.exit(1);
  });
