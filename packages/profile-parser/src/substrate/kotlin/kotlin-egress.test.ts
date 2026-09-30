import { StableIdGenerator } from '@coredoc/core';
import { describe, expect, it } from 'vitest';
import { type KotlinFileFacts, extractKotlinFileFacts, toKotlinFile } from './kotlin-declarations.js';
import { extractKotlinEgress, joinPathTemplate } from './kotlin-egress.js';
import { KotlinTypeIndex } from './kotlin-resolve.js';

const idGen = new StableIdGenerator('repo-key');

async function egress(files: Record<string, string>, cfg: { verbAnnotations?: string[] } = {}) {
  const all: KotlinFileFacts[] = [];
  for (const [path, source] of Object.entries(files)) {
    all.push(extractKotlinFileFacts(await toKotlinFile(path, source), idGen));
  }
  return extractKotlinEgress(all, new KotlinTypeIndex(all), idGen, cfg);
}

const API = [
  'package a',
  'interface Api {',
  '  @GET("things/{id}") fun getThing(@Path("id") id: String): Thing',
  '  @POST("things") fun addThing(): Thing',
  '}',
].join('\n');

describe('endpoint definitions', () => {
  it('reads a verb annotation on every function of an interface', async () => {
    const r = await egress({ 'a/Api.kt': API });
    expect(r.endpointsDefined).toBe(2);
  });

  it('takes the method of @HTTP from its named argument', async () => {
    const r = await egress({
      'a/Api.kt': [
        'package a',
        'interface Api {',
        '  @HTTP(method = "DELETE", path = "things/{id}") fun drop(id: String)',
        '}',
      ].join('\n'),
      'a/Use.kt': ['package a', 'class Use(val api: Api) {', '  fun run() { api.drop("1") }', '}'].join('\n'),
    });
    expect(r.edges.map((e) => e.method)).toEqual(['DELETE']);
    expect(r.edges[0].targetDescriptor).toEqual({
      protocol: 'http',
      http: { method: 'DELETE', pathTemplate: '/things/{id}' },
    });
  });

  it('ANTI: an unknown @HTTP verb is dropped rather than defaulted to GET', async () => {
    const r = await egress({
      'a/Api.kt': ['package a', 'interface Api {', '  @HTTP(method = "FETCH", path = "things") fun drop()', '}'].join(
        '\n',
      ),
    });
    expect(r.endpointsDefined).toBe(0);
  });

  it('ANTI: a verb annotation on a plain class is not an endpoint holder', async () => {
    const r = await egress({
      'a/Api.kt': ['package a', 'class Api {', '  @GET("things") fun getThings() {}', '}'].join('\n'),
    });
    expect(r.endpointsDefined).toBe(0);
  });

  it('ANTI: a profile verb set that omits a verb drops that endpoint', async () => {
    const r = await egress({ 'a/Api.kt': API }, { verbAnnotations: ['POST'] });
    expect(r.endpointsDefined).toBe(1);
  });
});

describe('base path', () => {
  const use = ['package a', 'class Use(val api: Api) {', '  fun run() { api.getThing("1") }', '}'].join('\n');

  it('folds the baseUrl literal of the same expression into the template', async () => {
    const r = await egress({
      'a/Api.kt': API,
      'a/Di.kt': [
        'package a',
        'class Di {',
        '  fun make(): Api = Retrofit.Builder().baseUrl("https://host/v1/").build().create(Api::class.java)',
        '}',
      ].join('\n'),
      'a/Use.kt': use,
    });
    expect(r.edges[0].targetDescriptor).toEqual({
      protocol: 'http',
      http: { method: 'GET', pathTemplate: '/v1/things/{id}' },
    });
  });

  it('follows one hop to the property the receiver names', async () => {
    const r = await egress({
      'a/Api.kt': API,
      'a/Di.kt': [
        'package a',
        'class Di {',
        '  private val retrofit = Retrofit.Builder().baseUrl("https://host/v2").build()',
        '  fun make(): Api = retrofit.create(Api::class.java)',
        '}',
      ].join('\n'),
      'a/Use.kt': use,
    });
    expect(r.edges[0].targetDescriptor?.http?.pathTemplate).toBe('/v2/things/{id}');
  });

  it('follows a Koin qualifier to the single(named(...)) binding that sets baseUrl', async () => {
    const r = await egress({
      'a/Api.kt': API,
      'a/Di.kt': [
        'package a',
        'fun module() {',
        '  single(named("api")) { Retrofit.Builder().baseUrl("https://host/v3").build() }',
        '  single { get<Retrofit>(named("api")).create(Api::class.java) }',
        '}',
      ].join('\n'),
      'a/Use.kt': use,
    });
    expect(r.edges[0].targetDescriptor?.http?.pathTemplate).toBe('/v3/things/{id}');
  });

  it('ANTI: two create sites disagreeing yield a template with no base path', async () => {
    const r = await egress({
      'a/Api.kt': API,
      'a/Di.kt': [
        'package a',
        'class Di {',
        '  fun one(): Api = Retrofit.Builder().baseUrl("https://host/v1").build().create(Api::class.java)',
        '  fun two(): Api = Retrofit.Builder().baseUrl("https://host/v2").build().create(Api::class.java)',
        '}',
      ].join('\n'),
      'a/Use.kt': use,
    });
    expect(r.edges[0].targetDescriptor?.http?.pathTemplate).toBe('/things/{id}');
  });

  it('ANTI: a same-named retrofit property in another module contributes no base path', async () => {
    const r = await egress({
      'a/Api.kt': API,
      'a/Di.kt': [
        'package a',
        'class DiA {',
        '  private val retrofit = Retrofit.Builder().baseUrl("https://host/aprefix/").build()',
        '  fun make(): Any = retrofit.create(Thing::class.java)',
        '}',
      ].join('\n'),
      'b/Di.kt': [
        'package b',
        'import a.Api',
        'class DiB {',
        '  fun make(): Api = retrofit.create(Api::class.java)',
        '}',
      ].join('\n'),
      'a/Use.kt': use,
    });
    // `/aprefix/` belongs to module a; module b's create site must not borrow it.
    expect(r.edges[0].targetDescriptor?.http?.pathTemplate).toBe('/things/{id}');
  });

  it('ANTI: two same-named baseUrl properties in ONE file contribute no base path', async () => {
    const r = await egress({
      'a/Api.kt': API,
      'a/Di.kt': [
        'package a',
        'class Di {',
        '  private val retrofit = Retrofit.Builder().baseUrl("https://host/v1/").build()',
        '  private val other = object {',
        '    val retrofit = Retrofit.Builder().baseUrl("https://host/v2/").build()',
        '  }',
        '  fun make(): Api = retrofit.create(Api::class.java)',
        '}',
      ].join('\n'),
      'a/Use.kt': use,
    });
    expect(r.edges[0].targetDescriptor?.http?.pathTemplate).toBe('/things/{id}');
  });

  it('ANTI: a BuildConfig member or bare identifier contributes no base path', async () => {
    const r = await egress({
      'a/Api.kt': API,
      'a/Di.kt': [
        'package a',
        'class Di {',
        '  fun make(): Api = Retrofit.Builder().baseUrl(BuildConfig.HOST).build().create(Api::class.java)',
        '}',
      ].join('\n'),
      'a/Use.kt': use,
    });
    expect(r.edges[0].targetDescriptor?.http?.pathTemplate).toBe('/things/{id}');
  });

  it('keeps only the literal operands of a + chain', async () => {
    const r = await egress({
      'a/Api.kt': API,
      'a/Di.kt': [
        'package a',
        'class Di {',
        '  fun make(): Api = Retrofit.Builder().baseUrl(host() + "/v4/").build().create(Api::class.java)',
        '}',
      ].join('\n'),
      'a/Use.kt': use,
    });
    expect(r.edges[0].targetDescriptor?.http?.pathTemplate).toBe('/v4/things/{id}');
  });
});

describe('call sites', () => {
  it('emits one edge per call with an empty serviceName', async () => {
    const r = await egress({
      'a/Api.kt': API,
      'a/Use.kt': [
        'package a',
        'class Use(val api: Api) {',
        '  fun run() { api.getThing("1"); api.addThing() }',
        '}',
      ].join('\n'),
    });
    expect(r.egressCallSites).toBe(2);
    expect(r.edges.every((e) => e.serviceName === '')).toBe(true);
    expect(r.edges.map((e) => e.method).sort()).toEqual(['GET', 'POST']);
  });

  it('resolves a receiver that is a local binding typed by the interface', async () => {
    const r = await egress({
      'a/Api.kt': API,
      'a/Use.kt': ['package a', 'class Use {', '  fun run() { val api: Api = build(); api.addThing() }', '}'].join(
        '\n',
      ),
    });
    expect(r.egressCallSites).toBe(1);
  });

  it('ANTI: a same-named call on an unrelated receiver emits nothing', async () => {
    const r = await egress({
      'a/Api.kt': API,
      'a/Other.kt': 'package a\nclass Other { fun getThing(id: String) {} }',
      'a/Use.kt': ['package a', 'class Use(val other: Other) {', '  fun run() { other.getThing("1") }', '}'].join('\n'),
    });
    expect(r.edges).toEqual([]);
  });

  it('ANTI: an unused endpoint definition emits no edge', async () => {
    const r = await egress({ 'a/Api.kt': API });
    expect(r.endpointsDefined).toBe(2);
    expect(r.edges).toEqual([]);
  });
});

describe('dynamic endpoints (D-8, EC-3)', () => {
  it('emits an edge with a method and NO http block for an @Url parameter', async () => {
    const r = await egress({
      'a/Api.kt': ['package a', 'interface Api {', '  @GET fun fetch(@Url url: String): Thing', '}'].join('\n'),
      'a/Use.kt': ['package a', 'class Use(val api: Api) {', '  fun run() { api.fetch("u") }', '}'].join('\n'),
    });
    expect(r.edges).toHaveLength(1);
    expect(r.edges[0].method).toBe('GET');
    expect(r.edges[0].targetDescriptor).toEqual({ protocol: 'http' });
    expect(r.edges[0].details).toBeUndefined();
  });

  it('a verb annotation with no string argument is dynamic even without @Url', async () => {
    const r = await egress({
      'a/Api.kt': ['package a', 'interface Api {', '  @POST fun push(body: String): Thing', '}'].join('\n'),
      'a/Use.kt': ['package a', 'class Use(val api: Api) {', '  fun run() { api.push("b") }', '}'].join('\n'),
    });
    expect(r.edges[0].targetDescriptor).toEqual({ protocol: 'http' });
  });
});

describe('joinPathTemplate', () => {
  it('single-slashes, keeps the leading slash and drops the trailing one', () => {
    expect(joinPathTemplate('/v1/', 'things/')).toBe('/v1/things');
    expect(joinPathTemplate('', 'things/{id}')).toBe('/things/{id}');
    expect(joinPathTemplate('', '')).toBe('/');
  });

  it('a root-relative endpoint path discards the base path (HttpUrl.resolve)', () => {
    expect(joinPathTemplate('/v1/', '/things/')).toBe('/things');
    expect(joinPathTemplate('/v1', '/things')).toBe('/things');
  });
});

describe('base-path resolution against the endpoint path', () => {
  const FACADE = (path: string) =>
    [
      'package a',
      'object Facade {',
      '  private val retrofit = Retrofit.Builder().baseUrl("https://example.com/v1/").build()',
      '  val api: Api = retrofit.create(Api::class.java)',
      '}',
      'interface Api {',
      `  @GET("${path}") fun users(): Thing`,
      '}',
      'class Use { fun run() { Facade.api.users() } }',
    ].join('\n');

  it('a root-relative @GET("/users") ignores the base path of baseUrl(…/v1/)', async () => {
    const r = await egress({ 'a/All.kt': FACADE('/users') });
    expect(r.edges[0].targetDescriptor?.http?.pathTemplate).toBe('/users');
  });

  it('a relative @GET("users") appends to the base path of baseUrl(…/v1/)', async () => {
    const r = await egress({ 'a/All.kt': FACADE('users') });
    expect(r.edges[0].targetDescriptor?.http?.pathTemplate).toBe('/v1/users');
  });
});

describe('object-facade receivers', () => {
  const FACADE = [
    'package a',
    'object Facade {',
    '  private val retrofit = Retrofit.Builder().baseUrl("https://host/v1/").build()',
    '  val api: Api = retrofit.create(Api::class.java)',
    '  val other: Other = Other()',
    '}',
  ].join('\n');

  it('walks Facade.api.getThing(…) through the object property to the interface', async () => {
    const r = await egress({
      'a/Api.kt': API,
      'a/Facade.kt': FACADE,
      'a/Other.kt': 'package a\nclass Other { fun getThing(id: String) {} }',
      'a/Use.kt': ['package a', 'class Use {', '  fun run() { Facade.api.getThing("1") }', '}'].join('\n'),
    });
    expect(r.egressCallSites).toBe(1);
    expect(r.edges[0].targetDescriptor?.http?.pathTemplate).toBe('/v1/things/{id}');
  });

  it('reads the base path of a newBuilder chain in an object property initializer', async () => {
    const r = await egress({
      'a/Api.kt': API,
      'a/Facade.kt': [
        'package a',
        'object Facade {',
        '  private val retrofit = Retrofit.Builder().baseUrl("https://host/v1/").build()',
        '  val api: Api = retrofit.newBuilder()',
        '          .baseUrl(host() + "v2/things-api/")',
        '          .build()',
        '          .create(Api::class.java)',
        '}',
      ].join('\n'),
      'a/Use.kt': ['package a', 'class Use {', '  fun run() { Facade.api.getThing("1") }', '}'].join('\n'),
    });
    expect(r.edges[0].targetDescriptor?.http?.pathTemplate).toBe('/v2/things-api/things/{id}');
  });

  it('ANTI: an intermediate property that is not an endpoint holder emits nothing', async () => {
    const r = await egress({
      'a/Api.kt': API,
      'a/Facade.kt': FACADE,
      'a/Other.kt': 'package a\nclass Other { fun getThing(id: String) {} }',
      'a/Use.kt': ['package a', 'class Use {', '  fun run() { Facade.other.getThing("1") }', '}'].join('\n'),
    });
    expect(r.edges).toEqual([]);
  });

  it('ANTI: a chain whose root resolves to nothing emits nothing', async () => {
    const r = await egress({
      'a/Api.kt': API,
      'a/Use.kt': ['package a', 'class Use {', '  fun run() { Unknown.api.getThing("1") }', '}'].join('\n'),
    });
    expect(r.edges).toEqual([]);
  });

  it('ANTI: a second property hop is out of the bounded walk', async () => {
    const r = await egress({
      'a/Api.kt': API,
      'a/Facade.kt': ['package a', 'object Facade {', '  val inner: Holder = Holder()', '}'].join('\n'),
      'a/Holder.kt': ['package a', 'class Holder {', '  val api: Api = build()', '}'].join('\n'),
      'a/Use.kt': ['package a', 'class Use {', '  fun run() { Facade.inner.api.getThing("1") }', '}'].join('\n'),
    });
    expect(r.edges).toEqual([]);
  });
});
