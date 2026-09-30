import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { create, toBinary } from '@bufbuild/protobuf';
import { IndexSchema } from '@scip-code/scip';
import { afterEach, describe, expect, it } from 'vitest';
import { csharpProvider } from '../../providers/csharp.js';
import { scoreProfile } from '../../score.js';
import type { LoadedScip } from '../../facts/scip/decode.js';
import { profile as groupsProfile } from './__fixtures__/groups/profile.js';
import { profile as egressProfile } from './__fixtures__/egress/profile.js';
import { profile as modelsProfile } from './__fixtures__/models/profile.js';
import { profile as dispatchProfile } from './__fixtures__/dispatch/profile.js';
import { profile as frameworksProfile } from './__fixtures__/frameworks/profile.js';

const fixture = fileURLToPath(new URL('./__fixtures__/semantic', import.meta.url));
const roots: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'coredoc-csharp-semantic-'));
  roots.push(dir);
  return dir;
};
afterEach(() => roots.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function prepared(directory = fixture) {
  const root = temp();
  cpSync(directory, root, { recursive: true });
  const loaded: LoadedScip = JSON.parse(readFileSync(join(directory, 'scip.json'), 'utf8'));
  const index = join(temp(), 'index.scip');
  writeFileSync(index, toBinary(IndexSchema, create(IndexSchema, { documents: loaded.documents })));
  writeFileSync(
    `${index}.json`,
    JSON.stringify({
      repoRoot: realpathSync(root),
      sourceHashes: Object.fromEntries(
        loaded.documents.map((d) => [
          d.relativePath,
          createHash('sha256')
            .update(readFileSync(join(root, d.relativePath)))
            .digest('hex'),
        ]),
      ),
      receiverTypes: existsSync(join(directory, 'receiver-types.json'))
        ? JSON.parse(readFileSync(join(directory, 'receiver-types.json'), 'utf8'))
        : undefined,
    }),
  );
  return { root, index };
}
const profile = { parserId: 'semantic-fixture', substrate: { language: 'csharp' as const, include: ['**/*.cs'] } };

describe('compiled C# semantic index through the registered provider', () => {
  it('binds EF operations from concrete DbSet receiver facts and rejects a fake receiver', async () => {
    const { root, index } = prepared(fileURLToPath(new URL('./__fixtures__/receivers', import.meta.url)));
    const graph = await csharpProvider.parse(modelsProfile, {
      repoRoot: root,
      repoName: 'receivers',
      preparedCSharpIndex: index,
    });
    expect(graph.errors ?? []).toEqual([]);
    expect(graph.stats.analysis).toEqual([
      { language: 'csharp', mode: 'enhanced', compilerReceiverTypes: true, fallback: false },
    ]);
    expect(graph.dbOperations.map((o) => [o.entityName, o.operation])).toEqual([
      ['Example.Item', 'read'],
      ['Example.Item', 'create'],
    ]);
  });
  it('records compiler call analysis without claiming unavailable receiver facts', async () => {
    const { root, index } = prepared();
    const graph = await csharpProvider.parse(profile, {
      repoRoot: root,
      repoName: 'no-receiver-facts',
      preparedCSharpIndex: index,
    });
    expect(graph.stats.analysis).toEqual([
      { language: 'csharp', mode: 'enhanced', compilerReceiverTypes: false, fallback: false },
    ]);
  });
  it('scores a basic C# profile without requiring tooling inside the profile sandbox', async () => {
    const { root } = prepared(fileURLToPath(new URL('./__fixtures__/generics', import.meta.url)));
    const profilePath = join(temp(), 'profile.ts');
    writeFileSync(
      profilePath,
      `import type { CSharpProfile } from '@coredoc/profile-parser';\nconst profile: CSharpProfile = ${JSON.stringify({ ...profile, substrate: { ...profile.substrate, analysis: { mode: 'basic' } } })};\nexport default profile;`,
    );
    await expect(scoreProfile(profilePath, root)).resolves.toBe(true);
  });
  it('exposes registered worker, job and hub handlers and retains ordinary wrapper calls', async () => {
    const { root, index } = prepared(fileURLToPath(new URL('./__fixtures__/frameworks', import.meta.url)));
    const graph = await csharpProvider.parse(frameworksProfile, {
      repoRoot: root,
      repoName: 'frameworks',
      preparedCSharpIndex: index,
    });
    expect(graph.errors ?? []).toEqual([]);
    const names = new Map(graph.functions.map((f) => [f.id, f.name]));
    expect(graph.entrypoints.map((e) => [names.get(e.handlerId), e.details])).toEqual([
      ['Example.Worker.StartAsync(CancellationToken)', { type: 'event', eventName: 'host.start' }],
      ['Example.ReportJob.Execute(IJobExecutionContext)', { type: 'event', eventName: 'quartz.job' }],
      ['Example.ChatHub.Send(string)', { type: 'websocket', event: 'Send', namespace: '/chat' }],
    ]);
    expect(graph.externalCalls).toEqual([]);
    expect(graph.entities).toEqual([]);
    const transform = graph.functions.find((f) => f.name === 'Example.Transformation.Map(Input)')!;
    expect(transform.parameters[0]?.type).toEqual({
      text: 'Input',
      structure: { kind: 'reference', name: 'Example.Input' },
    });
    expect(transform.returnType).toEqual({ text: 'Output', structure: { kind: 'reference', name: 'Example.Output' } });
    expect(graph.calls.filter((c) => c.calleeId).map((c) => [names.get(c.callerId), names.get(c.calleeId!)])).toEqual([
      ['Example.Transformation.Run().$lambda1()', 'Example.Transformation.Work()'],
    ]);
    expect(graph.calls.some((c) => c.calleeExpression === 'mapper.Map<Input, Output>')).toBe(true);
    expect(graph.calls.some((c) => c.calleeExpression === 'pipeline.Execute')).toBe(true);
  });
  it('promotes only the uniquely registered constructor contract to its compiler-proven implementation', async () => {
    const { root, index } = prepared(fileURLToPath(new URL('./__fixtures__/dispatch', import.meta.url)));
    const opts = { repoRoot: root, repoName: 'dispatch', preparedCSharpIndex: index };
    const baseline = await csharpProvider.parse({ ...dispatchProfile, nominal: undefined }, opts);
    const graph = await csharpProvider.parse(dispatchProfile, opts);
    expect(graph.errors ?? []).toEqual([]);
    const names = new Map(graph.functions.map((f) => [f.id, f.name]));
    expect(baseline.calls.filter((c) => c.calleeId).map((c) => names.get(c.calleeId!))).toEqual([
      'Example.IService.Send(string)',
      'Example.IService.Send(string)',
      'Example.IService.Send(string)',
      'Example.IAmbiguous.Run()',
      'Example.IFactory.Run()',
    ]);
    expect(
      graph.calls.filter((c) => c.calleeId).map((c) => [names.get(c.callerId), names.get(c.calleeId!), c.provenance]),
    ).toEqual([
      ['Example.Worker.Send()', 'Example.Service.Send(string)', 'di'],
      ['Example.Worker.Parameter(IService)', 'Example.IService.Send(string)', 'scip'],
      ['Example.Worker.Explicit()', 'Example.IService.Send(string)', 'scip'],
      ['Example.Worker.Ambiguous()', 'Example.IAmbiguous.Run()', 'scip'],
      ['Example.Worker.Factory()', 'Example.IFactory.Run()', 'scip'],
    ]);
  });
  it('retains exact fluent mappings and entity usage after real compiler indexing', async () => {
    const { root, index } = prepared(fileURLToPath(new URL('./__fixtures__/models', import.meta.url)));
    const graph = await csharpProvider.parse(modelsProfile, {
      repoRoot: root,
      repoName: 'models',
      preparedCSharpIndex: index,
    });
    expect(graph.errors ?? []).toEqual([]);
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
  it('emits source-bound HTTP, Refit and declared SDK calls without guessing unknown targets', async () => {
    const { root, index } = prepared(fileURLToPath(new URL('./__fixtures__/egress', import.meta.url)));
    const graph = await csharpProvider.parse(egressProfile, {
      repoRoot: root,
      repoName: 'egress',
      preparedCSharpIndex: index,
    });
    expect(graph.errors ?? []).toEqual([]);
    expect(graph.externalCalls.map((call) => [call.serviceName, call.method, call.targetPattern])).toEqual([
      ['first', 'GET', 'https://first.example/v1/items'],
      ['second', 'GET', 'https://second.example/status'],
      ['first', 'GET', undefined],
      ['gateway', 'Publish', undefined],
      ['remote', 'GET', 'https://remote.example/messages/{id}'],
    ]);
    expect(graph.externalCalls.map((call) => call.targetDescriptor?.http?.pathTemplate)).toEqual([
      '/v1/items',
      '/status',
      undefined,
      undefined,
      '/messages/{id}',
    ]);
    const functions = new Map(graph.functions.map((fn) => [fn.id, fn]));
    expect(graph.externalCalls.map((call) => functions.get(call.callerId)?.name)).toEqual([
      'Example.Outgoing.Run(string)',
      'Example.Outgoing.Run(string)',
      'Example.Outgoing.Run(string)',
      'Example.Outgoing.Run(string)',
      'Example.Remote.Load()',
    ]);
  });
  it('retains only proven complete route-group paths after semantic indexing', async () => {
    const { root, index } = prepared(fileURLToPath(new URL('./__fixtures__/groups', import.meta.url)));
    const graph = await csharpProvider.parse(groupsProfile, {
      repoRoot: root,
      repoName: 'groups',
      preparedCSharpIndex: index,
    });
    expect(graph.errors ?? []).toEqual([]);
    expect(graph.entrypoints.map((entry) => entry.details)).toEqual([
      { type: 'http', method: 'GET', path: '/api/v1/items', fullPath: '/api/v1/items' },
      { type: 'http', method: 'GET', path: '/direct/nested/ok', fullPath: '/direct/nested/ok' },
    ]);
    expect(
      graph.entrypoints.map((entry) => graph.functions.find((fn) => fn.id === entry.handlerId)?.sourceCode),
    ).toEqual(['() => "items"', '() => "ok"']);
  });
  it('does not bind a colliding compiler symbol to the only declaration left by the profile scope', async () => {
    const { root, index } = prepared(fileURLToPath(new URL('./__fixtures__/collisions', import.meta.url)));
    const graph = await csharpProvider.parse(
      {
        ...profile,
        substrate: { ...profile.substrate, exclude: ['Right.cs'] },
      },
      { repoRoot: root, repoName: 'fixture', preparedCSharpIndex: index },
    );
    expect(graph.calls.map((call) => ({ expression: call.calleeExpression, target: call.calleeId }))).toEqual([
      { expression: 'Right.Shared.Service.Ping', target: undefined },
    ]);
    expect(graph.stats.callResolution).toEqual({ callSites: 1, resolvedCalls: 0, outOfScopeCalls: 0 });
  });

  it('binds inferred and explicit generic calls to the generic overload, never the adjacent string overload', async () => {
    const { root, index } = prepared(fileURLToPath(new URL('./__fixtures__/generics', import.meta.url)));
    const graph = await csharpProvider.parse(profile, {
      repoRoot: root,
      repoName: 'fixture',
      preparedCSharpIndex: index,
    });
    const functions = new Map(graph.functions.map((f) => [f.id, f.name]));
    expect(graph.calls.map((call) => [functions.get(call.callerId), functions.get(call.calleeId!)])).toEqual([
      ['Methods.Inferred()', 'Methods.Choose`1(T)'],
      ['Methods.Explicit()', 'Methods.Choose`1(T)'],
    ]);
  });

  it('binds primary-constructor interface references and the exact overload across projects', async () => {
    const { root, index } = prepared();
    const graph = await csharpProvider.parse(profile, {
      repoRoot: root,
      repoName: 'fixture',
      preparedCSharpIndex: index,
    });
    expect(graph.errors ?? []).toEqual([]);
    const functions = new Map(graph.functions.map((f) => [f.id, f.name]));
    expect(
      graph.calls
        .filter((c) => c.calleeId)
        .map((c) => ({
          caller: functions.get(c.callerId),
          target: functions.get(c.calleeId!),
          provenance: c.provenance,
        })),
    ).toEqual([
      { caller: 'MessagesController.Get(string)', target: 'Example.Domain.IService.Send(string)', provenance: 'scip' },
      { caller: 'MessagesController.Local(Service)', target: 'Example.Domain.Service.Send(int)', provenance: 'scip' },
    ]);
    // The released fork records AddSingleton's generic reference as an external compiler symbol.
    expect(graph.stats.callResolution).toEqual({ callSites: 8, resolvedCalls: 2, outOfScopeCalls: 6 });
  });

  it('refuses stale coordinates instead of binding a changed file to an earlier index', async () => {
    const { root, index } = prepared();
    const file = join(root, 'App/Program.cs');
    writeFileSync(file, `\n${readFileSync(file, 'utf8')}`);
    await expect(
      csharpProvider.parse(profile, { repoRoot: root, repoName: 'fixture', preparedCSharpIndex: index }),
    ).rejects.toThrow(/changed since semantic indexing: App\/Program.cs/);
  });
});
