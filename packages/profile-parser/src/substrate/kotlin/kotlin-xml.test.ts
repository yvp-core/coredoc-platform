import { describe, expect, it } from 'vitest';
import { readManifest, readNavigationGraph, stripResourceId } from './kotlin-xml.js';

const MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="a.b">
  <application android:name=".App">
    <activity android:name=".MainActivity" android:exported="true">
      <intent-filter>
        <action android:name="android.intent.action.MAIN" />
        <category android:name="android.intent.category.LAUNCHER" />
      </intent-filter>
      <intent-filter>
        <action android:name="android.intent.action.VIEW" />
        <data android:scheme="app" android:host="things" android:pathPrefix="/open" />
      </intent-filter>
    </activity>
    <activity android:name="a.b.PlainActivity" />
    <receiver android:name=".Receiver" android:exported="false" />
    <service android:name=".PushService" />
    <provider android:name=".Provider" android:authorities="a.b.provider;a.b.other" />
  </application>
</manifest>`;

describe('readManifest', () => {
  it('reads components, their intent filters and their authorities', () => {
    const facts = readManifest('app/src/main/AndroidManifest.xml', MANIFEST);
    expect(facts?.packageName).toBe('a.b');
    expect(facts?.hasApplication).toBe(true);
    expect(facts?.components.map((c) => `${c.kind}:${c.name}`)).toEqual([
      'activity:.MainActivity',
      'activity:a.b.PlainActivity',
      'service:.PushService',
      'receiver:.Receiver',
      'provider:.Provider',
    ]);
    const main = facts?.components[0];
    expect(main?.exported).toBe(true);
    expect(main?.intentFilters[0].actions).toEqual(['android.intent.action.MAIN']);
    expect(main?.intentFilters[0].categories).toEqual(['android.intent.category.LAUNCHER']);
    expect(main?.intentFilters[1].uriPatterns).toEqual(['app://things/open']);
    expect(facts?.components[4].authorities).toEqual(['a.b.provider', 'a.b.other']);
  });

  it('ANTI: a component with no intent-filter carries an empty filter list, not a fabricated one', () => {
    const facts = readManifest('m.xml', MANIFEST);
    const plain = facts?.components.find((c) => c.name === 'a.b.PlainActivity');
    expect(plain?.intentFilters).toEqual([]);
    expect(plain?.exported).toBeUndefined();
  });

  it('ANTI: a malformed manifest is skipped with a warning and never throws', () => {
    const warnings: string[] = [];
    expect(readManifest('bad.xml', '<manifest><application>', (m) => warnings.push(m))).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('bad.xml');
  });

  it('ANTI: a well-formed XML file that is not a manifest yields nothing', () => {
    expect(readManifest('other.xml', '<resources><string name="a">b</string></resources>')).toBeUndefined();
  });

  it('a manifest with no <application> reports hasApplication false', () => {
    const facts = readManifest('lib.xml', '<manifest package="a.b" />');
    expect(facts?.hasApplication).toBe(false);
    expect(facts?.components).toEqual([]);
  });
});

const NAV = `<?xml version="1.0" encoding="utf-8"?>
<navigation xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:app="http://schemas.android.com/apk/res-auto"
    android:id="@+id/nav_main" app:startDestination="@id/home">
  <fragment android:id="@+id/home" android:name="a.b.HomeFragment">
    <action android:id="@+id/to_detail" app:destination="@id/detail" />
  </fragment>
  <dialog android:id="@+id/confirm" android:name="a.b.ConfirmDialog" />
  <navigation android:id="@+id/sub" app:startDestination="@id/inner">
    <fragment android:id="@+id/inner" android:name="a.b.InnerFragment" />
  </navigation>
  <fragment android:name="a.b.NoIdFragment" />
</navigation>`;

describe('readNavigationGraph', () => {
  it('reads destinations, nested graphs and actions', () => {
    const graph = readNavigationGraph('app/src/main/res/navigation/nav_main.xml', NAV);
    expect(graph?.startDestination).toBe('home');
    expect(graph?.destinations.map((d) => `${d.kind}:${d.id}`)).toEqual([
      'fragment:home',
      'dialog:confirm',
      'navigation:sub',
      'fragment:inner',
    ]);
    expect(graph?.destinations[0].componentName).toBe('a.b.HomeFragment');
    expect(graph?.destinations[0].actions).toEqual([{ id: 'to_detail', destination: 'detail' }]);
    expect(graph?.destinations[3].parentId).toBe('sub');
    expect(graph?.destinations[2].startDestination).toBe('inner');
  });

  it('ANTI: a destination without an android:id is not emitted', () => {
    const graph = readNavigationGraph('nav.xml', NAV);
    expect(graph?.destinations.some((d) => d.componentName === 'a.b.NoIdFragment')).toBe(false);
  });

  it('ANTI: a malformed navigation file is skipped with a warning, never a throw', () => {
    const warnings: string[] = [];
    expect(readNavigationGraph('bad.xml', '<navigation><fragment>', (m) => warnings.push(m))).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });

  it('ANTI: a layout file is not a navigation graph', () => {
    expect(readNavigationGraph('layout.xml', '<LinearLayout />')).toBeUndefined();
  });
});

describe('stripResourceId', () => {
  it('strips both id forms and leaves anything else alone', () => {
    expect(stripResourceId('@+id/home')).toBe('home');
    expect(stripResourceId('@id/home')).toBe('home');
    expect(stripResourceId('@android:id/home')).toBe('home');
    expect(stripResourceId('home')).toBe('home');
    expect(stripResourceId(undefined)).toBeUndefined();
  });
});
