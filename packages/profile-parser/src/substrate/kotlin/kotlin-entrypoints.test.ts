import { StableIdGenerator } from '@coredoc/core';
import type { MobileEntrypointDetails } from '@coredoc/core/types';
import { describe, expect, it } from 'vitest';
import { extractKotlinFileFacts, type KotlinFileFacts, toKotlinFile } from './kotlin-declarations.js';
import { extractKotlinEntrypoints, resolveAndroidBases, resolveDeclaredName } from './kotlin-entrypoints.js';
import { KotlinTypeIndex } from './kotlin-resolve.js';
import { readManifest } from './kotlin-xml.js';

const idGen = new StableIdGenerator('repo-key');
const bases = resolveAndroidBases(undefined);

async function run(
  files: Record<string, string>,
  manifestXml: Record<string, string> = {},
  cfg?: Parameters<typeof resolveAndroidBases>[0],
) {
  const facts: KotlinFileFacts[] = [];
  for (const [path, source] of Object.entries(files)) {
    facts.push(extractKotlinFileFacts(await toKotlinFile(path, source), idGen));
  }
  const index = new KotlinTypeIndex(facts);
  const manifests = Object.entries(manifestXml)
    .map(([path, xml]) => readManifest(path, xml))
    .filter((m): m is NonNullable<typeof m> => !!m);
  return {
    index,
    facts,
    ...extractKotlinEntrypoints({ facts, index, bases: cfg ? resolveAndroidBases(cfg) : bases, manifests, idGen }),
  };
}

const details = (e: { details: unknown }) => e.details as MobileEntrypointDetails;

function manifest(body: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>\n<manifest package="app"><application>${body}</application></manifest>`;
}

const LAUNCHER_FILTER =
  '<intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter>';

describe('activities', () => {
  const homeActivity = 'package app\nclass Home : AppCompatActivity() {\n  fun onCreate() {}\n}\n';

  it('emits a launcher entrypoint for an activity whose manifest entry has the main action', async () => {
    const { entrypoints } = await run(
      { 'app/src/main/kotlin/Home.kt': homeActivity },
      {
        'app/src/main/AndroidManifest.xml': manifest(
          `<activity android:name=".Home" android:exported="true">${LAUNCHER_FILTER}</activity>`,
        ),
      },
    );
    expect(entrypoints).toHaveLength(1);
    expect(details(entrypoints[0])).toMatchObject({
      type: 'mobile',
      platform: 'android',
      trigger: 'launcher',
      className: 'Home',
      actions: ['android.intent.action.MAIN'],
      exported: true,
    });
    expect(entrypoints[0].handlerId).toBeTruthy();
  });

  // ANTI-SCENARIO: the MAIN action alone says "entry activity", not "shown by a launcher".
  // Reading it as a launcher would report a home-screen icon the app does not have.
  it('treats a main-action filter with no launcher category as a deep link, not a launcher', async () => {
    const { entrypoints } = await run(
      { 'app/src/main/kotlin/Home.kt': homeActivity },
      {
        'app/src/main/AndroidManifest.xml': manifest(
          '<activity android:name=".Home"><intent-filter><action android:name="android.intent.action.MAIN"/></intent-filter></activity>',
        ),
      },
    );
    expect(entrypoints).toHaveLength(1);
    expect(details(entrypoints[0]).trigger).toBe('deep-link');
  });

  it('counts a TV launcher category as a launcher', async () => {
    const { entrypoints } = await run(
      { 'app/src/main/kotlin/Home.kt': homeActivity },
      {
        'app/src/main/AndroidManifest.xml': manifest(
          '<activity android:name=".Home"><intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LEANBACK_LAUNCHER"/></intent-filter></activity>',
        ),
      },
    );
    expect(details(entrypoints[0]).trigger).toBe('launcher');
  });

  it('emits a deep-link entrypoint with the filter uri patterns', async () => {
    const { entrypoints } = await run(
      { 'app/src/main/kotlin/Home.kt': homeActivity },
      {
        'app/src/main/AndroidManifest.xml': manifest(
          '<activity android:name="app.Home"><intent-filter><action android:name="android.intent.action.VIEW"/><data android:scheme="https" android:host="thing" android:path="/a"/></intent-filter></activity>',
        ),
      },
    );
    expect(details(entrypoints[0])).toMatchObject({ trigger: 'deep-link', uriPatterns: ['https://thing/a'] });
  });

  // ANTI-SCENARIO: an activity that is only reachable from inside the app is not an entrypoint.
  it('emits nothing for a plain activity with no intent filter', async () => {
    const { entrypoints } = await run(
      { 'app/src/main/kotlin/Home.kt': homeActivity },
      { 'app/src/main/AndroidManifest.xml': manifest('<activity android:name=".Home"/>') },
    );
    expect(entrypoints).toEqual([]);
  });

  // ANTI-SCENARIO: fragments are internal screens, always (D-4).
  it('emits nothing for a fragment, even one declared in the manifest', async () => {
    const { entrypoints } = await run(
      { 'app/src/main/kotlin/Panel.kt': 'package app\nclass Panel : Fragment() {\n  fun onCreate() {}\n}\n' },
      { 'app/src/main/AndroidManifest.xml': manifest(`<activity android:name=".Panel">${LAUNCHER_FILTER}</activity>`) },
    );
    expect(entrypoints).toEqual([]);
  });

  it('keys the entrypoint on the declaring file, so two manifests declaring it yield ONE', async () => {
    const entry = `<activity android:name=".Home">${LAUNCHER_FILTER}</activity>`;
    const { entrypoints } = await run(
      { 'app/src/main/kotlin/Home.kt': homeActivity },
      {
        'app/src/main/AndroidManifest.xml': manifest(entry),
        'app/src/debug/AndroidManifest.xml': manifest(entry),
      },
    );
    expect(entrypoints).toHaveLength(1);
  });

  it('reaches a framework base through a repo base class', async () => {
    const { entrypoints } = await run(
      {
        'app/src/main/kotlin/Base.kt':
          'package app\nabstract class BaseScreen : AppCompatActivity() {\n  fun onCreate() {}\n}\n',
        'app/src/main/kotlin/Home.kt': 'package app\nclass Home : BaseScreen()\n',
      },
      { 'app/src/main/AndroidManifest.xml': manifest(`<activity android:name=".Home">${LAUNCHER_FILTER}</activity>`) },
    );
    // The inherited `onCreate` of the repo superclass is the handler; nothing is fabricated.
    expect(entrypoints.map((e) => details(e).className)).toEqual(['Home']);
  });

  // ANTI-SCENARIO: an in-repo class shadowing a framework name is NOT the framework class.
  it('emits nothing when the base name resolves to an unrelated in-repo class', async () => {
    const { entrypoints } = await run(
      {
        'app/src/main/kotlin/Shadow.kt': 'package app\nopen class Activity\n',
        'app/src/main/kotlin/Home.kt': 'package app\nclass Home : Activity() {\n  fun onCreate() {}\n}\n',
      },
      { 'app/src/main/AndroidManifest.xml': manifest(`<activity android:name=".Home">${LAUNCHER_FILTER}</activity>`) },
    );
    expect(entrypoints).toEqual([]);
  });
});

describe('the other component kinds', () => {
  it('emits a receiver, a worker, a push service, a service and a provider without any manifest entry', async () => {
    const { entrypoints } = await run({
      'app/src/main/kotlin/Comps.kt': [
        'package app',
        'class Watcher : BroadcastReceiver() { fun onReceive() {} }',
        'class Sync : CoroutineWorker() { fun doWork() {} }',
        'class Push : FirebaseMessagingService() { fun onMessageReceived() {} }',
        'class Player : Service() { fun onBind() {} }',
        'class Store : ContentProvider() { fun onCreate() {} }',
      ].join('\n'),
    });
    expect(entrypoints.map((e) => details(e).trigger).sort()).toEqual([
      'background-work',
      'broadcast',
      'content-provider',
      'push',
      'service',
    ]);
  });

  it('takes provider uri patterns from the manifest authorities and service actions from its filters', async () => {
    const { entrypoints } = await run(
      {
        'app/src/main/kotlin/Comps.kt': [
          'package app',
          'class Store : ContentProvider() { fun onCreate() {} }',
          'class Player : Service() { fun onStartCommand() {} }',
        ].join('\n'),
      },
      {
        'app/src/main/AndroidManifest.xml': manifest(
          '<provider android:name=".Store" android:authorities="app.store;app.other"/>' +
            '<service android:name=".Player"><intent-filter><action android:name="app.PLAY"/></intent-filter></service>',
        ),
      },
    );
    const byTrigger = new Map(entrypoints.map((e) => [details(e).trigger, details(e)]));
    expect(byTrigger.get('content-provider')?.uriPatterns).toEqual(['app.store', 'app.other']);
    expect(byTrigger.get('service')?.actions).toEqual(['app.PLAY']);
  });

  // ANTI-SCENARIO: a handler is never fabricated.
  it('emits nothing and counts a base-list class with no lifecycle method', async () => {
    const { entrypoints, entrypointsWithoutHandler } = await run({
      'app/src/main/kotlin/Empty.kt': 'package app\nclass Watcher : BroadcastReceiver() {\n  fun helper() {}\n}\n',
    });
    expect(entrypoints).toEqual([]);
    expect(entrypointsWithoutHandler).toBe(1);
  });

  it('classifies a push service as push, not as the plain service it also extends', async () => {
    const { entrypoints } = await run({
      'app/src/main/kotlin/Push.kt': [
        'package app',
        'abstract class BasePush : FirebaseMessagingService()',
        'class Push : BasePush() { fun onMessageReceived() {} }',
      ].join('\n'),
    });
    expect(entrypoints.map((e) => details(e).trigger)).toEqual(['push']);
  });

  it('honours an extra base class from the profile', async () => {
    const files = { 'app/src/main/kotlin/Job.kt': 'package app\nclass Job : NightlyWorker() { fun doWork() {} }\n' };
    expect((await run(files)).entrypoints).toEqual([]);
    const { entrypoints } = await run(files, {}, { workerBases: ['NightlyWorker'] });
    expect(entrypoints.map((e) => details(e).trigger)).toEqual(['background-work']);
  });
});

describe('manifest name resolution', () => {
  it('resolves an absolute FQCN and a relative name, and nothing for an unknown one', async () => {
    const { index } = await run({ 'app/src/main/kotlin/Home.kt': 'package app\nclass Home : AppCompatActivity()\n' });
    expect(resolveDeclaredName('app.Home', index)?.fqcn).toBe('app.Home');
    expect(resolveDeclaredName('.Home', index)?.fqcn).toBe('app.Home');
    expect(resolveDeclaredName('.Missing', index)).toBeUndefined();
  });

  // ANTI-SCENARIO: a manifest entry naming a class this parse cannot see is not evidence.
  it('emits nothing for a manifest android:name that resolves to nothing', async () => {
    const { entrypoints } = await run(
      { 'app/src/main/kotlin/Home.kt': 'package app\nclass Home : AppCompatActivity() { fun onCreate() {} }\n' },
      { 'app/src/main/AndroidManifest.xml': manifest(`<activity android:name=".Gone">${LAUNCHER_FILTER}</activity>`) },
    );
    expect(entrypoints).toEqual([]);
  });

  // ANTI-SCENARIO: two flavour copies of one FQCN make the name ambiguous.
  it('emits nothing when the manifest name is ambiguous across two declaring files', async () => {
    const source = 'package app\nclass Home : AppCompatActivity() { fun onCreate() {} }\n';
    const { entrypoints } = await run(
      { 'app/src/main/kotlin/Home.kt': source, 'app/src/demo/kotlin/Home.kt': source },
      { 'app/src/main/AndroidManifest.xml': manifest(`<activity android:name=".Home">${LAUNCHER_FILTER}</activity>`) },
    );
    expect(entrypoints).toEqual([]);
  });
});
