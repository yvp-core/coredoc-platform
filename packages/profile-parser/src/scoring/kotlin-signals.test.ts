import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ParsedRepo } from '@coredoc/core/types';
import type { KotlinProfile } from '../types/kotlin-profile.js';
import { kotlinSourceSignals } from './kotlin-signals.js';
import type { ScoreContext } from './score-core.js';

const FILES: Record<string, string> = {
  'src/Room.kt': `package demo

@Entity(tableName = "things")
data class ThingRow(@PrimaryKey val id: String)

@Entity
data class OtherRow(val id: String)
`,
  'src/Realm.kt': `package demo

open class RealmThing : RealmObject() {
    var id: String = ""
}

open class RealmOther : RealmObject()
`,
  'src/Api.kt': `package demo

interface Api {
    @GET("things/{id}")
    fun get(@Path("id") id: String): ThingRow

    @POST("things")
    fun create(@Body row: ThingRow)
}
`,
};

const sourceFiles = Object.keys(FILES);
let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'kotlin-signals-'));
  for (const [rel, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function ctx(profile: KotlinProfile): ScoreContext {
  return { repoRoot: root, sourceFiles, outPath: '', profile, parsed: {} as ParsedRepo };
}

const base: KotlinProfile = { parserId: 'p', substrate: { language: 'kotlin', include: ['**/*.kt'] } };

describe('kotlinSourceSignals', () => {
  it('counts entity annotation lines for a Room profile and verb-annotation lines for egress', () => {
    const signals = kotlinSourceSignals(ctx({ ...base, entities: { orm: 'room' } }));
    expect(signals.http).toBe(0);
    expect(signals.entities).toBe(2); // the two `@Entity` lines, not the Realm classes
    expect(signals.externalCalls).toBe(2); // `@GET` + `@POST`
    expect(signals.hits?.entities?.map((h) => h.file)).toEqual(['src/Room.kt', 'src/Room.kt']);
    expect(signals.hits?.externalCalls?.map((h) => h.line)).toEqual([4, 7]);
  });

  it('counts inheritance clauses for a Realm profile', () => {
    const signals = kotlinSourceSignals(ctx({ ...base, entities: { orm: 'realm' } }));
    expect(signals.entities).toBe(2); // the two `: RealmObject` clauses, not the `@Entity` lines
    expect(signals.hits?.entities?.every((h) => h.file === 'src/Realm.kt')).toBe(true);
  });

  it('omits dbOperations, queue, cli, grpc and graphql and discloses the db-ops basis', () => {
    const signals = kotlinSourceSignals(ctx({ ...base, entities: { orm: 'room' } }));
    expect(signals.dbOperations).toBeUndefined();
    expect(signals.queue).toBeUndefined();
    expect(signals.cli).toBeUndefined();
    expect(signals.grpc).toBeUndefined();
    expect(signals.graphql).toBeUndefined();
    expect(signals.dbOperationsNote).toMatch(/not commensurable/);
  });

  it('honours a profile that names its own entity annotations and verb set', () => {
    const signals = kotlinSourceSignals(
      ctx({ ...base, entities: { orm: 'room', annotations: ['PrimaryKey'] }, egress: { verbAnnotations: ['POST'] } }),
    );
    expect(signals.entities).toBe(1);
    expect(signals.externalCalls).toBe(1);
  });
});
