import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as discovery from '../../facts/discovery/discover.js';
import { profile as modelsProfile } from './__fixtures__/models/profile.js';
import { providerForExport } from '../../providers/index.js';
import { CSharpSubstrate, finishCSharpParse } from './substrate.js';
import type { CSharpProfile } from '../../types/csharp-profile.js';
import type { ParseOptions } from '../../providers/types.js';
import { csharpSourceSignals } from './signals.js';
import { emittedCountsFromRepo, scoreCategories } from '../../scoring/score-core.js';

// These fixtures exercise syntax/framework interpretation, including deliberately
// invalid names used as counterexamples. Semantic binding has its own compiled fixture.
async function parseStructure(profile: CSharpProfile, opts: ParseOptions) {
  return finishCSharpParse(profile, await CSharpSubstrate.create(profile, opts), opts);
}

let root: string;
afterEach(() => {
  vi.restoreAllMocks();
  if (root) rmSync(root, { recursive: true, force: true });
});
function fixture(files: Record<string, string>) {
  root = mkdtempSync(join(tmpdir(), 'coredoc-csharp-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}
const profile = { parserId: 'csharp-test', substrate: { language: 'csharp', include: ['**/*.cs'] } };
async function parse() {
  const resolved = providerForExport(profile);
  return parseStructure(resolved!.profile as CSharpProfile, {
    repoRoot: root,
    repoName: 'fixture',
    repoKey: 'test/csharp',
  });
}

describe('C# syntax and framework facts through the C# substrate', () => {
  it.each<{
    setting: string;
    items: string;
    expected: number;
    files?: Record<string, string>;
    directory?: string;
    sourceUsing?: string;
  }>([
    { setting: '<ImplicitUsings>enable</ImplicitUsings>', items: '', expected: 1 },
    { setting: '<ImplicitUsings>true</ImplicitUsings>', items: '', expected: 1 },
    { setting: '<ImplicitUsings>disable</ImplicitUsings>', items: '', expected: 0 },
    { setting: '', items: '', expected: 0 },
    {
      setting: "<ImplicitUsings Condition=\"'$(Configuration)' == 'Debug'\">enable</ImplicitUsings>",
      items: '',
      expected: 0,
    },
    {
      setting: '<ImplicitUsings>enable</ImplicitUsings>',
      items: '<ItemGroup><Using Remove="System.Net.Http" /></ItemGroup>',
      expected: 0,
    },
    {
      setting: '<ImplicitUsings>enable</ImplicitUsings>',
      items: '',
      directory: 'src/App',
      files: {
        'Directory.Build.targets':
          '<Project><PropertyGroup><ImplicitUsings>disable</ImplicitUsings></PropertyGroup></Project>',
      },
      expected: 0,
    },
    {
      setting: '<ImplicitUsings>enable</ImplicitUsings>',
      items: '',
      files: {
        'Directory.Build.targets':
          '<Project><PropertyGroup><TargetFramework>net48</TargetFramework></PropertyGroup></Project>',
      },
      expected: 0,
    },
    {
      setting: '<ImplicitUsings>enable</ImplicitUsings>',
      items: '',
      files: {
        '.gitignore': 'Directory.Build.targets\n',
        'Directory.Build.targets': '<Project><ItemGroup><Using Remove="System.Net.Http" /></ItemGroup></Project>',
      },
      expected: 0,
    },
    {
      setting: '<ImplicitUsings>enable</ImplicitUsings>',
      items: '<Import Project="Overrides.targets" />',
      files: {
        'Overrides.targets':
          '<Project><PropertyGroup><ImplicitUsings>disable</ImplicitUsings></PropertyGroup></Project>',
      },
      expected: 0,
    },
    {
      setting: '<ImplicitUsings>enable</ImplicitUsings>',
      items: '<ImportGroup><Import Project="Overrides.targets" /></ImportGroup>',
      files: {
        'Overrides.targets':
          '<Project><PropertyGroup><ImplicitUsings>disable</ImplicitUsings></PropertyGroup></Project>',
      },
      expected: 0,
    },
    {
      setting: '<ImplicitUsings>enable</ImplicitUsings>',
      items: '',
      directory: 'src/App',
      files: {
        'other/Directory.Build.targets':
          '<Project><PropertyGroup><ImplicitUsings>disable</ImplicitUsings></PropertyGroup></Project>',
      },
      expected: 1,
    },
    {
      setting: '<ImplicitUsings>enable</ImplicitUsings>',
      items: '',
      sourceUsing: 'using System.Net.Http; ',
      files: {
        'Directory.Build.targets':
          '<Project><PropertyGroup><ImplicitUsings>disable</ImplicitUsings></PropertyGroup></Project>',
      },
      expected: 1,
    },
  ])('respects SDK implicit usings for HttpClientFactory (%j)', async ({
    setting,
    items,
    expected,
    files = {},
    directory = '',
    sourceUsing = '',
  }) => {
    const prefix = directory ? `${directory}/` : '';
    fixture({
      [`${prefix}App.csproj`]: `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework>${setting}</PropertyGroup>${items}</Project>`,
      [`${prefix}Client.cs`]: `${sourceUsing}class Client(IHttpClientFactory factory) { void Run() { var client = factory.CreateClient(); client.GetAsync("https://example.com/items"); } }`,
      ...files,
    });
    if (files['.gitignore']) execFileSync('git', ['init', '--quiet', root], { stdio: 'ignore' });
    const graph = await parseStructure(
      {
        ...profile,
        substrate: { language: 'csharp', include: ['**/*.cs'] },
        libraries: [
          {
            projectSdk: 'Microsoft.NET.Sdk',
            types: ['System.Net.Http.IHttpClientFactory', 'System.Net.Http.HttpClient'],
            members: {
              'System.Net.Http.IHttpClientFactory': { methods: { CreateClient: 'System.Net.Http.HttpClient' } },
            },
          },
        ],
        nominal: {
          externalCalls: [
            {
              receiverTypes: ['System.Net.Http.HttpClient'],
              serviceName: 'api',
              via: 'methods',
              methods: { GetAsync: { verb: 'GET', pathArg: 0 } },
            },
          ],
        },
      },
      { repoRoot: root, repoName: 'fixture' },
    );
    expect(graph.externalCalls).toHaveLength(expected);
    if (expected)
      expect(graph.externalCalls[0]).toMatchObject({ method: 'GET', targetPattern: 'https://example.com/items' });
  });

  it('keeps overloads in different partial declarations at the same inheritance level', async () => {
    fixture({
      'App.csproj': '<Project Sdk="Microsoft.NET.Sdk" />',
      'First.cs': 'partial class Split { public void Save(int value) {} public void Call() { Save(1); } }',
      'Second.cs': 'partial class Split { public void Save(object value) {} }',
    });
    const graph = await parse();
    const names = new Map(graph.functions.map((fn) => [fn.id, fn.name]));
    expect(graph.calls.map((call) => call.calleeId && names.get(call.calleeId))).toEqual(['Split.Save(int)']);
  });
  it('does not guess an overload from an unknown argument or hide applicable base overloads', async () => {
    fixture({
      'App.csproj': '<Project Sdk="Microsoft.NET.Sdk" />',
      'Types.cs': `class Parent {
        public void Send(string value) {} public void Widen(int value) {}
        public void Ping() {}
      }
      class Child : Parent {
        public void Send(int value) {} public void Widen(long value) {}
        public void Ping(int value) {}
        public void Call(bool flag) {
          Send(flag ? "a" : "b"); Send("known"); Send(1); Ping(); Widen(1);
        }
      }`,
    });
    const graph = await parse();
    const names = new Map(graph.functions.map((fn) => [fn.id, fn.name]));
    expect(graph.calls.map((call) => call.calleeId && names.get(call.calleeId))).toEqual([
      undefined,
      'Parent.Send(string)',
      'Child.Send(int)',
      'Parent.Ping()',
      undefined,
    ]);
  });
  it('requires visible framework identities even when the receiver text is fully qualified', async () => {
    fixture({
      'Web/Web.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web" />',
      'Web/Routes.cs': `class WebRoutes {
        void Register(Microsoft.AspNetCore.Builder.WebApplication app) { app.MapGet("/real", () => "ok"); }
      }`,
      'Plain/Plain.csproj': '<Project Sdk="Microsoft.NET.Sdk" />',
      'Plain/Routes.cs': `class PlainRoutes {
        void Register(Microsoft.AspNetCore.Builder.WebApplication app) { app.MapGet("/fake", () => "no"); }
      }`,
    });
    const graph = await parseStructure(
      {
        parserId: 'identity-check',
        substrate: { language: 'csharp', include: ['**/*.cs'] },
        libraries: [{ projectSdk: 'Microsoft.NET.Sdk.Web', types: ['Microsoft.AspNetCore.Builder.WebApplication'] }],
        nominal: {
          httpCalls: [
            {
              receiverTypes: ['Microsoft.AspNetCore.Builder.WebApplication'],
              verbs: { MapGet: 'GET' },
              pathArg: 0,
              handlerArg: 1,
            },
          ],
        },
      },
      { repoRoot: root, repoName: 'framework-identity' },
    );
    expect(graph.entrypoints.map((entry) => entry.details.path)).toEqual(['/real']);
  });
  it('does not register an entity through an unreferenced project type argument', async () => {
    fixture({
      'App/App.csproj':
        '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="Microsoft.EntityFrameworkCore.Relational" Version="10.0.6" /></ItemGroup></Project>',
      'App/Data.cs': `using Microsoft.EntityFrameworkCore;
        using System.ComponentModel.DataAnnotations.Schema;
        namespace App;
        [Table("known")] public class Known { public int Id { get; set; } }
        public class Context : DbContext {
          public DbSet<Known> Known { get; set; }
          public DbSet<Hidden.Record> Hidden { get; set; }
        }`,
      'Hidden/Hidden.csproj': '<Project Sdk="Microsoft.NET.Sdk" />',
      'Hidden/Record.cs':
        'using System.ComponentModel.DataAnnotations.Schema; namespace Hidden; [Table("hidden")] public class Record { public int Id { get; set; } }',
    });
    const graph = await parseStructure(modelsProfile, { repoRoot: root, repoName: 'entity-identity' });
    expect(graph.entities.map((entity) => entity.name)).toEqual(['App.Known']);
    expect(graph.entities[0]?.fields[0]?.type?.text).toBe('int');
  });
  it('does not treat an interface as base.M and retains record inheritance', async () => {
    fixture({
      'App.csproj': '<Project Sdk="Microsoft.NET.Sdk" />',
      'Types.cs': `interface IWorker { void Run(); }
        class Wrong : IWorker { public void Call() { base.Run(); } }
        record Parent { protected void Run() {} }
        record Child : Parent, IWorker { public void Call() { base.Run(); } }`,
    });
    const graph = await parse();
    const names = new Map(graph.functions.map((fn) => [fn.id, fn.name]));
    expect(graph.calls.map((call) => call.calleeId && names.get(call.calleeId))).toEqual([undefined, 'Parent.Run()']);
    expect(graph.classes.find((type) => type.name === 'Child')?.extends?.name).toBe('Parent');
    expect(graph.classes.find((type) => type.name === 'Child')?.implements?.map((type) => type.name)).toEqual([
      'IWorker',
    ]);
  });
  it('excludes protected methods for unrelated callers and internal methods across projects', async () => {
    fixture({
      'Library/Library.csproj': '<Project Sdk="Microsoft.NET.Sdk" />',
      'Library/Base.cs': `namespace Lib; public class Base { protected void Hidden() {} internal void Local() {} public void Public() {} }
        class Peer { void Call(Base b) { b.Hidden(); b.Local(); } }`,
      'App/App.csproj':
        '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><ProjectReference Include="../Library/Library.csproj" /></ItemGroup></Project>',
      'App/Caller.cs': `using Lib; class Other { void Call(Base b) { b.Hidden(); b.Local(); b.Public(); } }
        class Derived : Base { void Call() { base.Hidden(); base.Local(); } void ViaBaseValue(Base b) { b.Hidden(); } }`,
    });
    const graph = await parse();
    const names = new Map(graph.functions.map((fn) => [fn.id, fn.name]));
    const resolved = graph.calls
      .filter((call) => call.calleeId)
      .map((call) => [names.get(call.callerId), names.get(call.calleeId!)]);
    expect(resolved).toEqual([
      ['Other.Call(Base)', 'Lib.Base.Public()'],
      ['Derived.Call()', 'Lib.Base.Hidden()'],
      ['Lib.Peer.Call(Base)', 'Lib.Base.Local()'],
    ]);
  });
  it('warns and excludes loose source while ambiguous ownership remains an error', async () => {
    fixture({
      'App/App.csproj': '<Project Sdk="Microsoft.NET.Sdk" />',
      'App/App.cs': 'class App {}',
      'Loose.cs': 'class Loose {}',
      'Ambiguous/One.csproj': '<Project Sdk="Microsoft.NET.Sdk" />',
      'Ambiguous/Two.csproj': '<Project Sdk="Microsoft.NET.Sdk" />',
      'Ambiguous/App.cs': 'class Ambiguous {}',
    });
    const graph = await parse();
    expect(graph.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: 'Loose.cs', severity: 'warning' }),
        expect.objectContaining({ file: 'Ambiguous/App.cs', severity: 'error' }),
      ]),
    );
    expect(graph.stats.skippedFiles).toBe(2);
  });
  it('gives sibling-block local functions distinct stable IDs on repeat parsing', async () => {
    fixture({
      'App.csproj': '<Project Sdk="Microsoft.NET.Sdk" />',
      'App.cs':
        'class App { void Run() { { void Local() { One(); } } { void Local() { Two(); } } } void One() {} void Two() {} }',
    });
    const graph = await parse();
    const nested = graph.functions.filter((fn) => fn.name.includes('$Local'));
    expect(nested).toHaveLength(2);
    expect(new Set(nested.map((fn) => fn.id)).size).toBe(2);
    expect(new Set(graph.calls.map((call) => call.callerId)).size).toBe(2);
    expect((await parse()).functions.map((fn) => fn.id)).toEqual(graph.functions.map((fn) => fn.id));
  });
  it('keeps scoring other files when preprocessing reports a file error', async () => {
    fixture({
      'App.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web" />',
      'Broken.cs': '#if DEBUG + RELEASE\nclass Broken {}\n#endif',
      'Api.cs': 'class ItemsController { [HttpGet("/items")] public string Read() => "ok"; }',
    });
    const graph = await parse();
    expect(graph.errors).toContainEqual(expect.objectContaining({ file: 'Broken.cs', severity: 'error' }));
    const signals = csharpSourceSignals({
      repoRoot: root,
      sourceFiles: ['Broken.cs', 'Api.cs'],
      profile,
      parsed: graph,
      outPath: '',
    });
    expect(signals.http).toBe(1);
    expect(signals.hits?.http?.map((hit) => hit.file)).toEqual(['Api.cs']);
  });
  it('fails HTTP and egress coverage when the profile omits rules for visible source signals', async () => {
    fixture({
      'App.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web" />',
      'Api.cs': `using System.Net.Http; using Microsoft.AspNetCore.Mvc;
        class ItemsController { [HttpGet("/items")] public string Read() => "ok"; }
        class Client(HttpClient http) { public void Send() { http.GetAsync("/items"); } }
        class Store { public DbSet<Item> Items { get; set; } }`,
    });
    const graph = await parse();
    const signals = csharpSourceSignals({
      repoRoot: root,
      sourceFiles: ['Api.cs'],
      profile,
      parsed: graph,
      outPath: '',
    });
    const scores = scoreCategories(emittedCountsFromRepo(graph), signals);
    expect(scores.find((row) => row.category === 'http')).toMatchObject({ verdict: 'FAIL', status: 'required' });
    expect(scores.find((row) => row.category === 'externalCalls')).toMatchObject({
      verdict: 'FAIL',
      status: 'required',
    });
    expect(signals.entities).toBe(1);
    expect(signals.dbOperationsNote).toBeTruthy();
  });
  it('retains unresolved C# delegate calls whose names coincide with JavaScript builtins', async () => {
    fixture({
      'App.csproj': '<Project Sdk="Microsoft.NET.Sdk" />',
      'Worker.cs': 'class Worker { public void Run(System.Action add) { add(); } }',
    });
    const graph = await parse();
    expect(graph.calls.map((call) => [call.calleeExpression, call.calleeId])).toEqual([['add', undefined]]);
  });
  it('retains inherited model properties, derived overrides and ignores static members', async () => {
    fixture({
      'App.csproj':
        '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="Microsoft.EntityFrameworkCore.Relational" Version="10.0.6" /></ItemGroup></Project>',
      'Data.cs': `using Microsoft.EntityFrameworkCore; namespace Example;
        public class RecordBase { public int Id {get;set;} public virtual string Name {get;set;} public static int Counter {get;set;} }
        public class Record : RecordBase { public override string Name {get;set;} public int Value {get;set;} }
        public class Store : DbContext { protected override void OnModelCreating(ModelBuilder builder) { builder.Entity<Record>().ToTable("records"); } }`,
    });
    const graph = await parseStructure(modelsProfile, { repoRoot: root, repoName: 'inherited-model' });
    expect(graph.entities.map((e) => [e.name, e.fields.map((f) => f.name)])).toEqual([
      ['Example.Record', ['Id', 'Name', 'Value']],
    ]);
  });
  it('records `new T()` as a construction reference even when T declares no constructor', async () => {
    fixture({
      'App.csproj': '<Project Sdk="Microsoft.NET.Sdk" />',
      'Queries.cs':
        'namespace Shop.Queries; public class GetProducts {} public interface IQuery {} public enum Kind { A }',
      'Api.cs':
        'using Shop.Queries; namespace Shop.Web; public class Api { public object Get() { var q = new GetProducts(); return new Missing(); } }',
    });
    const graph = await parse();
    expect(
      graph.classReferences?.map((r) => [r.sourceId.split(':').at(-1), r.refKind, r.className, r.declaringFile]),
    ).toEqual([['Shop.Web.Api.Get()', 'construction', 'Shop.Queries.GetProducts', 'Queries.cs']]);
  });
  it('resolves external builder types in the current namespace for extension-method mappings', async () => {
    fixture({
      'App.csproj':
        '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="Microsoft.EntityFrameworkCore.Relational" Version="10.0.6" /></ItemGroup></Project>',
      'Data.cs': 'namespace Example; public class Record { public int Id {get;set;} }',
      'Mapping.cs':
        'namespace Microsoft.EntityFrameworkCore; public static class Mapping { public static void Configure(this ModelBuilder builder) { builder.Entity<Example.Record>().ToTable("records"); } }',
    });
    const graph = await parseStructure(modelsProfile, { repoRoot: root, repoName: 'same-namespace' });
    expect(graph.entities.map((e) => [e.name, e.tableName])).toEqual([['Example.Record', 'records']]);
  });
  it('uses an explicit FrameworkReference for controller facts without making it visible to unrelated projects', async () => {
    fixture({
      'Web/Web.csproj':
        '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><FrameworkReference Include="Microsoft.AspNetCore.App" /></ItemGroup></Project>',
      'Web/Api.cs':
        'using Microsoft.AspNetCore.Mvc; namespace Web; public class Api : Controller { [HttpGet("/framework")] public string Read() => "ok"; }',
      'Plain/Plain.csproj': '<Project Sdk="Microsoft.NET.Sdk" />',
      'Plain/Api.cs':
        'using Microsoft.AspNetCore.Mvc; namespace Plain; public class Api : Controller { [HttpGet("/unavailable")] public string Read() => "no"; }',
    });
    const graph = await parseStructure(
      {
        ...profile,
        substrate: { language: 'csharp', include: ['**/*.cs'] },
        libraries: [
          {
            dependency: 'Microsoft.AspNetCore.App',
            types: ['Microsoft.AspNetCore.Mvc.Controller', 'Microsoft.AspNetCore.Mvc.HttpGetAttribute'],
          },
        ],
        nominal: {
          controllers: [
            {
              baseTypes: ['Microsoft.AspNetCore.Mvc.Controller'],
              routeAttributes: [],
              verbAttributes: { 'Microsoft.AspNetCore.Mvc.HttpGetAttribute': 'GET' },
            },
          ],
        },
      },
      { repoRoot: root, repoName: 'framework-reference' },
    );
    expect(graph.entrypoints.map((e) => [e.details.path, e.handlerId?.split(':').at(-1)])).toEqual([
      ['/framework', 'Web.Api.Read()'],
    ]);
  });
  it('binds fluent model mappings, relations and generic context operations while rejecting lookalikes and conflicts', async () => {
    fixture({});
    cpSync(fileURLToPath(new URL('./__fixtures__/models', import.meta.url)), root, { recursive: true });
    const graph = await parseStructure(modelsProfile, { repoRoot: root, repoName: 'models' });
    expect(graph.entities.map((e) => [e.name, e.tableName, e.schema])).toEqual([
      ['Example.Parent', 'parents', undefined],
      ['Example.Item', 'items', 'catalog'],
    ]);
    const item = graph.entities.find((e) => e.name === 'Example.Item')!;
    expect(item.fields.map((f) => [f.name, f.columnName, f.dbType, f.isPrimaryKey, f.isNullable])).toEqual([
      ['Id', 'Id', undefined, true, false],
      ['ParentId', 'ParentId', undefined, false, false],
      ['Embedding', 'embedding', 'vector(3)', false, true],
    ]);
    expect(item.relations).toEqual([
      {
        name: 'Parent',
        type: 'many-to-one',
        targetEntityName: 'Example.Parent',
        targetEntityId: graph.entities.find((e) => e.name === 'Example.Parent')!.id,
        joinColumn: 'ParentId',
        inverseSide: 'Items',
      },
    ]);
    expect(graph.dbOperations.map((o) => [o.entityName, o.operation])).toEqual([
      ['Example.Item', 'read'],
      ['Example.Item', 'create'],
    ]);
  });
  it('preserves partial declaration identities when source discovery order changes', async () => {
    fixture({
      'App.csproj': '<Project Sdk="Microsoft.NET.Sdk" />',
      'A.cs': 'public partial class Service { public void First() {} }',
      'B.cs': 'public partial class Service { public void Second() {} }',
    });
    const enumeration = vi.spyOn(discovery, 'enumerateRepoFiles');
    enumeration.mockReturnValueOnce(['App.csproj', 'A.cs', 'B.cs']);
    const before = await parse();
    enumeration.mockReturnValueOnce(['B.cs', 'A.cs', 'App.csproj']);
    const after = await parse();
    expect(after.classes.map((c) => [c.id, c.fileId, c.location.filePath])).toEqual(
      before.classes.map((c) => [c.id, c.fileId, c.location.filePath]),
    );
    expect(after.functions.map((f) => f.id).sort()).toEqual(before.functions.map((f) => f.id).sort());
  });
  it('selects the default preprocessor branch even when defines is omitted', async () => {
    fixture({
      'App.csproj': '<Project Sdk="Microsoft.NET.Sdk" />',
      'Conditional.cs': '#if UNUSED\npublic class Inactive {}\n#else\npublic class Active {}\n#endif\n',
    });
    const graph = await parse();
    expect(graph.classes.map((c) => c.name)).toEqual(['Active']);
  });

  it('retains separate nested handlers in overloaded methods', async () => {
    fixture({
      'App.csproj': '<Project Sdk="Microsoft.NET.Sdk" />',
      'Handlers.cs': `public class Handlers {
        public void Run(int value) { System.Func<int> handler = () => value; }
        public void Run(string value) { System.Func<string> handler = () => value; }
      }`,
    });
    const graph = await parse();
    const lambdas = graph.functions.filter((f) => f.name.includes('$lambda'));
    expect(lambdas).toHaveLength(2);
    expect(new Set(lambdas.map((f) => f.id)).size).toBe(2);
    expect(lambdas.map((f) => f.location.startLine)).toEqual([2, 3]);
  });

  it('does not claim an unresolved external contract is a base class', async () => {
    fixture({
      'App.csproj': '<Project Sdk="Microsoft.NET.Sdk" />',
      'Types.cs':
        'public class External : UnknownContract {} public class Base {} public class Child : Base, UnknownContract {}',
    });
    const graph = await parse();
    expect(graph.classes.find((c) => c.name === 'External')?.extends).toBeUndefined();
    expect(graph.classes.find((c) => c.name === 'Child')?.extends?.resolvedId).toBe(
      graph.classes.find((c) => c.name === 'Base')?.id,
    );
  });

  it('binds a minimal HTTP registration to its emitted inline handler and ignores lookalikes', async () => {
    fixture({
      'App.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web" />',
      'Program.cs': `using Microsoft.AspNetCore.Builder;
        var builder = WebApplication.CreateBuilder(args);
        var app = builder.Build();
        app.MapGet("/health", () => "ok");
        app.MapGet(UnknownPath(), () => "unknown");
        app.Run();
        public class Local { public void MapGet(string path, object handler) {} public void Register() { MapGet("/fake", () => "no"); } }
        public class Registration {
          public string Handle() => "method";
          public void Map(WebApplication app, System.Func<string> Handle) { app.MapGet("/shadowed", Handle); }
          public void MapLocal(WebApplication app) { System.Func<string> Handle = () => "local"; app.MapGet("/local", Handle); }
        }`,
    });
    const p = {
      ...profile,
      libraries: [
        {
          projectSdk: 'Microsoft.NET.Sdk.Web',
          types: ['Microsoft.AspNetCore.Builder.WebApplication', 'Microsoft.AspNetCore.Builder.WebApplicationBuilder'],
          members: {
            'Microsoft.AspNetCore.Builder.WebApplication': {
              methods: { CreateBuilder: 'Microsoft.AspNetCore.Builder.WebApplicationBuilder' },
            },
            'Microsoft.AspNetCore.Builder.WebApplicationBuilder': {
              methods: { Build: 'Microsoft.AspNetCore.Builder.WebApplication' },
            },
          },
        },
      ],
      nominal: {
        httpCalls: [
          {
            receiverTypes: ['Microsoft.AspNetCore.Builder.WebApplication'],
            verbs: { MapGet: 'GET' },
            pathArg: 0,
            handlerArg: 1,
          },
        ],
      },
    };
    const r = providerForExport(p)!;
    const graph = await parseStructure(r.profile as CSharpProfile, { repoRoot: root, repoName: 'minimal' });
    expect(graph.entrypoints.map((e) => e.details)).toEqual([
      { type: 'http', method: 'GET', path: '/health', fullPath: '/health' },
    ]);
    expect(graph.functions.find((f) => f.id === graph.entrypoints[0]?.handlerId)?.sourceCode).toBe('() => "ok"');
  });
  it('composes nested constant groups and abstains for unknown or reassigned groups', async () => {
    fixture({
      'App.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web" />',
      'Program.cs': `using Microsoft.AspNetCore.Builder;
        var app = WebApplication.CreateBuilder(args).Build();
        var api = app.MapGroup("/api");
        var v1 = api.MapGroup("/v1");
        v1.MapGet("/items", () => "items");
        app.MapGroup("/direct").MapGroup("/nested").MapGet("/ok", () => "ok");
        app.MapGroup(GetPrefix()).MapGet("/unknown", () => "unknown");
        var moved = app.MapGroup("/old");
        moved = app.MapGroup("/new");
        moved.MapGet("/ambiguous", () => "no");
        string GetPrefix() => "/runtime";`,
    });
    const p = {
      ...profile,
      libraries: [
        {
          projectSdk: 'Microsoft.NET.Sdk.Web',
          types: [
            'Microsoft.AspNetCore.Builder.WebApplication',
            'Microsoft.AspNetCore.Builder.WebApplicationBuilder',
            'Microsoft.AspNetCore.Routing.RouteGroupBuilder',
          ],
          members: {
            'Microsoft.AspNetCore.Builder.WebApplication': {
              methods: {
                CreateBuilder: 'Microsoft.AspNetCore.Builder.WebApplicationBuilder',
                MapGroup: 'Microsoft.AspNetCore.Routing.RouteGroupBuilder',
              },
            },
            'Microsoft.AspNetCore.Builder.WebApplicationBuilder': {
              methods: { Build: 'Microsoft.AspNetCore.Builder.WebApplication' },
            },
            'Microsoft.AspNetCore.Routing.RouteGroupBuilder': {
              methods: { MapGroup: 'Microsoft.AspNetCore.Routing.RouteGroupBuilder' },
            },
          },
        },
      ],
      nominal: {
        httpCalls: [
          {
            receiverTypes: ['Microsoft.AspNetCore.Builder.WebApplication'],
            verbs: { MapGet: 'GET' },
            pathArg: 0,
            handlerArg: 1,
            groups: { receiverTypes: ['Microsoft.AspNetCore.Routing.RouteGroupBuilder'], methods: { MapGroup: 0 } },
          },
        ],
      },
    };
    const graph = await parseStructure(p as CSharpProfile, { repoRoot: root, repoName: 'groups' });
    expect(graph.entrypoints.map((e) => e.details)).toEqual([
      { type: 'http', method: 'GET', path: '/api/v1/items', fullPath: '/api/v1/items' },
      { type: 'http', method: 'GET', path: '/direct/nested/ok', fullPath: '/direct/nested/ok' },
    ]);
  });
  it('keeps named HTTP clients separate, preserves unknown addresses and recognizes a declared SDK', async () => {
    fixture({
      'App.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web" />',
      'Outgoing.cs': `using System.Net.Http; namespace Example;
        public class Outgoing(IHttpClientFactory factory, Demo.Gateway sdk) {
          public async Task Run(string unknown) {
            var first = factory.CreateClient("first");
            await first.GetStringAsync("items");
            var second = factory.CreateClient("second");
            await second.GetAsync("/status");
            await first.GetStringAsync(unknown);
            sdk.Publish("message");
            var moved = factory.CreateClient("first");
            moved = factory.CreateClient("second");
            await moved.GetAsync("/ambiguous");
          }
          public void Local(LocalClient client) { client.GetStringAsync("/fake"); }
        }
        public class LocalClient { public string GetStringAsync(string path) => path; }`,
      'Sdk.cs': 'namespace Demo; public class Gateway { public void Publish(string message) {} }',
    });
    const http = {
      via: 'methods' as const,
      receiverTypes: ['System.Net.Http.HttpClient'],
      sdkName: 'http',
      methods: { GetStringAsync: { verb: 'GET' as const, pathArg: 0 }, GetAsync: { verb: 'GET' as const, pathArg: 0 } },
    };
    const factory = { receiverTypes: ['System.Net.Http.IHttpClientFactory'], methods: ['CreateClient'], nameArg: 0 };
    const p: CSharpProfile = {
      parserId: 'egress-fixture',
      substrate: { language: 'csharp', include: ['**/*.cs'] },
      libraries: [
        {
          projectSdk: 'Microsoft.NET.Sdk.Web',
          types: ['System.Net.Http.HttpClient', 'System.Net.Http.IHttpClientFactory'],
          members: {
            'System.Net.Http.IHttpClientFactory': { methods: { CreateClient: 'System.Net.Http.HttpClient' } },
          },
        },
      ],
      nominal: {
        externalCalls: [
          {
            ...http,
            factory: { ...factory, name: 'first' },
            serviceName: 'first',
            baseAddress: 'https://first.example/v1/',
          },
          {
            ...http,
            factory: { ...factory, name: 'second' },
            serviceName: 'second',
            baseAddress: 'https://second.example/v2/',
          },
          {
            via: 'methods',
            receiverTypes: ['Demo.Gateway'],
            methods: { Publish: {} },
            serviceName: 'gateway',
            sdkName: 'neutral-sdk',
          },
        ],
      },
    };
    const graph = await parseStructure(p, { repoRoot: root, repoName: 'egress' });
    const expanded = structuredClone(p);
    const firstRule = expanded.nominal!.externalCalls![0]!;
    if (firstRule.via === 'methods') firstRule.methods.PostAsync = { verb: 'POST', pathArg: 0 };
    const rescanned = await parseStructure(expanded, { repoRoot: root, repoName: 'egress' });
    expect(rescanned.externalCalls.map((call) => call.versionedId)).toEqual(
      graph.externalCalls.map((call) => call.versionedId),
    );
    expect(graph.externalCalls.map((c) => [c.serviceName, c.method, c.targetPattern])).toEqual([
      ['first', 'GET', 'https://first.example/v1/items'],
      ['second', 'GET', 'https://second.example/status'],
      ['first', 'GET', undefined],
      ['gateway', 'Publish', undefined],
    ]);
    expect(graph.externalCalls.map((c) => c.targetDescriptor?.http?.pathTemplate)).toEqual([
      '/v1/items',
      '/status',
      undefined,
      undefined,
    ]);
    const conflicting = {
      ...p,
      nominal: {
        externalCalls: [...p.nominal!.externalCalls!, { ...p.nominal!.externalCalls![0]!, serviceName: 'conflicting' }],
      },
    };
    const ambiguous = await parseStructure(conflicting, { repoRoot: root, repoName: 'egress' });
    expect(ambiguous.externalCalls.map((c) => c.serviceName)).toEqual(['second', 'gateway']);
  });
  it('binds registered model operations and lifecycle handlers through declared receiver types', async () => {
    fixture({
      'App.csproj':
        '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="Microsoft.EntityFrameworkCore" Version="10.0.6"/><PackageReference Include="Microsoft.Extensions.Hosting" Version="10.0.0"/></ItemGroup></Project>',
      'Data.cs': `using Microsoft.EntityFrameworkCore;
        using System.ComponentModel.DataAnnotations;
        using System.ComponentModel.DataAnnotations.Schema;
        namespace Sample;
        [Table("items", Schema = "catalog")]
        public class Item {
          [Key] public int Id { get; set; }
          [Column("embedding", TypeName = "vector(3)")] public string Embedding { get; set; }
        }
        [Table("not_a_model")] public class Dto { public int Id { get; set; } }
        public class Unmapped { public int Id { get; set; } }
        public class Store : DbContext { public DbSet<Item> Items { get; set; } public DbSet<Unmapped> Missing { get; set; } }
        public class Repository(Store db) {
          public void Add(Item item) { db.Items.Add(item); }
          public async Task Read() { await db.Items.Where(x => x.Id > 0).ToListAsync(); }
          public void InMemory(List<Item> items) { items.Add(new Item()); }
          public void Missing(Unmapped value) { db.Missing.Add(value); }
          public void Save() { db.SaveChanges(); }
        }`,
      'Worker.cs': `using Microsoft.Extensions.Hosting; using Microsoft.Extensions.DependencyInjection;
        namespace Sample;
        public class Worker : IHostedService { public Task StartAsync(CancellationToken ct) => Task.CompletedTask; public Task StopAsync(CancellationToken ct) => Task.CompletedTask; }
        public class Unregistered : IHostedService { public Task StartAsync(CancellationToken ct) => Task.CompletedTask; public Task StopAsync(CancellationToken ct) => Task.CompletedTask; }
        public class Bootstrap { public void Register(IServiceCollection services) { services.AddHostedService<Worker>(); } }`,
    });
    const p = {
      ...profile,
      libraries: [
        {
          dependency: 'Microsoft.EntityFrameworkCore',
          types: ['Microsoft.EntityFrameworkCore.DbContext', 'Microsoft.EntityFrameworkCore.DbSet`1'],
        },
        {
          dependency: 'Microsoft.Extensions.Hosting',
          types: [
            'Microsoft.Extensions.Hosting.IHostedService',
            'Microsoft.Extensions.DependencyInjection.IServiceCollection',
          ],
        },
        {
          projectSdk: 'Microsoft.NET.Sdk',
          types: [
            'System.ComponentModel.DataAnnotations.Schema.TableAttribute',
            'System.ComponentModel.DataAnnotations.Schema.ColumnAttribute',
            'System.ComponentModel.DataAnnotations.KeyAttribute',
          ],
        },
      ],
      nominal: {
        registrations: [
          {
            receiverTypes: ['Microsoft.Extensions.DependencyInjection.IServiceCollection'],
            methods: ['AddHostedService'],
            typeArgument: 0,
            baseTypes: ['Microsoft.Extensions.Hosting.IHostedService'],
            handlers: ['StartAsync'],
            kind: 'event',
            eventName: 'host.start',
          },
        ],
        models: [
          {
            contextTypes: ['Microsoft.EntityFrameworkCore.DbContext'],
            setTypes: ['Microsoft.EntityFrameworkCore.DbSet`1'],
            orm: 'ef-core',
            tableAttributes: ['System.ComponentModel.DataAnnotations.Schema.TableAttribute'],
            columnAttributes: ['System.ComponentModel.DataAnnotations.Schema.ColumnAttribute'],
            keyAttributes: ['System.ComponentModel.DataAnnotations.KeyAttribute'],
            operations: { Add: 'create', ToListAsync: 'read' },
            chainMethods: ['Where'],
          },
        ],
      },
    };
    const r = providerForExport(p)!;
    const graph = await parseStructure(r.profile as CSharpProfile, { repoRoot: root, repoName: 'models' });
    expect(graph.entities.map((e) => [e.name, e.tableName, e.schema])).toEqual([['Sample.Item', 'items', 'catalog']]);
    expect(graph.entities[0]?.fields.map((f) => [f.name, f.columnName, f.dbType, f.isPrimaryKey])).toEqual([
      ['Id', 'Id', undefined, true],
      ['Embedding', 'embedding', 'vector(3)', false],
    ]);
    expect(graph.dbOperations.map((o) => o.operation).sort()).toEqual(['create', 'read']);
    expect(graph.dbOperations.every((o) => o.entityId === graph.entities[0]?.id)).toBe(true);
    expect(graph.entrypoints.map((e) => e.details)).toEqual([{ type: 'event', eventName: 'host.start' }]);
    expect(graph.stats.dbOpResolution).toEqual({ dbOpSites: 3, boundDbOps: 2, outOfScopeDbOps: 1 });
  });
  it('interprets qualified controller attributes, inheritance and rooted routes without lookalike matches', async () => {
    fixture({
      'App.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web" />',
      'Controllers.cs': `using Microsoft.AspNetCore.Mvc;
        namespace App;
        [Route("api/[controller]")]
        public abstract class BaseController : ControllerBase {}
        public class OrdersController : BaseController {
          [HttpGet] public string List() => "ok";
          [HttpPost][Route("{id}")] public string Save(string id) => id;
          [HttpGet("/health")] public string Health() => "ok";
          [HttpGet(Unknown)] public string Dynamic() => "unknown";
          [HttpGet][NonAction] public string Hidden() => "no";
        }
        public class Ordinary { [HttpGet("/false")] public void Nope() {} }`,
      'Lookalikes.cs': `namespace Fake;
        public class RouteAttribute { public RouteAttribute(string path) {} }
        public class HttpGetAttribute { public HttpGetAttribute(string path) {} }
        public class ControllerBase {}
        [Route("fake")] public class FakeController : ControllerBase {
          [HttpGet("no")] public void Nope() {}
        }`,
    });
    const p = {
      ...profile,
      libraries: [
        {
          projectSdk: 'Microsoft.NET.Sdk.Web',
          types: [
            'Microsoft.AspNetCore.Mvc.ControllerBase',
            'Microsoft.AspNetCore.Mvc.RouteAttribute',
            'Microsoft.AspNetCore.Mvc.HttpGetAttribute',
            'Microsoft.AspNetCore.Mvc.HttpPostAttribute',
            'Microsoft.AspNetCore.Mvc.NonActionAttribute',
          ],
        },
      ],
      nominal: {
        controllers: [
          {
            baseTypes: ['Microsoft.AspNetCore.Mvc.ControllerBase'],
            routeAttributes: ['Microsoft.AspNetCore.Mvc.RouteAttribute'],
            verbAttributes: {
              'Microsoft.AspNetCore.Mvc.HttpGetAttribute': 'GET',
              'Microsoft.AspNetCore.Mvc.HttpPostAttribute': 'POST',
            },
            ignoreAttributes: ['Microsoft.AspNetCore.Mvc.NonActionAttribute'],
            controllerSuffix: 'Controller',
          },
        ],
      },
    };
    const resolved = providerForExport(p)!;
    const graph = await parseStructure(resolved.profile as CSharpProfile, { repoRoot: root, repoName: 'routes' });
    expect(
      graph.entrypoints.map((e) => e.details).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    ).toEqual([
      { type: 'http', method: 'GET', path: '/api/Orders', fullPath: '/api/Orders' },
      { type: 'http', method: 'GET', path: '/health', fullPath: '/health' },
      { type: 'http', method: 'POST', path: '/api/Orders/{id}', fullPath: '/api/Orders/{id}' },
    ]);
    expect(graph.entrypoints.every((e) => graph.functions.some((f) => f.id === e.handlerId))).toBe(true);
  });
  it('abstains for invisible projects, ambiguous imports, overloads and shadowed receivers', async () => {
    fixture({
      'App/App.csproj': '<Project Sdk="Microsoft.NET.Sdk" />',
      'Invisible/Invisible.csproj': '<Project Sdk="Microsoft.NET.Sdk" />',
      'Invisible/Worker.cs': 'namespace Hidden; public class HiddenService { public void Run() {} }',
      'App/Services.cs': `namespace A { public class Service { public void Run() {} } }
        namespace B { public class Service { public void Run() {} } }
        namespace Shared { public class Worker {
          public void Send(int x) {} public void Send(string x) {}
          public void Check(dynamic input) { Send(input); Send(input); }
        } }`,
      'App/Caller.cs': `using A; using B; using Hidden;
        namespace App;
        public class Caller(Service service, HiddenService hidden, A.Service visible) {
          public void Check() {
            service.Run(); hidden.Run(); visible.Run();
            { dynamic visible = Factory(); visible.Run(); }
          }
        }`,
    });
    const graph = await parse();
    expect(graph.calls.filter((c) => c.calleeId).map((c) => c.calleeExpression)).toEqual(['visible.Run']);
    expect(graph.calls.filter((c) => c.calleeExpression === 'Send')).toHaveLength(2);
    expect(graph.stats.callResolution).toEqual({ callSites: 7, resolvedCalls: 1, outOfScopeCalls: 0 });
  });
  it('retains project ownership, declarations, overloads, partials and stable identities', async () => {
    fixture({
      'Domain/Domain.csproj':
        '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>',
      'Domain/Model.cs': `namespace Domain;
        public interface IService { string Send(string value); }
        public record Message(string Value);
        public struct Point { public int X { get; set; } }
        public enum State { Ready, Done }
        public class Container {}
        public class Container<T> {}
        public partial class Service : IService {
          public const string Prefix = "api";
          public string Send(string value) => value;
          public int Send(int value) => value;
        }`,
      'Domain/Service.Part.cs':
        'namespace Domain; public partial class Service { public string Other() => Send("hello"); }',
      'App/App.csproj':
        '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><ProjectReference Include="../Domain/Domain.csproj" /></ItemGroup></Project>',
      'App/Worker.cs':
        'using Domain; namespace App; public class Worker(Service service) { public string Run() => service.Send("x"); }',
    });
    const graph = await parse();
    expect(graph.errors?.filter((e) => e.severity === 'error') ?? []).toEqual([]);
    expect(graph.packages.map((p) => p.name).sort()).toEqual(['App', 'Domain']);
    expect(graph.classes.map((c) => c.name).sort()).toEqual([
      'App.Worker',
      'Domain.Container',
      'Domain.Container`1',
      'Domain.Message',
      'Domain.Point',
      'Domain.Service',
    ]);
    expect(graph.interfaces.map((i) => i.name)).toEqual(['Domain.IService']);
    const worker = graph.classes.find((c) => c.name === 'App.Worker')!;
    expect(worker.constructor?.parameters.map((p) => [p.name, p.type?.text])).toEqual([['service', 'Service']]);
    expect(graph.functions.find((f) => f.id === worker.constructor?.id)?.name).toBe('App.Worker..ctor(Service)');
    expect(graph.enums.map((e) => e.name)).toEqual(['Domain.State']);
    const overloads = graph.functions.filter((f) => f.name.startsWith('Domain.Service.Send('));
    expect(overloads).toHaveLength(2);
    expect(new Set(graph.functions.map((f) => f.id)).size).toBe(graph.functions.length);
    expect(graph.classes.find((c) => c.name === 'Domain.Service')?.methods).toHaveLength(3);
    const calls = graph.calls.filter((c) => c.calleeExpression.endsWith('Send'));
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.calleeId === overloads.find((f) => f.name.includes('(string)'))?.id)).toBe(true);
    expect(graph.stats.callResolution).toMatchObject({ callSites: 2, resolvedCalls: 2 });
    const before = graph.functions.map((f) => f.id).sort();
    writeFileSync(
      join(root, 'App/Worker.cs'),
      'using Domain; namespace App; public class Worker(Service service) { public string Run() => service.Send("changed"); }',
    );
    expect((await parse()).functions.map((f) => f.id).sort()).toEqual(before);
  });
});
