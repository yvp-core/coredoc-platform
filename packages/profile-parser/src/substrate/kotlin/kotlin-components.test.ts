import { StableIdGenerator } from '@coredoc/core';
import { describe, expect, it } from 'vitest';
import { bindingToLayoutName, extractKotlinComponents, findLayoutFile } from './kotlin-components.js';
import { extractKotlinFileFacts, type KotlinFileFacts, toKotlinFile } from './kotlin-declarations.js';
import { resolveAndroidBases } from './kotlin-entrypoints.js';
import { KotlinTypeIndex } from './kotlin-resolve.js';
import { readNavigationGraph } from './kotlin-xml.js';

const idGen = new StableIdGenerator('repo-key');
const bases = resolveAndroidBases(undefined);

async function run(files: Record<string, string>, opts: { nav?: Record<string, string>; layoutFiles?: string[] } = {}) {
  const facts: KotlinFileFacts[] = [];
  for (const [path, source] of Object.entries(files)) {
    facts.push(extractKotlinFileFacts(await toKotlinFile(path, source), idGen));
  }
  const index = new KotlinTypeIndex(facts);
  const navGraphs = Object.entries(opts.nav ?? {})
    .map(([path, xml]) => readNavigationGraph(path, xml))
    .filter((g): g is NonNullable<typeof g> => !!g);
  return extractKotlinComponents({
    facts,
    index,
    bases,
    idGen,
    navGraphs,
    layoutFiles: opts.layoutFiles ?? [],
  });
}

const navXml = (body: string) =>
  `<?xml version="1.0" encoding="utf-8"?>\n<navigation xmlns:android="http://schemas.android.com/apk/res/android" xmlns:app="http://schemas.android.com/apk/res-auto">${body}</navigation>`;

describe('components', () => {
  it('emits a composable as a functional component with its child composables', async () => {
    const { components } = await run({
      'app/src/main/kotlin/Screens.kt': [
        'package app',
        '@Composable',
        'fun Home() {',
        '  Column {',
        '    Panel()',
        '  }',
        '}',
        '@Composable',
        'fun Panel() {}',
      ].join('\n'),
    });
    expect(components.map((c) => [c.name, c.framework, c.componentType])).toEqual([
      ['Home', 'compose', 'functional'],
      ['Panel', 'compose', 'functional'],
    ]);
    const home = components[0];
    expect(home.childComponents?.map((u) => u.componentName)).toEqual(['Panel']);
    expect(home.childComponents?.[0].componentId).toBe(components[1].id);
  });

  // ANTI-SCENARIO: a call whose CHAIN ROOT is another call is a method on that call's result,
  // not an invocation of the composable sharing its name. `isMethodCall` cannot see it: the
  // callee TEXT of `factory().Screen()` is the bare `Screen`.
  it('does not treat a method call on a call result as a child component', async () => {
    const { components } = await run({
      'app/src/main/kotlin/Screens.kt': [
        'package app',
        '@Composable',
        'fun Screen() {}',
        'class Factory { fun Screen() {} }',
        'fun factory(): Factory = Factory()',
        '@Composable',
        'fun Home() {',
        '  factory().Screen()',
        '}',
      ].join('\n'),
    });
    expect(components.find((c) => c.name === 'Home')?.childComponents).toBeUndefined();
  });

  // TWIN: written bare in the same body, the composable still links.
  it('links a bare composable call in the same body', async () => {
    const { components } = await run({
      'app/src/main/kotlin/Screens.kt': [
        'package app',
        '@Composable',
        'fun Screen() {}',
        'class Factory { fun Screen() {} }',
        'fun factory(): Factory = Factory()',
        '@Composable',
        'fun Home() {',
        '  Screen()',
        '}',
      ].join('\n'),
    });
    expect(components.find((c) => c.name === 'Home')?.childComponents?.map((u) => u.componentName)).toEqual(['Screen']);
  });

  // ANTI-SCENARIO: an unemitted callee is not a child component.
  it('does not treat an ordinary call as a child component', async () => {
    const { components } = await run({
      'app/src/main/kotlin/Screens.kt': ['package app', '@Composable', 'fun Home() {', '  compute()', '}'].join('\n'),
    });
    expect(components[0].childComponents).toBeUndefined();
  });

  it('emits an activity and a fragment class as class components, entrypoint or not', async () => {
    const { components } = await run({
      'app/src/main/kotlin/Screens.kt': [
        'package app',
        'class Home : AppCompatActivity()',
        'class Panel : Fragment()',
        'class Helper',
      ].join('\n'),
    });
    expect(components.map((c) => [c.name, c.framework, c.componentType])).toEqual([
      ['Home', 'android', 'class'],
      ['Panel', 'android', 'class'],
    ]);
  });
});

describe('layout link', () => {
  it('sets templateFile from R.layout and from a binding receiver, in any class', async () => {
    const { components } = await run(
      {
        'app/src/main/kotlin/Screens.kt': [
          'package app',
          'class Home : AppCompatActivity() {',
          '  fun onCreate() { setContentView(R.layout.home_screen) }',
          '}',
          'class Panel : Fragment() {',
          '  fun make() { HomeScreenBinding.inflate(inflater) }',
          '}',
        ].join('\n'),
      },
      { layoutFiles: ['app/src/main/res/layout/home_screen.xml'] },
    );
    expect(components.map((c) => c.templateFile)).toEqual([
      'app/src/main/res/layout/home_screen.xml',
      'app/src/main/res/layout/home_screen.xml',
    ]);
  });

  // ANTI-SCENARIO: a layout name with no file behind it sets nothing.
  it('sets no templateFile for R.layout.missing', async () => {
    const { components } = await run(
      {
        'app/src/main/kotlin/Screens.kt': [
          'package app',
          'class Home : AppCompatActivity() {',
          '  fun onCreate() { setContentView(R.layout.missing) }',
          '}',
        ].join('\n'),
      },
      { layoutFiles: ['app/src/main/res/layout/home_screen.xml'] },
    );
    expect(components[0].templateFile).toBeUndefined();
  });

  it('scans a long word run in linear time and still links the real binding after it', () => {
    // The unanchored `(\w+)Binding` restarted inside every position of a word-character run and
    // backtracked to its end: quadratic, seconds of CPU on a generated file.
    const source = `class Home {\n  val blob = "${'a'.repeat(200_000)}"\n  fun make() { HomeScreenBinding.inflate(inflater) }\n}`;
    const started = performance.now();
    const hit = findLayoutFile(source, ['app/src/main/res/layout/home_screen.xml']);
    const elapsed = performance.now() - started;
    expect(hit).toBe('app/src/main/res/layout/home_screen.xml');
    expect(elapsed).toBeLessThan(1000);
  });

  it('de-camel-cases a binding name', () => {
    expect(bindingToLayoutName('HomeScreenBinding')).toBe('home_screen');
    expect(bindingToLayoutName('ItemBinding')).toBe('item');
  });
});

describe('routes', () => {
  it('emits one route per navigation-XML destination, with the resolved component', async () => {
    const { routes, components } = await run(
      { 'app/src/main/kotlin/Panel.kt': 'package app\nclass Panel : Fragment()\n' },
      {
        nav: {
          'app/src/main/res/navigation/main.xml': navXml(
            '<fragment android:id="@+id/home" android:name="app.Panel"><action android:id="@+id/to_next" app:destination="@id/next"/></fragment>',
          ),
        },
      },
    );
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      path: 'home',
      componentName: 'app.Panel',
      componentId: components[0].id,
      isLazy: false,
      meta: { file: 'app/src/main/res/navigation/main.xml', actions: [{ id: 'to_next', destination: 'next' }] },
    });
  });

  it('gives two navigation graphs declaring the same destination id DISTINCT route ids', async () => {
    const body = '<fragment android:id="@+id/home" android:name="app.Panel"/>';
    const { routes } = await run(
      { 'app/src/main/kotlin/Panel.kt': 'package app\nclass Panel : Fragment()\n' },
      {
        nav: {
          'app/src/main/res/navigation/a.xml': navXml(body),
          'app/src/main/res/navigation/b.xml': navXml(body),
        },
      },
    );
    expect(routes).toHaveLength(2);
    expect(routes[0].id).not.toBe(routes[1].id);
  });

  it('sets parentRouteId for a nested graph', async () => {
    const { routes } = await run(
      {},
      {
        nav: {
          'app/src/main/res/navigation/main.xml': navXml(
            '<navigation android:id="@+id/flow" app:startDestination="@id/home"><fragment android:id="@+id/home"/></navigation>',
          ),
        },
      },
    );
    const child = routes.find((r) => r.path === 'home');
    const parent = routes.find((r) => r.path === 'flow');
    expect(child?.parentRouteId).toBe(parent?.id);
    expect(parent?.meta).toMatchObject({ startDestination: 'home' });
  });

  it('emits a route for a literal composable route inside a composable', async () => {
    const { routes, components } = await run({
      'app/src/main/kotlin/Nav.kt': [
        'package app',
        '@Composable',
        'fun App(nav: NavHostController) {',
        '  NavHost(nav, "home") {',
        '    composable("home") { Home() }',
        '  }',
        '}',
        '@Composable',
        'fun Home() {}',
      ].join('\n'),
    });
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      path: 'home',
      componentName: 'Home',
      componentId: components.find((c) => c.name === 'Home')?.id,
      meta: { navHost: 'App' },
    });
  });

  // ANTI-SCENARIO: a route we cannot read is not a route we may invent.
  it('emits no route for composable(routeVar) with a non-literal route', async () => {
    const { routes } = await run({
      'app/src/main/kotlin/Nav.kt': [
        'package app',
        '@Composable',
        'fun App() {',
        '  NavHost(nav, start) {',
        '    composable(routeVar) { Home() }',
        '  }',
        '}',
        '@Composable',
        'fun Home() {}',
      ].join('\n'),
    });
    expect(routes).toEqual([]);
  });

  // ANTI-SCENARIO: `$X` renders as `{X}`, a path that exists nowhere in the app.
  it('emits no route for an INTERPOLATED composable route', async () => {
    const { routes } = await run({
      'app/src/main/kotlin/Nav.kt': [
        'package app',
        'const val ROUTE_HOME = "home"',
        '@Composable',
        'fun App(nav: NavHostController) {',
        '  NavHost(nav, ROUTE_HOME) {',
        '    composable("$ROUTE_HOME/detail") { Home() }',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Kotlin source under test.
        '    composable("${ROUTE_HOME}/edit") { Home() }',
        '  }',
        '}',
        '@Composable',
        'fun Home() {}',
      ].join('\n'),
    });
    expect(routes).toEqual([]);
  });

  it('keys a compose route on its file, so the same path in two files stays two routes', async () => {
    const source = (name: string) =>
      ['package app', '@Composable', `fun ${name}() {`, '  composable("home") { }', '}'].join('\n');
    const { routes } = await run({
      'app/src/main/kotlin/A.kt': source('AppA'),
      'app/src/main/kotlin/B.kt': source('AppB'),
    });
    expect(routes).toHaveLength(2);
    expect(routes[0].id).not.toBe(routes[1].id);
  });
});

describe('screen-to-screen navigation is component usage, not a route', () => {
  it('records an Intent construction as a usage of the target activity', async () => {
    const { components, routes } = await run({
      'app/src/main/kotlin/Screens.kt': [
        'package app',
        'class Home : AppCompatActivity() {',
        '  fun go() { startActivity(Intent(this, Detail::class.java)) }',
        '}',
        'class Detail : AppCompatActivity()',
      ].join('\n'),
    });
    expect(routes).toEqual([]);
    const home = components.find((c) => c.name === 'Home');
    expect(home?.childComponents?.map((u) => u.componentName)).toEqual(['Detail']);
    expect(home?.childComponents?.[0].componentId).toBe(components.find((c) => c.name === 'Detail')?.id);
  });

  it('records a fragment transaction as a usage of the fragment', async () => {
    const { components } = await run({
      'app/src/main/kotlin/Screens.kt': [
        'package app',
        'class Home : AppCompatActivity() {',
        '  fun show() { replace(R.id.container, Panel()) }',
        '}',
        'class Panel : Fragment()',
      ].join('\n'),
    });
    expect(components[0].childComponents?.map((u) => u.componentName)).toEqual(['Panel']);
  });

  it('resolves navigate(R.id.x) through the navigation XML', async () => {
    const { components } = await run(
      {
        'app/src/main/kotlin/Screens.kt': [
          'package app',
          'class Home : AppCompatActivity() {',
          '  fun go() { navigate(R.id.panel) }',
          '}',
          'class Panel : Fragment()',
        ].join('\n'),
      },
      {
        nav: {
          'app/src/main/res/navigation/main.xml': navXml(
            '<fragment android:id="@+id/panel" android:name="app.Panel"/>',
          ),
        },
      },
    );
    expect(components[0].childComponents?.map((u) => u.componentName)).toEqual(['Panel']);
  });

  // ANTI-SCENARIO: an unresolved target appends nothing (the db drops a usage with no id).
  it('appends nothing for navigate(R.id.unknown)', async () => {
    const { components } = await run(
      {
        'app/src/main/kotlin/Screens.kt': [
          'package app',
          'class Home : AppCompatActivity() {',
          '  fun go() { navigate(R.id.unknown) }',
          '}',
        ].join('\n'),
      },
      {
        nav: {
          'app/src/main/res/navigation/main.xml': navXml(
            '<fragment android:id="@+id/panel" android:name="app.Panel"/>',
          ),
        },
      },
    );
    expect(components[0].childComponents).toBeUndefined();
  });

  it('resolves navigate("route") through the compose routes', async () => {
    const { components } = await run({
      'app/src/main/kotlin/Nav.kt': [
        'package app',
        '@Composable',
        'fun App() {',
        '  NavHost(nav, "home") {',
        '    composable("home") { Home() }',
        '  }',
        '}',
        '@Composable',
        'fun Home() {}',
        '@Composable',
        'fun Menu(nav: NavHostController) {',
        '  nav.navigate("home")',
        '}',
      ].join('\n'),
    });
    const menu = components.find((c) => c.name === 'Menu');
    expect(menu?.childComponents?.map((u) => u.componentName)).toEqual(['Home']);
  });

  // An interpolated destination IS resolvable here, unlike an interpolated route definition.
  // This is a lookup against routes already emitted, and `$id` renders as `{id}` — exactly how
  // a route template spells its parameter — so this is the ordinary way Compose navigation is
  // written. The fabrication guard is `sole()`: the usage appears only when exactly one emitted
  // route carries that path, and routes themselves are literal-only.
  it('resolves navigate("detail/$id") against the {id} route it names', async () => {
    const { components } = await run({
      'app/src/main/kotlin/Nav.kt': [
        'package app',
        '@Composable',
        'fun App(nav: NavHostController) {',
        '  NavHost(nav, "detail/{id}") {',
        '    composable("detail/{id}") { Home() }',
        '  }',
        '}',
        '@Composable',
        'fun Home() {}',
        '@Composable',
        'fun Menu(nav: NavHostController, id: String) {',
        '  nav.navigate("detail/$id")',
        '}',
      ].join('\n'),
    });
    expect(components.find((c) => c.name === 'Menu')?.childComponents?.map((u) => u.componentName)).toEqual(['Home']);
  });

  // ANTI-SCENARIO: an unknown literal route names nothing.
  it('appends nothing for navigate("gone")', async () => {
    const { components } = await run({
      'app/src/main/kotlin/Nav.kt': [
        'package app',
        '@Composable',
        'fun Menu(nav: NavHostController) {',
        '  nav.navigate("gone")',
        '}',
      ].join('\n'),
    });
    expect(components[0].childComponents).toBeUndefined();
  });
});
