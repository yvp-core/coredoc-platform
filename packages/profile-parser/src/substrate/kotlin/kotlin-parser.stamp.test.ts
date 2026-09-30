/**
 * The two repo-level facts `parseKotlinRepo` owns beyond the collections: the parser-version
 * stamp downstream staleness gates read, and the warnings a broken Android resource file
 * produces (kotlin-parser.test.ts covers the collections themselves).
 */
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { KotlinProfile } from '../../types/kotlin-profile.js';
import { parseKotlinRepo, toFullParsedRepo } from './kotlin-parser.js';

const profile: KotlinProfile = {
  parserId: 'kotlin-stamp',
  substrate: { language: 'kotlin', include: ['**/*.kt'] },
};

let root: string;

function write(rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'kotlin-stamp-'));
  write('app/build.gradle.kts', 'plugins { id("com.android.application") }');
  write(
    'app/src/main/kotlin/a/Home.kt',
    ['package a', 'class HomeActivity : AppCompatActivity() {', '  fun onCreate() {}', '}'].join('\n'),
  );
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('parser version stamp', () => {
  it('stamps 1.1.0-kotlin, at or above the messaging-schema floor', async () => {
    const kotlin = await parseKotlinRepo(root, 'demo', { repoKey: 'demo' }, profile);
    const repo = toFullParsedRepo(kotlin, root, profile.parserId, new Date().toISOString());

    expect(repo.parserVersion).toBe('1.1.0-kotlin');
    // The floor `predatesMessagingSchema` applies: the semver core must not be 1.0.x.
    const [major, minor] = (repo.parserVersion?.split('-', 1)[0] ?? '').split('.').map(Number);
    expect(major > 1 || (major === 1 && minor >= 1)).toBe(true);
  });
});

describe('malformed Android resource files', () => {
  it('records a warning, emits no entrypoints from the manifest and does not throw', async () => {
    const broken = mkdtempSync(join(tmpdir(), 'kotlin-broken-'));
    try {
      mkdirSync(join(broken, 'app/src/main/kotlin/a'), { recursive: true });
      writeFileSync(join(broken, 'app/build.gradle.kts'), 'plugins { id("com.android.application") }');
      writeFileSync(
        join(broken, 'app/src/main/kotlin/a/Home.kt'),
        ['package a', 'class HomeActivity : AppCompatActivity()'].join('\n'),
      );
      writeFileSync(join(broken, 'app/src/main/AndroidManifest.xml'), '<manifest><application><activity');

      const kotlin = await parseKotlinRepo(broken, 'demo', { repoKey: 'demo' }, profile);

      expect(kotlin.errors.map((e) => e.file)).toEqual(['app/src/main/AndroidManifest.xml']);
      expect(kotlin.errors[0].severity).toBe('warning');
      expect(kotlin.errors[0].message).toContain('AndroidManifest.xml');
      // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting C0/C1 were stripped.
      expect(kotlin.errors[0].message).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
      expect(kotlin.entrypoints).toEqual([]);
      // The warning survives into the ParsedRepo the CLI and the scorecard read.
      const repo = toFullParsedRepo(kotlin, broken, profile.parserId, new Date().toISOString());
      expect(repo.errors).toHaveLength(1);
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });

  it('ANTI: a well-formed manifest records no warning', async () => {
    const kotlin = await parseKotlinRepo(root, 'demo', { repoKey: 'demo' }, profile);
    expect(kotlin.errors).toEqual([]);
  });
});

describe('unreadable Gradle settings file', () => {
  // Nothing is unreadable when the suite runs as root.
  it.skipIf(process.getuid?.() === 0)(
    'degrades to the no-settings layout, records a warning and still parses every source',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'kotlin-settings-'));
      const settings = join(dir, 'settings.gradle.kts');
      try {
        mkdirSync(join(dir, 'app/src/main/kotlin/a'), { recursive: true });
        writeFileSync(settings, 'include(":app")');
        writeFileSync(join(dir, 'app/build.gradle.kts'), 'plugins { id("com.android.application") }');
        writeFileSync(join(dir, 'app/src/main/kotlin/a/Home.kt'), ['package a', 'fun home() {}'].join('\n'));
        chmodSync(settings, 0o000);

        const kotlin = await parseKotlinRepo(dir, 'demo', { repoKey: 'demo' }, profile);

        expect(kotlin.functions.map((f) => f.name)).toEqual(['home']);
        expect(kotlin.parseStats).toMatchObject({ totalFiles: 1, parsedFiles: 1, skippedFiles: 0 });
        expect(kotlin.errors).toHaveLength(1);
        expect(kotlin.errors[0]).toMatchObject({ file: 'settings.gradle.kts', severity: 'warning' });
        expect(kotlin.errors[0].message).toContain('unreadable Gradle settings file');
      } finally {
        chmodSync(settings, 0o600);
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('ANTI: a readable settings file records no warning', async () => {
    const kotlin = await parseKotlinRepo(root, 'demo', { repoKey: 'demo' }, profile);
    expect(kotlin.errors).toEqual([]);
  });
});
