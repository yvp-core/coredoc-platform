/**
 * End-to-end proof for the Kotlin substrate (AC-2, AC-3): ONE realistic Android repository on
 * disk under `__fixtures__/mini-android`, parsed as a whole.
 *
 * Each lane's own test proves its extraction rule on an inline snippet. What no snippet can
 * prove is ASSEMBLY: that the rule survives a real directory layout — two Gradle modules, three
 * Kotlin packages, two source sets, XML resources — with every id minted through
 * `StableIdGenerator` and every join resolving. So the assertions here are exact ids and exact
 * collection contents, and nothing is re-proved that a lane already proves in isolation.
 *
 * The fixture is deliberately NEUTRAL: `Thing`, `Repo`, `Home`, `named("api")`. No client
 * identifier belongs in shared code.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StableIdGenerator } from '@coredoc/core';
import type { MobileEntrypointDetails } from '@coredoc/core/types';
import { beforeAll, describe, expect, it } from 'vitest';
import { checkReferentialIntegrity } from '../../integrity/referential-integrity.js';
import type { KotlinProfile } from '../../types/kotlin-profile.js';
import { type KotlinParsedRepo, parseKotlinRepo, toFullParsedRepo } from './kotlin-parser.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__/mini-android');
const REPO_KEY = 'mini-android';
const idGen = new StableIdGenerator(ROOT, REPO_KEY);

const ROOM_PROFILE: KotlinProfile = {
  parserId: 'mini-android',
  substrate: { language: 'kotlin', include: ['**/*.kt'] },
  entities: { orm: 'room' },
};

/**
 * A repo carries ONE ORM, so the Realm models of the same fixture are proven by a second parse
 * under a realm profile — which is also the anti-scenario for the Room half (D-7).
 */
const REALM_PROFILE: KotlinProfile = {
  parserId: 'mini-android',
  substrate: { language: 'kotlin', include: ['**/*.kt'] },
  entities: { orm: 'realm' },
  dbOperations: { opMap: { save: 'create' } },
};

const UI = 'app/src/main/kotlin/app/ui';
const DATA = 'core/src/main/kotlin/core/data';

let repo: KotlinParsedRepo;
let byId: Map<string, { name: string }>;

beforeAll(async () => {
  repo = await parseKotlinRepo(ROOT, 'mini', { repoKey: REPO_KEY }, ROOM_PROFILE);
  byId = new Map([...repo.functions, ...repo.classes, ...repo.interfaces, ...repo.components].map((n) => [n.id, n]));
}, 120_000);

const named = (id: string) => byId.get(id)?.name ?? id;
const details = (e: { details: unknown }) => e.details as MobileEntrypointDetails;

describe('mini-android fixture — packages, files and declarations', () => {
  it('emits one package per Kotlin package and one per Gradle module, with distinct ids', () => {
    expect(repo.packages.map((p) => [p.name, p.id, p.path, p.type, p.manifestFile])).toEqual([
      ['app.di', idGen.packageId('kt:app.di'), 'app/src/main/kotlin/app/di', undefined, undefined],
      // `app.ui` lives in two source sets, so its package path is their common directory.
      ['app.ui', idGen.packageId('kt:app.ui'), 'app/src', undefined, undefined],
      ['core.data', idGen.packageId('kt:core.data'), DATA, undefined, undefined],
      ['mini', idGen.packageId('.'), '.', 'mobile', undefined],
      ['app', idGen.packageId('app'), 'app', 'mobile', 'app/build.gradle.kts'],
      ['core', idGen.packageId('core'), 'core', 'library', 'core/build.gradle.kts'],
    ]);
    expect(new Set(repo.packages.map((p) => p.id)).size).toBe(repo.packages.length);
  });

  it('claims every `.kt` file of both source sets and joins each to its Kotlin package', () => {
    expect(repo.files.map((f) => f.path)).toEqual([
      'app/src/demo/kotlin/app/ui/Flavored.kt',
      'app/src/main/kotlin/app/di/Modules.kt',
      `${UI}/DetailActivity.kt`,
      `${UI}/Flavored.kt`,
      `${UI}/HomeActivity.kt`,
      `${UI}/HomePanel.kt`,
      `${UI}/HomeScreen.kt`,
      `${UI}/Receivers.kt`,
      `${UI}/ThingView.kt`,
      `${DATA}/Callback.kt`,
      `${DATA}/Contracts.kt`,
      `${DATA}/Notes.kt`,
      `${DATA}/OtherApi.kt`,
      `${DATA}/ThingApi.kt`,
      `${DATA}/ThingDao.kt`,
      `${DATA}/ThingRepo.kt`,
      `${DATA}/ThingRow.kt`,
    ]);
    for (const file of repo.files) {
      expect(file.id, file.path).toBe(idGen.fileId(file.path));
      const pkg = file.path.startsWith('app/src/main/kotlin/app/di')
        ? 'app.di'
        : file.path.startsWith('app/')
          ? 'app.ui'
          : 'core.data';
      expect(file.packageId, file.path).toBe(idGen.packageId(`kt:${pkg}`));
    }
    // AC-8's `packageId` property, asserted here too: three packages, never one constant.
    expect(new Set(repo.files.map((f) => f.packageId)).size).toBe(3);
  });

  it('keeps BOTH declarations of the duplicated FQCN, one per source set (D-5)', () => {
    const flavored = repo.classes.filter((c) => c.name === 'Flavored');
    expect(flavored.map((c) => c.id)).toEqual([
      idGen.classId('app/src/demo/kotlin/app/ui/Flavored.kt', 'Flavored'),
      idGen.classId(`${UI}/Flavored.kt`, 'Flavored'),
    ]);
  });

  it('emits the object, the companion-free class set, the enum with a body and the fun interface members', () => {
    expect(repo.classes.map((c) => c.name)).toEqual([
      'Flavored',
      'DetailActivity',
      'Flavored',
      'HomeActivity',
      'HomePanel',
      'Watcher',
      'Idle',
      'ThingView',
      'Repo',
      'RepoImpl',
      'RepoAlt',
      'Clock',
      'ClockImpl',
      'Consumer',
      'Note',
      'Tag',
      'NoteRepo',
      'OtherApi',
      'ThingApi',
      'ThingDao',
      'Registry',
      'Status',
      'ThingRepo',
      'OtherRepo',
      'ThingRow',
    ]);
    // ANTI (AC-3 i): a companion and a file facade are not classes of their own.
    expect(repo.classes.map((c) => c.name)).not.toContain('Companion');
    expect(repo.classes.some((c) => c.name.endsWith('Kt'))).toBe(false);
    expect(repo.interfaces.map((i) => [i.name, i.id])).toEqual([
      ['Repo', idGen.interfaceId(`${DATA}/Contracts.kt`, 'Repo')],
      ['Clock', idGen.interfaceId(`${DATA}/Contracts.kt`, 'Clock')],
      ['OtherApi', idGen.interfaceId(`${DATA}/OtherApi.kt`, 'OtherApi')],
      ['ThingApi', idGen.interfaceId(`${DATA}/ThingApi.kt`, 'ThingApi')],
    ]);
    expect(repo.enums.map((e) => [e.name, e.id])).toEqual([['Status', idGen.enumId(`${DATA}/ThingRepo.kt`, 'Status')]]);
    // The enum's own body function is a method of it, not a stray file function.
    expect(repo.functions.find((f) => f.name === 'isOk')?.id).toBe(
      idGen.methodId(`${DATA}/ThingRepo.kt`, 'Status', 'isOk'),
    );
  });

  it('names an extension function by its receiver, collapses an overload pair and keeps the fun-interface file honest', () => {
    expect(repo.functions.find((f) => f.name === 'ThingRow.describe')?.id).toBe(
      idGen.functionId(`${DATA}/ThingRepo.kt`, 'ThingRow.describe'),
    );
    // ANTI (AC-3, overloads): two `format` declarations, ONE node — the first in source order.
    expect(repo.functions.filter((f) => f.name === 'format')).toHaveLength(1);
    // ANTI (AC-3 j): the `fun interface` file emits its other declaration and NOT the member.
    const callbackFns = repo.functions.filter((f) => f.fileId === idGen.fileId(`${DATA}/Callback.kt`));
    expect(callbackFns.map((f) => f.name)).toEqual(['noop']);
    // ANTI (AC-3 p): a function inside a lambda is not a FunctionNode.
    expect(repo.functions.map((f) => f.name)).not.toContain('onDone');
  });
});

describe('mini-android fixture — edges', () => {
  it('resolves each call through its precision tier and drops the duplicated-FQCN site', () => {
    expect(repo.calls.map((c) => `${named(c.callerId)}->${named(c.calleeId ?? '')}:${c.provenance}`)).toEqual([
      'onCreate->load:kt-type',
      'onCreate->showDetail:kt-member',
      'AppNav->HomeScreen:kt-local',
      'HomeScreen->Panel:kt-local',
      // A sole in-scope implementation retargets the interface member…
      'run->now:iface-impl',
      // …while a type with TWO implementations stops at the interface member (AC-3 m).
      'run->load:kt-type',
      'load->getThing:kt-type',
      'raw->fetchRaw:kt-type',
      'listen->register:kt-member',
      // A call inside an anonymous object belongs to the enclosing emitted function (AC-3 q).
      'listen->listThings:kt-type',
      // A member reached through an `object` declaration's own name, from another file.
      'listen->keyOf:kt-import',
      'push->addOther:kt-type',
    ]);
    const twoImpls = repo.calls.find((c) => named(c.callerId) === 'run' && named(c.calleeId ?? '') === 'load');
    expect(twoImpls?.calleeId).toBe(idGen.methodId(`${DATA}/Contracts.kt`, 'Repo', 'load'));
    expect(repo.calls.find((c) => c.provenance === 'iface-impl')?.calleeId).toBe(
      idGen.methodId(`${DATA}/Contracts.kt`, 'ClockImpl', 'now'),
    );
    // ANTI (AC-3 d): `flavored.ping()` names a duplicated FQCN — no edge, one ambiguous site.
    expect(repo.calls.some((c) => named(c.calleeId ?? '') === 'ping')).toBe(false);
    expect(repo.kotlinStats.ambiguousCalls).toBe(1);
    expect(new Set(repo.calls.map((c) => c.id)).size).toBe(repo.calls.length);
  });

  it('emits one egress edge per Retrofit call site, with the base path of its creation site', () => {
    expect(
      repo.externalCalls.map(
        (e) => `${named(e.callerId)} ${e.method} ${e.targetDescriptor?.http?.pathTemplate ?? '-'}`,
      ),
    ).toEqual([
      // Direct builder: `baseUrl("https://host.test/api/v1/")`.
      'load GET /api/v1/things/{id}',
      // ANTI (AC-3 c): an `@Url` endpoint carries a method and NO http block.
      'raw GET -',
      // …and so does its egress edge (AC-3 q).
      'listen GET /api/v1/things',
      // Koin qualifier: `single(named("api")) { … baseUrl("https://host.test/api/v2") }`.
      'push POST /api/v2/others',
    ]);
    expect(repo.externalCalls.every((e) => e.serviceName === '')).toBe(true);
    expect(repo.externalCalls[1].targetDescriptor).toEqual({ protocol: 'http' });
    expect(new Set(repo.externalCalls.map((e) => e.id)).size).toBe(4);
  });

  it('emits an import edge per import, resolved in-repo where the target file is parsed', () => {
    const modules = repo.imports.filter(
      (i) => i.sourceFileId === idGen.fileId('app/src/main/kotlin/app/di/Modules.kt'),
    );
    expect(modules.map((i) => i.moduleSpecifier)).toEqual([
      'core.data.Clock',
      'core.data.ClockImpl',
      'core.data.OtherApi',
      'core.data.Repo',
      'core.data.RepoAlt',
      'core.data.RepoImpl',
    ]);
    expect(modules.every((i) => i.targetFileId !== undefined)).toBe(true);
    // A framework import resolves to nothing rather than to a fabricated file.
    const activity = repo.imports.find((i) => i.moduleSpecifier === 'androidx.appcompat.app.AppCompatActivity');
    expect(activity?.targetFileId).toBeUndefined();
  });
});

describe('mini-android fixture — Android surfaces', () => {
  it('emits one entrypoint per externally triggered component, deduped across two manifests', () => {
    expect(repo.entrypoints.map((e) => [details(e).trigger, details(e).className, e.id])).toEqual([
      // Declared by BOTH `main` and `debug` manifests — keyed on the declaring FILE, so ONE node.
      ['launcher', 'HomeActivity', idGen.entrypointId('mobile', 'launcher:HomeActivity', `${UI}/HomeActivity.kt`)],
      ['broadcast', 'Watcher', idGen.entrypointId('mobile', 'broadcast:Watcher', `${UI}/Receivers.kt`)],
    ]);
    expect(repo.entrypoints.every((e) => e.type === 'mobile')).toBe(true);
    expect(details(repo.entrypoints[0])).toMatchObject({ actions: ['android.intent.action.MAIN'], exported: true });
    expect(repo.entrypoints[0].handlerId).toBe(idGen.methodId(`${UI}/HomeActivity.kt`, 'HomeActivity', 'onCreate'));
    // ANTI (AC-3 a, s): the filter-less activity and the handler-less receiver emit nothing.
    expect(repo.entrypoints.map((e) => details(e).className)).not.toContain('DetailActivity');
    expect(repo.kotlinStats.entrypointsWithoutHandler).toBe(1);
  });

  it('emits a component per screen with its layout and its outgoing screen usages', () => {
    expect(
      repo.components.map((c) => [
        c.name,
        c.framework,
        c.templateFile,
        (c.childComponents ?? []).map((u) => u.componentName),
      ]),
    ).toEqual([
      ['DetailActivity', 'android', undefined, []],
      ['HomeActivity', 'android', 'app/src/main/res/layout/home_screen.xml', ['DetailActivity']],
      ['HomePanel', 'android', 'app/src/main/res/layout/home_screen.xml', []],
      ['AppNav', 'compose', undefined, ['HomeScreen']],
      ['HomeScreen', 'compose', undefined, ['Panel']],
      ['Panel', 'compose', undefined, []],
    ]);
    expect(repo.components.map((c) => c.id)).toEqual([
      idGen.componentId(`${UI}/DetailActivity.kt`, 'DetailActivity'),
      idGen.componentId(`${UI}/HomeActivity.kt`, 'HomeActivity'),
      idGen.componentId(`${UI}/HomePanel.kt`, 'HomePanel'),
      idGen.componentId(`${UI}/HomeScreen.kt`, 'AppNav'),
      idGen.componentId(`${UI}/HomeScreen.kt`, 'HomeScreen'),
      idGen.componentId(`${UI}/HomeScreen.kt`, 'Panel'),
    ]);
    // A custom `View` binding a layout is not a screen: it is a class, never a component.
    expect(repo.components.map((c) => c.name)).not.toContain('ThingView');
    expect(repo.classes.some((c) => c.name === 'ThingView')).toBe(true);
  });

  it('emits a route per navigation-XML destination and per literal compose route', () => {
    expect(repo.routes.map((r) => [r.path, r.componentName, r.id])).toEqual([
      ['panel', 'app.ui.HomePanel', idGen.routeId('app/src/main/res/navigation/nav_graph.xml#panel')],
      ['home', 'HomeScreen', idGen.routeId(`${UI}/HomeScreen.kt#home`)],
    ]);
    expect(repo.routes[0].componentId).toBe(idGen.componentId(`${UI}/HomePanel.kt`, 'HomePanel'));
    expect(repo.routes[1].componentId).toBe(idGen.componentId(`${UI}/HomeScreen.kt`, 'HomeScreen'));
  });
});

describe('mini-android fixture — persistence', () => {
  it('reads the Room entity through its companion constant and each DAO annotation', () => {
    expect(repo.entities.map((e) => [e.tableName, e.ormType, e.id])).toEqual([
      ['things', 'room', idGen.entityId(`${DATA}/ThingRow.kt`, 'things')],
    ]);
    expect(repo.entities[0].fields.map((f) => `${f.name}:${f.columnName}:${f.isPrimaryKey}`)).toEqual([
      'id:id:true',
      'label:thing_label:false',
    ]);
    expect(repo.dbOperations.map((o) => `${o.operation}:${o.entityName}:${named(o.performerId)}`)).toEqual([
      // `@Query("SELECT * FROM ${TABLE}")` — the companion constant is folded before parsing.
      // Both rows name the ENTITY (`ThingRow`), not the table (`things`) the query matched on:
      // `find_entity_usage` keys consumers on that one string, so two spellings for one entity
      // would return a subset of its real consumers and read as a confident wrong answer.
      'read:ThingRow:all',
      'create:ThingRow:put',
    ]);
    // ANTI (AC-3 t, and the table-less query): neither emits an operation; the query is counted.
    expect(repo.dbOperations.map((o) => named(o.performerId))).not.toContain('both');
    expect(repo.kotlinStats.unparsedDaoQueries).toBe(1);
    // ANTI (AC-3 b): the Retrofit `@Query` PARAMETER is not a DAO query.
    expect(repo.dbOperations.map((o) => named(o.performerId))).not.toContain('listThings');
  });

  it('reads the same fixture as Realm under a realm profile, in all three operation shapes', async () => {
    const realm = await parseKotlinRepo(ROOT, 'mini', { repoKey: REPO_KEY }, REALM_PROFILE);
    expect(realm.entities.map((e) => [e.tableName, e.ormType, e.id])).toEqual([
      ['Note', 'realm', idGen.entityId(`${DATA}/Notes.kt`, 'Note')],
      ['Tag', 'realm', idGen.entityId(`${DATA}/Notes.kt`, 'Tag')],
    ]);
    expect(realm.entities[0].relations.map((r) => `${r.name}:${r.type}:${r.targetEntityName}`)).toEqual([
      'tag:many-to-one:Tag',
    ]);
    expect(realm.dbOperations.map((o) => `${o.operation}:${o.entityName}`)).toEqual([
      'read:Note', // (a) a chain rooted in a Realm-typed property
      'query:Note',
      'transaction:unknown', // (b) a receiver-less call inside a class holding a Realm
      'create:Note', // (c) an extension function named by the profile's op map
    ]);
    // ANTI (AC-3 h): the Room `@Entity` and its DAO emit nothing under a realm profile.
    expect(realm.entities.map((e) => e.tableName)).not.toContain('things');
    expect(realm.dbOperations.map((o) => o.entityName)).not.toContain('things');
  }, 120_000);
});

describe('mini-android fixture — the assembled ParsedRepo', () => {
  it('passes referential integrity with zero dangling references', () => {
    const full = toFullParsedRepo(repo, ROOT, ROOM_PROFILE.parserId, new Date(0).toISOString());
    const report = checkReferentialIntegrity(full);
    expect({ danglingRefs: report.danglingRefs, violations: report.violations }).toEqual({
      danglingRefs: 0,
      violations: [],
    });
  });

  it('reports honest counters, including the one file this grammar cannot parse', () => {
    expect(repo.kotlinStats).toEqual({
      filesParsed: 17,
      // `Callback.kt`: the bundled grammar does not accept `fun interface`, so its tree carries
      // an ERROR node. Everything OUTSIDE that subtree survives (`noop` is emitted above), and
      // the counter is the honest record of it rather than a silent zero.
      filesWithSyntaxErrors: 1,
      // One SITE per source CALL, not one per `call_expression` and not one per OFFSET. The
      // grammar gives `f(a) { … }` an outer and an inner node at the same offset — one call,
      // counted once — but it also nests `a.b().c()` at one offset, where each hop is its own
      // call. Keying the site on the offset counted the first shape right and erased one real
      // site per chain from the denominator this rate is measured against; the key is the
      // CALLEE span, which the duplicate pair share and the chain hops do not.
      callSites: 37,
      resolvedCalls: 12,
      ambiguousCalls: 1,
      // Calls to names this fixture never declares — `Toast.makeText`, `Log.d`, `setContentView`
      // and the rest of the platform surface a real app spends most of its calls on, plus the
      // four chain hops above (`Retrofit.Builder`, `baseUrl`, `get<Retrofit>`, `realm.where`).
      // They are the denominator the in-repo rate removes, which is why 12/37 reads as 12 of 13.
      outOfScopeCalls: 24,
      byTier: { 'kt-type': 6, 'kt-member': 2, 'kt-local': 2, 'iface-impl': 1, 'kt-import': 1 },
      endpointsDefined: 4,
      egressCallSites: 4,
      entrypointsWithoutHandler: 1,
      unparsedDaoQueries: 1,
    });
    expect(repo.parseStats).toMatchObject({ totalFiles: 17, parsedFiles: 17, skippedFiles: 0 });
  });

  it('mints every id uniquely, under this repo hash', () => {
    const ids = [
      ...repo.packages,
      ...repo.files,
      ...repo.functions,
      ...repo.classes,
      ...repo.interfaces,
      ...repo.enums,
      ...repo.imports,
      ...repo.calls,
      ...repo.entrypoints,
      ...repo.entities,
      ...repo.dbOperations,
      ...repo.externalCalls,
      ...repo.components,
      ...repo.routes,
    ].map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(idGen.belongsToRepo(id), id).toBe(true);
  });
});
