/**
 * Assembly-level proof for the Kotlin parser: one temp-dir Android repo, two Gradle modules, a
 * Kotlin package NAMED LIKE a module directory, and every `ParsedRepo` collection populated
 * from a different lane. The per-lane extraction rules are proven by each lane's own test; what
 * is proven here is the wiring: collections, referential integrity, `stats.kotlin` and id stability.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkReferentialIntegrity } from '../../integrity/referential-integrity.js';
import { kotlinProvider } from '../../providers/kotlin.js';
import type { KotlinProfile } from '../../types/kotlin-profile.js';

const FILES: Record<string, string> = {
  'settings.gradle.kts': `include(":app")\ninclude(":core")\n`,
  'app/build.gradle.kts': `plugins { id("com.android.application") }\n`,
  'core/build.gradle.kts': `plugins { id("java-library") }\n`,
  'app/src/main/AndroidManifest.xml': `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="app">
  <application android:label="demo">
    <activity android:name=".MainActivity" android:exported="true">
      <intent-filter>
        <action android:name="android.intent.action.MAIN" />
        <category android:name="android.intent.category.LAUNCHER" />
      </intent-filter>
    </activity>
  </application>
</manifest>
`,
  'app/src/main/res/layout/main_screen.xml': `<?xml version="1.0" encoding="utf-8"?>\n<FrameLayout />\n`,
  'app/src/main/res/navigation/nav_graph.xml': `<?xml version="1.0" encoding="utf-8"?>
<navigation xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:app="http://schemas.android.com/apk/res-auto"
    android:id="@+id/nav_graph" app:startDestination="@id/homeFragment">
  <fragment android:id="@+id/homeFragment" android:name="app.HomeFragment" />
</navigation>
`,
  // Kotlin package `app` — the SAME NAME as the `app` Gradle module directory.
  'app/src/main/kotlin/app/MainActivity.kt': `package app

import androidx.appcompat.app.AppCompatActivity
import android.os.Bundle
import core.data.ThingRepository

const val SCREEN_TAG = "main"

typealias Ids = List<String>

enum class Status { OK, FAILED }

class MainActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        setContentView(R.layout.main_screen)
        val repo = ThingRepository()
        repo.load()
    }
}
`,
  'app/src/main/kotlin/app/HomeFragment.kt': `package app

import androidx.fragment.app.Fragment

class HomeFragment : Fragment() {
    fun refresh() {
        setContentView(R.layout.main_screen)
    }
}
`,
  'app/src/main/kotlin/app/ui/HomeScreen.kt': `package app.ui

import androidx.compose.runtime.Composable

@Composable
fun HomeScreen() {
    val label = "home"
}
`,
  'core/src/main/kotlin/core/data/ThingApi.kt': `package core.data

import retrofit2.http.GET
import retrofit2.http.Path

interface ThingApi {
    @GET("things/{id}")
    fun getThing(@Path("id") id: String): ThingRow
}
`,
  'core/src/main/kotlin/core/data/ThingRow.kt': `package core.data

import androidx.room.Entity
import androidx.room.PrimaryKey

@Entity(tableName = "things")
data class ThingRow(
    @PrimaryKey val id: String,
    val label: String
)
`,
  'core/src/main/kotlin/core/data/ThingDao.kt': `package core.data

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.Query

@Dao
interface ThingDao {
    @Query("SELECT * FROM things")
    fun all(): List<ThingRow>

    @Insert
    fun put(row: ThingRow)
}
`,
  'core/src/main/kotlin/core/data/ThingRepository.kt': `package core.data

import retrofit2.Retrofit

class ThingRepository {
    fun load(): ThingRow {
        val retrofit = Retrofit.Builder().baseUrl("https://example.test/api/mobile/").build()
        val api: ThingApi = retrofit.create(ThingApi::class.java)
        return api.getThing("1")
    }
}
`,
};

const profile: KotlinProfile = {
  parserId: 'kotlin-demo',
  substrate: { language: 'kotlin', include: ['**/*.kt'] },
  entities: { orm: 'room' },
};

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'kotlin-parser-'));
  for (const [rel, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('kotlinProvider.parse assembly', () => {
  it('populates every ParsedRepo collection and passes referential integrity', async () => {
    const repo = await kotlinProvider.parse(profile, { repoRoot: root, repoName: 'demo', repoKey: 'demo' });

    expect(repo.parserVersion).toBe('1.1.1-kotlin');
    expect(repo.type).toBe('mobile');
    for (const [name, collection] of Object.entries({
      packages: repo.packages,
      files: repo.files,
      functions: repo.functions,
      classes: repo.classes,
      interfaces: repo.interfaces,
      enums: repo.enums,
      variables: repo.variables,
      typeAliases: repo.typeAliases,
      imports: repo.imports,
      calls: repo.calls,
      entrypoints: repo.entrypoints,
      entities: repo.entities,
      dbOperations: repo.dbOperations,
      externalCalls: repo.externalCalls,
      components: repo.components ?? [],
      routes: repo.routes ?? [],
    })) {
      expect(collection.length, `${name} is empty`).toBeGreaterThan(0);
    }

    const report = checkReferentialIntegrity(repo);
    expect({ danglingRefs: report.danglingRefs, violations: report.violations }).toEqual({
      danglingRefs: 0,
      violations: [],
    });

    // `.kt` only: a Kotlin target never claims other sources.
    expect(repo.files.every((f) => f.extension === '.kt' && f.language === 'kotlin')).toBe(true);
    // Every file's packageId is its KOTLIN package, so it is not constant across packages.
    expect(new Set(repo.files.map((f) => f.packageId)).size).toBeGreaterThan(1);
  });

  it('mints distinct ids for a Kotlin package and a Gradle module directory of the same name', async () => {
    const kotlin = await kotlinProvider.parse(profile, { repoRoot: root, repoName: 'demo', repoKey: 'demo' });

    const kotlinPackage = kotlin.packages.find((p) => p.name === 'app' && p.manifestFile === undefined);
    const gradleModule = kotlin.packages.find((p) => p.name === 'app' && p.manifestFile !== undefined);
    expect(kotlinPackage, 'Kotlin package `app`').toBeDefined();
    expect(gradleModule, 'Gradle module `app`').toBeDefined();
    // Both live at `app/...`; only the `kt:` namespace keeps them from merging into one node.
    expect(kotlinPackage?.id).not.toBe(gradleModule?.id);
    expect(gradleModule?.manifestFile).toBe('app/build.gradle.kts');
    expect(gradleModule?.type).toBe('mobile');
    expect(kotlin.packages.find((p) => p.path === '.' && p.manifestFile === undefined)).toBeDefined();
    expect(new Set(kotlin.packages.map((p) => p.id)).size).toBe(kotlin.packages.length);
  });

  it('reports stats.kotlin counters that match the emitted collections', async () => {
    const repo = await kotlinProvider.parse(profile, { repoRoot: root, repoName: 'demo', repoKey: 'demo' });
    const stats = repo.stats.kotlin;

    expect(stats).toBeDefined();
    if (!stats) return;
    expect(stats.filesParsed).toBe(repo.files.length);
    expect(stats.filesWithSyntaxErrors).toBe(0);
    expect(stats.callSites).toBeGreaterThanOrEqual(stats.resolvedCalls + stats.ambiguousCalls);
    // The FULL invariant: resolved sites and out-of-scope sites are both sites, so neither
    // partition can outgrow the denominator. The `resolved + ambiguous` form alone stayed green
    // while the site counter was erasing one call per chain.
    expect(stats.callSites).toBeGreaterThanOrEqual(stats.resolvedCalls + stats.outOfScopeCalls);
    expect(stats.resolvedCalls).toBe(repo.calls.length);
    expect(Object.values(stats.byTier).reduce((a, b) => a + b, 0)).toBe(stats.resolvedCalls);
    expect(stats.endpointsDefined).toBe(1);
    expect(stats.egressCallSites).toBe(repo.externalCalls.length);
    expect(stats.entrypointsWithoutHandler).toBe(0);
    expect(stats.unparsedDaoQueries).toBe(0);

    // The neutral record downstream reads must be the same computation, not a second one.
    expect(repo.stats.callResolution).toEqual({
      callSites: stats.callSites,
      resolvedCalls: stats.resolvedCalls,
      outOfScopeCalls: stats.outOfScopeCalls,
    });

    // The db-op record must reach ParseStats through the same assembly (spec AC-3): two Room
    // sites on this fixture — `all()` and `put()` — both entity-bound. `@Transaction both()` is
    // no operation of its own, and a Room site is never out of scope.
    expect(repo.stats.dbOpResolution).toEqual({ dbOpSites: 2, boundDbOps: 2, outOfScopeDbOps: 0 });

    expect(repo.stats.totalFunctions).toBe(repo.functions.length);
    expect(repo.stats.totalCalls).toBe(repo.calls.length);
    expect(repo.stats.totalEntities).toBe(repo.entities.length);
    expect(repo.stats.totalEntrypoints).toBe(repo.entrypoints.length);
    expect(repo.stats.totalExternalCalls).toBe(repo.externalCalls.length);
    expect(repo.stats.totalImports).toBe(repo.imports.length);
    expect(repo.stats.parsedFiles).toBe(repo.files.length);
    expect(repo.stats.skippedFiles).toBe(0);
  });

  it('produces an identical id set on a second parse', async () => {
    const ids = async (): Promise<string[]> => {
      const kotlin = await kotlinProvider.parse(profile, { repoRoot: root, repoName: 'demo', repoKey: 'demo' });
      return [
        ...kotlin.packages,
        ...kotlin.files,
        ...kotlin.functions,
        ...kotlin.classes,
        ...kotlin.interfaces,
        ...kotlin.enums,
        ...kotlin.variables,
        ...kotlin.typeAliases,
        ...kotlin.entrypoints,
        ...kotlin.entities,
        ...kotlin.dbOperations,
        ...kotlin.calls,
        ...kotlin.externalCalls,
        ...(kotlin.components ?? []),
        ...(kotlin.routes ?? []),
      ]
        .map((n) => n.id)
        .sort();
    };
    expect(await ids()).toEqual(await ids());
  });

  // Nothing is unreadable when the suite runs as root.
  it.skipIf(process.getuid?.() === 0)(
    'counts an unreadable file as skipped and reports it, without emitting it',
    async () => {
      const other = mkdtempSync(join(tmpdir(), 'kotlin-skip-'));
      const locked = join(other, 'Locked.kt');
      writeFileSync(join(other, 'Ok.kt'), 'package demo\n\nclass Ok\n');
      writeFileSync(locked, 'package demo\n\nclass Locked\n');
      chmodSync(locked, 0o000);
      try {
        const kotlin = await kotlinProvider.parse(profile, { repoRoot: other, repoName: 'skip', repoKey: 'skip' });
        expect(kotlin.stats).toMatchObject({ totalFiles: 2, parsedFiles: 1, skippedFiles: 1 });
        expect(kotlin.files.map((f) => f.path)).toEqual(['Ok.kt']);
        expect(kotlin.errors).toEqual([
          { file: 'Locked.kt', message: 'kotlin: file could not be read or parsed', severity: 'error' },
        ]);
      } finally {
        chmodSync(locked, 0o600);
        rmSync(other, { recursive: true, force: true });
      }
    },
  );

  it('emits no entities and no db operations when the profile declares no entities block', async () => {
    const kotlin = await kotlinProvider.parse(
      { parserId: 'kotlin-demo', substrate: { language: 'kotlin', include: ['**/*.kt'] } },
      { repoRoot: root, repoName: 'demo', repoKey: 'demo' },
    );
    expect(kotlin.entities).toEqual([]);
    expect(kotlin.dbOperations).toEqual([]);
    expect(kotlin.stats.kotlin?.unparsedDaoQueries).toBe(0);
  });
});
