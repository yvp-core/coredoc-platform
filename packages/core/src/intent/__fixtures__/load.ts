import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));

/** Raw bytes of the canonical valid fixture (used for serializer byte-stability checks). */
export function readValidIntentFixtureText(): string {
  return fs.readFileSync(path.join(fixtureDir, 'intent.valid.json'), 'utf-8');
}

/** Parsed-but-unvalidated fixture value; each test decides what to mutate before validating. */
export function readValidIntentFixtureJson(): Record<string, unknown> {
  return JSON.parse(readValidIntentFixtureText()) as Record<string, unknown>;
}

/**
 * A pre-migration overlay kept in its ORIGINAL v1 shape (numeric ids, no
 * `domains`, no per-item `domain`). It exists to prove the v2 refusal (BR-22 /
 * AC-20) against the real thing, so it must never be "fixed" to validate.
 */
export function readLegacyIntentFixtureJson(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(fixtureDir, 'intent.v1-legacy.json'), 'utf-8')) as Record<
    string,
    unknown
  >;
}
