#!/usr/bin/env node
// gen-coredoc-tool-classes.mjs — render the declared read/write class of every
// Coredoc MCP tool into the fixture the workflow plugin ships.
//
// Source of truth: packages/mcp/src/tool-classes.ts (COREDOC_TOOL_CLASSES),
// which both MCP surfaces import and both enforce in their own test suites.
// It is read from SOURCE via tsx (a root devDependency) rather than from
// packages/mcp/dist: the drift check must compare the checked-in fixture with
// what the code says right now, and a stale or absent dist would make it
// compare against yesterday's registrations — or not run at all.
//
//   node scripts/gen-coredoc-tool-classes.mjs            # print to stdout
//   node scripts/gen-coredoc-tool-classes.mjs --write    # default target
//   node scripts/gen-coredoc-tool-classes.mjs --write <path>
//
// Output is two-space indented with a trailing newline (the shape the plugin
// test pins): { version, read: [...], write: [...], byAction: { ... } }.

import { writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { argv, stdout } from "node:process";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TARGET = "plugins/coredoc/resources/coredoc-tool-classes.json";
const FIXTURE_VERSION = 1;

export async function buildToolClasses() {
	// tsx's own register API — `node:module`'s register("tsx/esm") is the
	// deprecated --loader path and throws on Node >= 20.6.
	const { register } = await import("tsx/esm/api");
	const unregister = register();
	let COREDOC_TOOL_CLASSES;
	try {
		({ COREDOC_TOOL_CLASSES } = await import(join(REPO, "packages/mcp/src/tool-classes.ts")));
	} finally {
		await unregister();
	}

	const read = [];
	const write = [];
	const byAction = {};
	for (const [name, value] of Object.entries(COREDOC_TOOL_CLASSES)) {
		if (value === "read") read.push(name);
		else if (value === "write") write.push(name);
		else if (value && typeof value === "object" && value.byAction) {
			byAction[name] = { read: [...value.byAction.read], write: [...value.byAction.write] };
		} else {
			// Fail closed: an unrecognised class would otherwise drop the tool from
			// the fixture, and a tool missing from both lists is treated as an
			// unclassified write by the consumer.
			throw new Error(`tool "${name}" has an unrecognised class: ${JSON.stringify(value)}`);
		}
	}
	read.sort();
	write.sort();
	const sortedByAction = {};
	for (const name of Object.keys(byAction).sort()) sortedByAction[name] = byAction[name];

	return { version: FIXTURE_VERSION, read, write, byAction: sortedByAction };
}

export function renderToolClasses(fixture) {
	return `${JSON.stringify(fixture, null, 2)}\n`;
}

async function main() {
	const rendered = renderToolClasses(await buildToolClasses());
	const writeIndex = argv.indexOf("--write");
	if (writeIndex === -1) {
		stdout.write(rendered);
		return;
	}
	const target = argv[writeIndex + 1] ?? DEFAULT_TARGET;
	const abs = isAbsolute(target) ? target : join(REPO, target);
	writeFileSync(abs, rendered);
	console.log(`wrote ${target}`);
}

if (argv[1] && resolve(argv[1]) === fileURLToPath(import.meta.url)) await main();
