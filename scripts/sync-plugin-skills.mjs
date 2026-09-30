#!/usr/bin/env node
// Sync curated skills from the repo-root source of truth into the distributable plugin.
// Single source of truth: skills/<name>/. After editing a skill, re-run this
// (pnpm sync:plugin-skills) and commit the regenerated plugins/coredoc/skills/.
// To guard against drift you can add a CI step that fails when
// `git diff --exit-code plugins/coredoc/skills` is dirty.
// Mirrors the eval harness copy pattern (evals/harness/run.ts cpSync).
import { cpSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN = "plugins/coredoc";
// Consumption skills plus intent-capture. author-profile needs the local parser
// engine and stays out. intent-capture depends on the coredoc CLI too, but it
// preflights availability and fails closed without it (intent spec, plan-review
// D3), so shipping it in this plugin is safe.
const SKILLS = ["coredoc-mcp", "coredoc-feedback", "intent-capture"];

// True mirror: clear the destination first so a skill removed from SKILLS (or
// renamed) never leaves an orphaned copy shipped in the plugin.
rmSync(join(repoRoot, PLUGIN, "skills"), { recursive: true, force: true });

for (const skill of SKILLS) {
	const src = join(repoRoot, "skills", skill);
	const dest = join(repoRoot, PLUGIN, "skills", skill);
	if (!existsSync(src)) throw new Error(`Source skill not found: ${src}`);
	cpSync(src, dest, { recursive: true });
	console.log(`synced ${skill} -> ${PLUGIN}/skills/${skill}`);
}

// Authored-in-the-mirror is the failure mode this file exists to prevent; the
// marker is regenerated on every sync so it survives the rm above.
writeFileSync(
	join(repoRoot, PLUGIN, "skills", "README.md"),
	"# Generated directory — do not edit\n\n" +
		"Everything under `plugins/coredoc/skills/` is copied from the canonical\n" +
		"`skills/<name>/` at the repo root by `scripts/sync-plugin-skills.mjs`.\n" +
		"Edit the canonical skill, run `pnpm sync:plugin-skills`, and commit both.\n" +
		"CI fails when this directory drifts from a fresh sync.\n",
);
