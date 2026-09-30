// The shipped tool-class fixture must be what the registered tools say today.
//
// The two MCP surfaces assert that every tool they register is classified (see
// packages/mcp/src/tool-classes.test.ts and
// apps/server/src/mcp/tools/tool-classes.test.ts); this one asserts that the
// copy shipped inside the plugin still matches the declaration those tests
// guard — byte for byte, so formatting drift is caught too.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const FIXTURE = join(REPO, "plugins/coredoc/resources/coredoc-tool-classes.json");

const { buildToolClasses, renderToolClasses } = await import(join(REPO, "scripts/gen-coredoc-tool-classes.mjs"));

test("the checked-in fixture is what the generator emits", async () => {
	const expected = renderToolClasses(await buildToolClasses());
	const actual = readFileSync(FIXTURE, "utf8");
	assert.equal(
		actual,
		expected,
		"plugins/coredoc/resources/coredoc-tool-classes.json is stale — run `pnpm gen:tool-classes`",
	);
});

test("the fixture shape the plugin consumes holds", async () => {
	const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));
	assert.equal(fixture.version, 1);
	assert.ok(fixture.read.length > 0 && fixture.write.length > 0);
	for (const name of fixture.read) assert.ok(!fixture.write.includes(name), `${name} is both read and write`);
	// A per-action tool must not also claim a whole-tool class, or a consumer
	// reading the flat lists first would classify its writes as reads.
	for (const [name, actions] of Object.entries(fixture.byAction)) {
		assert.ok(!fixture.read.includes(name) && !fixture.write.includes(name), `${name} is classified twice`);
		assert.ok(actions.read.length > 0 && actions.write.length > 0, `${name} has an empty action list`);
		for (const action of actions.read) assert.ok(!actions.write.includes(action), `${name}.${action} is both`);
	}
});
