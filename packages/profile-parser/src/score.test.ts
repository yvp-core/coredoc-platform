import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ParsedRepo } from '@coredoc/core/types';
import { afterAll, describe, expect, it } from 'vitest';
import { emittedLocationsFromRepo, operatedEntityCount } from './scoring/score-core.js';
import {
  entitySourceCount,
  externalCallsSourceCount,
  queueSourceCount,
  tsSourceSignals,
} from './scoring/ts-signals.js';
import type { EntityRule, ExtractionProfile } from './types.js';

/**
 * D — the entity-denominator must come from the profile's DECLARED ORM source
 * (Prisma schema model blocks, class-decorator `@Entity`, call-shape factory ORMs),
 * NOT the broad `@Entity|class.*Model|…` grep that over-counts DTO/base classes and
 * produces false FAIL verdicts. Falls back to the broad count only when the profile
 * declares no entity source.
 */

const classDecoratorRule = (name: string): EntityRule =>
  ({
    orm: 'mikro-orm',
    detect: { via: 'class-decorator', name },
    fields: {},
    relations: { target: { arg: 0, as: 'identifier' } },
  }) as EntityRule;

const callShapeRule = (callee: string): EntityRule =>
  ({
    orm: 'sequelize',
    detect: { via: 'call-shape', callee },
    name: { arg: 0, as: 'const-string' },
    fields: {},
    relations: { target: { arg: 0, as: 'identifier' } },
  }) as EntityRule;

const prismaRule = (schemaPath: string): EntityRule => ({ orm: 'prisma', schemaPath });

const dirs: string[] = [];
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'score-d-'));
  dirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

afterAll(() => {
  // mkdtemp dirs are under the OS temp dir; leave cleanup to the OS (vitest has no rmSync helper here).
});

describe('entitySourceCount', () => {
  it('counts class-decorator @Entity occurrences and IGNORES class.*Model DTOs', () => {
    const root = fixture({
      'src/entities/user.ts':
        '@Entity()\nexport class User {}\n@Entity({ tableName: "posts" })\nexport class Post {}\n',
      'src/entities/team.ts': '@Entity()\nexport class Team {}\n',
      // Decoys: DTO/base/view classes mentioning "Model" — must NOT be counted.
      'src/dto/user-model.ts': 'export class UserModel {}\nexport class BaseModel {}\nexport class ViewModel {}\n',
    });
    // 3 real @Entity decorators; the broad grep would also catch the 3 *Model decoys.
    expect(entitySourceCount([classDecoratorRule('Entity')], ['src/**'], root, 999)).toBe(3);
  });

  it('counts call-shape factory ORM define() sites (`*.define`)', () => {
    const root = fixture({
      'src/models.ts':
        'const User = sequelize.define("User", {});\nconst Post = sequelize.define("Post", {});\nconst Team = db.define("Team", {});\n',
    });
    expect(entitySourceCount([callShapeRule('*.define')], ['src/**'], root, 999)).toBe(3);
  });

  it('counts Prisma `model` blocks in the declared schema', () => {
    const root = fixture({
      'prisma/schema.prisma': 'generator client {}\nmodel User {\n  id Int @id\n}\nmodel Post {\n  id Int @id\n}\n',
    });
    expect(entitySourceCount([prismaRule('prisma/schema.prisma')], ['src/**'], root, 999)).toBe(2);
  });

  it('trusts a declared source even when the count is 0 (does NOT fall back)', () => {
    const root = fixture({ 'prisma/schema.prisma': 'generator client {}\n' });
    expect(entitySourceCount([prismaRule('prisma/schema.prisma')], ['src/**'], root, 999)).toBe(0);
  });

  it('falls back to the broad count when the profile declares no entity source', () => {
    const root = fixture({ 'src/x.ts': 'export const x = 1;\n' });
    expect(entitySourceCount(undefined, ['src/**'], root, 42)).toBe(42);
    expect(entitySourceCount([], ['src/**'], root, 42)).toBe(42);
  });
});

describe('pre-scan entity fallback', () => {
  it('requires ORM decorator-call syntax instead of matching @modelcontextprotocol package names', () => {
    const root = fixture({
      'src/entity.ts': '@Entity()\nexport class User {}\n',
      'src/mcp.ts': "import { Server } from '@modelcontextprotocol/sdk/server/index.js';\n",
    });
    const script = fileURLToPath(new URL('../scripts/pre-scan.mjs', import.meta.url));
    const output = JSON.parse(
      execFileSync(process.execPath, [script, root, join(root, 'missing-output.json')], { encoding: 'utf8' }),
    ) as { source: { entityFiles: number } };

    expect(output.source.entityFiles).toBe(1);
  });
});

describe('externalCallsSourceCount', () => {
  it('counts call sites of manifest-declared HTTP-client deps (axios)', () => {
    const root = fixture({
      'package.json': JSON.stringify({ dependencies: { axios: '^1.6.0' } }),
      'src/svc.ts':
        "import axios from 'axios';\n" +
        "export async function f() {\n  await axios.get('/a');\n  await axios.post('/b', {});\n  return axios.create({});\n}\n",
    });
    // 3 axios call-site lines; the import line must NOT be counted.
    expect(externalCallsSourceCount(['src/**'], root)).toBe(3);
  });

  it('counts constructed *Api/*Client client sites even with no HTTP dep', () => {
    const root = fixture({
      'package.json': JSON.stringify({ dependencies: {} }),
      'src/clients.ts': 'const a = new UsersApi(url);\nconst b = new BillingClient(url);\nconst c = new Foo(url);\n',
    });
    expect(externalCallsSourceCount(['src/**'], root)).toBe(2);
  });

  it('returns undefined when no HTTP dep is present and no constructed client is found', () => {
    const root = fixture({
      'package.json': JSON.stringify({ dependencies: { react: '^18.0.0' } }),
      'src/x.ts': 'export const x = 1;\n',
    });
    expect(externalCallsSourceCount(['src/**'], root)).toBeUndefined();
  });

  it('dedupes overlapping dep patterns hitting the same line (node-fetch vs undici)', () => {
    const root = fixture({
      'package.json': JSON.stringify({ dependencies: { 'node-fetch': '^3.0.0', undici: '^6.0.0' } }),
      // Line 1 matches BOTH `fetch(` (node-fetch) and `request(|fetch(` (undici) — one call site.
      'src/egress.ts': "await fetch('/x');\nawait request('/y');\n",
    });
    expect(externalCallsSourceCount(['src/**'], root)).toBe(2);
  });

  it('counts egress in .tsx/.jsx files (frontend components)', () => {
    const root = fixture({
      'package.json': JSON.stringify({ dependencies: { axios: '^1.6.0' } }),
      'src/App.tsx': "await axios.get('/x');\n",
      'src/Legacy.jsx': "await axios.post('/y', {});\n",
    });
    expect(externalCallsSourceCount(['src/**'], root)).toBe(2);
  });

  it('names the manifest file when package.json is malformed (fail-fast, actionable)', () => {
    const root = fixture({
      'package.json': '{ not json',
      'src/x.ts': 'export const x = 1;\n',
    });
    expect(() => externalCallsSourceCount(['src/**'], root)).toThrow(/Cannot parse .*package\.json/);
  });

  it('excludes infra/storage constructors (PrismaClient) but keeps real API clients', () => {
    const root = fixture({
      'package.json': JSON.stringify({ dependencies: {} }),
      'src/clients.ts':
        'const db = new PrismaClient();\nconst s3 = new S3Client({});\nconst api = new UsersApi(url);\n',
    });
    // Only `new UsersApi(` is HTTP egress a profile can emit.
    expect(externalCallsSourceCount(['src/**'], root)).toBe(1);
  });

  it('stays undefined when the only constructed clients are infra/storage constructors', () => {
    const root = fixture({
      'package.json': JSON.stringify({ dependencies: {} }),
      'src/db.ts': 'const db = new PrismaClient();\n',
    });
    expect(externalCallsSourceCount(['src/**'], root)).toBeUndefined();
  });

  it('does not count duplicate clients inside a local .worktrees checkout', () => {
    const root = fixture({
      'package.json': JSON.stringify({ dependencies: {} }),
      'src/x.ts': 'export const x = 1;\n',
      '.worktrees/feature/src/client.ts': 'const api = new BillingClient(url);\n',
    });
    expect(externalCallsSourceCount(['**/*.ts'], root)).toBeUndefined();
  });

  it('aggregates HTTP deps from per-package manifests under the include roots (monorepo)', () => {
    const root = fixture({
      // Root manifest has NO HTTP deps — the workspace package declares them.
      'package.json': JSON.stringify({ dependencies: {} }),
      'packages/api/package.json': JSON.stringify({ dependencies: { axios: '^1.6.0' } }),
      'packages/api/src/svc.ts': "await axios.get('/a');\nawait axios.post('/b', {});\n",
    });
    expect(externalCallsSourceCount(['packages/**'], root)).toBe(2);
  });

  it('names the offending per-package manifest when it is malformed', () => {
    const root = fixture({
      'package.json': JSON.stringify({ dependencies: {} }),
      'packages/api/package.json': '{ not json',
      'packages/api/src/x.ts': 'export const x = 1;\n',
    });
    expect(() => externalCallsSourceCount(['packages/**'], root)).toThrow(
      /Cannot parse .*packages[/\\]api[/\\]package\.json/,
    );
  });
});

const tsProfile = (over: Partial<ExtractionProfile> = {}): ExtractionProfile =>
  ({
    parserId: 'x',
    substrate: { language: 'ts', include: ['src/**/*.ts'] },
    ...over,
  }) as ExtractionProfile;

const queueDecoratorRule = [
  { kind: 'queue', detect: { via: 'method-decorator', names: { EventPattern: 'event' } } },
] as unknown as ExtractionProfile['entrypoints'];

const queueCallShapeRule = [
  {
    kind: 'queue',
    detect: { via: 'call-shape', callee: '*.subscribe' },
    system: 'realtime',
    topic: { arg: 0, as: 'string-literal' },
    handler: { arg: 1 },
  },
] as ExtractionProfile['entrypoints'];

describe('queueSourceCount', () => {
  it('returns 0 (not_applicable) for a frontend with no queue rule, even with .subscribe( noise', () => {
    const root = fixture({
      'src/store.ts': 'store.subscribe(listener);\nconst s = store.subscribeWithSelector(sel);\n',
    });
    expect(queueSourceCount(tsProfile({ repoType: 'frontend' }), root)).toBe(0);
  });

  it('keeps the precise decorator path for a frontend that declares a queue rule', () => {
    const root = fixture({
      'src/consumer.ts': "@EventPattern('t')\nhandleT() {}\n@EventPattern('u')\nhandleU() {}\n",
    });
    expect(queueSourceCount(tsProfile({ repoType: 'frontend', entrypoints: queueDecoratorRule }), root)).toBe(2);
  });

  it('returns 0 for monorepo realtime/store subscriptions when no queue convention is declared', () => {
    const root = fixture({
      'src/realtime.ts': 'channel.subscribe(onStatus);\nstore.subscribe(listener);\n',
    });
    expect(queueSourceCount(tsProfile({ repoType: 'monorepo' }), root)).toBe(0);
  });

  it('detects KafkaJS subscriptions only on receivers created by kafka.consumer', () => {
    const root = fixture({
      'package.json': JSON.stringify({ dependencies: { kafkajs: '^2.2.4' } }),
      'src/consumer.ts':
        "import { Kafka } from 'kafkajs';\n" +
        "const kafka = new Kafka({ clientId: 'worker', brokers: [] });\n" +
        "const ordersConsumer = kafka.consumer({ groupId: 'orders' });\n" +
        "await ordersConsumer.subscribe({ topic: 'created' });\n" +
        "await ordersConsumer.subscribe({ topic: 'cancelled' });\n" +
        'store.subscribe(listener);\n',
    });

    expect(queueSourceCount(tsProfile({ repoType: 'monorepo' }), root)).toBe(2);
  });

  it('detects NATS subscriptions only on receivers backed by a NATS connection', () => {
    const root = fixture({
      'package.json': JSON.stringify({ dependencies: { nats: '^2.29.0' } }),
      'src/consumer.ts':
        "import { connect } from 'nats';\n" +
        "const nc = await connect({ servers: 'nats://localhost:4222' });\n" +
        'const js = nc.jetstream();\n' +
        "const orders = nc.subscribe('orders.created');\n" +
        "const durable = js.subscribe('orders.cancelled');\n" +
        'store.subscribe(listener);\n',
    });

    expect(queueSourceCount(tsProfile({ repoType: 'monorepo' }), root)).toBe(2);
  });

  it('detects Redis pub/sub only on imported or duplicated Redis receivers', () => {
    const root = fixture({
      'package.json': JSON.stringify({ dependencies: { redis: '^4.7.0' } }),
      'src/consumer.ts':
        "import { createClient } from 'redis';\n" +
        'const client = createClient();\n' +
        'const subscriber = client.duplicate();\n' +
        "await subscriber.subscribe('orders', onOrder);\n" +
        'store.subscribe(listener);\n',
    });

    expect(queueSourceCount(tsProfile({ repoType: 'monorepo' }), root)).toBe(1);
  });

  it('detects an ioredis subscriber constructed through the common IORedis alias', () => {
    const root = fixture({
      'package.json': JSON.stringify({ dependencies: { ioredis: '^5.4.0' } }),
      'src/consumer.ts':
        "import IORedis from 'ioredis';\n" +
        'const subscriber: IORedis = new IORedis();\n' +
        "await subscriber.subscribe('orders');\n" +
        'store.subscribe(listener);\n',
    });

    expect(queueSourceCount(tsProfile({ repoType: 'monorepo' }), root)).toBe(1);
  });

  it('does not treat consumer-shaped subscriptions as queue evidence without a messaging dependency', () => {
    const root = fixture({
      'package.json': JSON.stringify({ dependencies: { '@supabase/supabase-js': '^2.0.0' } }),
      'src/realtime.ts':
        "const consumer = channel.consumer({ groupId: 'room' });\n" +
        "consumer.subscribe({ topic: 'presence' });\n" +
        'store.subscribe(listener);\n',
    });

    expect(queueSourceCount(tsProfile({ repoType: 'monorepo' }), root)).toBe(0);
  });

  it('finds messaging dependencies declared by an included workspace package', () => {
    const root = fixture({
      'package.json': JSON.stringify({ dependencies: {} }),
      'packages/worker/package.json': JSON.stringify({ dependencies: { kafkajs: '^2.2.4' } }),
      'packages/worker/src/consumer.ts':
        "const consumer = kafka.consumer({ groupId: 'orders' });\n" +
        "await consumer.subscribe({ topic: 'created' });\n",
    });

    expect(
      queueSourceCount(
        tsProfile({ repoType: 'monorepo', substrate: { language: 'ts', include: ['packages/**'] } }),
        root,
      ),
    ).toBe(1);
  });

  it('does not count queue markers inside a local .worktrees checkout', () => {
    const root = fixture({
      'src/x.ts': 'export const x = 1;\n',
      '.worktrees/feature/src/consumer.ts': "@EventPattern('topic')\nhandle() {}\n",
    });
    expect(
      queueSourceCount(tsProfile({ repoType: 'monorepo', substrate: { language: 'ts', include: ['**/*.ts'] } }), root),
    ).toBe(0);
  });

  it('counts a declared call-shape queue convention precisely', () => {
    const root = fixture({
      'src/realtime.ts': "channel.subscribe('room:1', onMessage);\nchannel.subscribe('room:2', onMessage);\n",
    });
    expect(queueSourceCount(tsProfile({ repoType: 'monorepo', entrypoints: queueCallShapeRule }), root)).toBe(2);
  });

  it('backend fallback counts evidence-rich queue shapes within include roots, ignoring subscription noise', () => {
    const root = fixture({
      'src/kafka.ts':
        "@EventPattern('t')\nonMsg() {}\nclient.send('x').subscribe((r) => {});\nconst c = new Consumer({});\n",
      // Bare-word decoys the OLD pattern counted — must NOT match the shape-based pattern.
      'src/decoys.ts':
        'const s = store.subscribeWithSelector(sel);\n// the Consumer of this API\nclass KafkaConsumer {}\nconst consumerGroup = 1;\n',
      // Outside the profile's include roots — must NOT be scanned.
      'scripts/consume.ts': "@EventPattern('t')\nx.subscribe(cb);\n",
    });
    expect(queueSourceCount(tsProfile({ repoType: 'backend' }), root)).toBe(2);
  });

  it('skips tracked source files deleted from the worktree before invoking grep', () => {
    const root = fixture({
      'src/live.ts': "@EventPattern('live')\nhandle() {}\n",
      'src/deleted.ts': "@EventPattern('deleted')\nhandle() {}\n",
    });
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['add', 'src/live.ts', 'src/deleted.ts'], { cwd: root, stdio: 'ignore' });
    rmSync(join(root, 'src/deleted.ts'));

    expect(queueSourceCount(tsProfile({ repoType: 'backend' }), root)).toBe(1);
  });
});

const parsedWithOps = (entityNames: string[]): ParsedRepo =>
  ({ dbOperations: entityNames.map((entityName) => ({ entityName })) }) as unknown as ParsedRepo;

describe('operatedEntityCount', () => {
  it('counts DISTINCT operated entities, excluding the unknown/transaction sentinels', () => {
    expect(operatedEntityCount(parsedWithOps(['User', 'User', 'Team', 'unknown', 'transaction']))).toBe(2);
  });

  it('is 0 when the repo has no dbOperations', () => {
    expect(operatedEntityCount({} as unknown as ParsedRepo)).toBe(0);
  });
});

describe('tsSourceSignals — cluster-report hit lists', () => {
  it('exposes repo-relative {file, line, text} hit lists for http, queue, and externalCalls', () => {
    const root = fixture({
      'package.json': JSON.stringify({ dependencies: { axios: '^1.6.0' } }),
      'src/api.ts': "router.get('/a', h);\n",
      'src/consumer.ts': "@EventPattern('t')\nonT() {}\n",
      'src/egress.ts': "await axios.get('/x');\n",
    });
    const signals = tsSourceSignals({
      repoRoot: root,
      outPath: join(root, 'out.json'),
      parsed: {} as unknown as ParsedRepo,
      profile: tsProfile({ entrypoints: queueDecoratorRule }),
      sourceFiles: ['src/api.ts', 'src/consumer.ts', 'src/egress.ts'],
    });
    expect(signals.hits?.http).toEqual([{ file: 'src/api.ts', line: 1, text: "router.get('/a', h);" }]);
    expect(signals.hits?.queue).toEqual([{ file: 'src/consumer.ts', line: 1, text: "@EventPattern('t')" }]);
    expect(signals.hits?.externalCalls).toEqual([{ file: 'src/egress.ts', line: 1, text: "await axios.get('/x');" }]);
    // The counts stay derived from the same greps as the hit lists.
    expect(signals.queue).toBe(1);
    expect(signals.externalCalls).toBe(1);
  });

  it('omits the externalCalls hit list when the category has no signal (undefined count)', () => {
    const root = fixture({
      'package.json': JSON.stringify({ dependencies: {} }),
      'src/x.ts': 'export const x = 1;\n',
    });
    const signals = tsSourceSignals({
      repoRoot: root,
      outPath: join(root, 'out.json'),
      parsed: {} as unknown as ParsedRepo,
      profile: tsProfile(),
      sourceFiles: ['src/x.ts'],
    });
    expect(signals.externalCalls).toBeUndefined();
    expect(signals.hits?.externalCalls).toBeUndefined();
  });

  it('keeps the scoped TS entity fallback when no entity rule is declared', () => {
    const root = fixture({
      'src/model.ts': '@Entity()\nexport class User {}\n',
      'other/model.py': '@model\nclass Other: pass\n',
    });
    const signals = tsSourceSignals({
      repoRoot: root,
      outPath: join(root, 'out.json'),
      parsed: {} as unknown as ParsedRepo,
      profile: tsProfile(),
      sourceFiles: ['src/model.ts'],
    });
    expect(signals.entities).toBe(1);
  });

  it('does not mistake @modelcontextprotocol imports for ORM entity decorators', () => {
    const root = fixture({
      'src/mcp.ts': "import { Server } from '@modelcontextprotocol/sdk/server/index.js';\n",
    });
    const signals = tsSourceSignals({
      repoRoot: root,
      outPath: join(root, 'out.json'),
      parsed: {} as unknown as ParsedRepo,
      profile: tsProfile(),
      sourceFiles: ['src/mcp.ts'],
    });
    expect(signals.entities).toBe(0);
  });

  it('scopes pre-scan HTTP hits and its denominator to the TS target', () => {
    const root = fixture({
      'src/api.ts': "router.get('/a', h);\n",
      // Both paths are visible to the standalone cross-language pre-scan, but
      // neither belongs to this TS target's exact source scope.
      'app/legacy.ts': "router.get('/legacy', h);\n",
      'service/main.go': 'http.HandleFunc("/go", handler)\n',
    });
    const signals = tsSourceSignals({
      repoRoot: root,
      outPath: join(root, 'out.json'),
      parsed: {} as unknown as ParsedRepo,
      profile: tsProfile(),
      sourceFiles: ['src/api.ts'],
    });
    expect(signals.http).toBe(1);
    expect(signals.hits?.http).toEqual([{ file: 'src/api.ts', line: 1, text: "router.get('/a', h);" }]);
  });

  it('does not mix sibling package HTTP sites into a monorepo target denominator', () => {
    const root = fixture({
      'apps/web/src/api.ts': "router.get('/web', h);\n",
      'apps/api/src/api.ts': "router.get('/api', h);\n",
    });
    const signals = tsSourceSignals({
      repoRoot: root,
      outPath: join(root, 'out.json'),
      parsed: {} as unknown as ParsedRepo,
      profile: tsProfile({ substrate: { language: 'ts', include: ['apps/web/src/**/*.ts'] } }),
      sourceFiles: ['apps/web/src/api.ts'],
    });
    expect(signals.http).toBe(1);
    expect(signals.hits?.http?.map((hit) => hit.file)).toEqual(['apps/web/src/api.ts']);
  });

  it('counts module-flavoured TS/JS extensions inside the target scope', () => {
    const root = fixture({
      'src/api.mjs': "router.get('/mjs', h);\n",
      'src/api.mts': "router.get('/mts', h);\n",
      'src/api.cts': "router.get('/cts', h);\n",
    });
    const signals = tsSourceSignals({
      repoRoot: root,
      outPath: join(root, 'out.json'),
      parsed: {} as unknown as ParsedRepo,
      profile: tsProfile({ substrate: { language: 'ts', include: ['src/**/*.{mjs,mts,cts}'] } }),
      sourceFiles: ['src/api.cts', 'src/api.mjs', 'src/api.mts'],
    });
    expect(signals.http).toBe(3);
  });

  it('counts HTTP and egress signals in Vue SFCs claimed by the TS provider', () => {
    const root = fixture({
      'package.json': JSON.stringify({ dependencies: { axios: '^1.6.0' } }),
      'src/App.vue':
        '<script setup lang="ts">\n' +
        "router.get('/vue', handler);\n" +
        "await axios.get('/upstream');\n" +
        '</script>\n',
    });
    const signals = tsSourceSignals({
      repoRoot: root,
      outPath: join(root, 'out.json'),
      parsed: {} as unknown as ParsedRepo,
      profile: tsProfile({ substrate: { language: 'ts', include: ['src/**/*.vue'] } }),
      sourceFiles: ['src/App.vue'],
    });

    expect(signals.http).toBe(1);
    expect(signals.externalCalls).toBe(1);
    expect(signals.hits?.http?.map((hit) => hit.file)).toEqual(['src/App.vue']);
    expect(signals.hits?.externalCalls?.map((hit) => hit.file)).toEqual(['src/App.vue']);
  });

  it('applies the provider-selected source set to every TS source-signal denominator', () => {
    const signalSource =
      "router.get('/live', h);\n" +
      "@EventPattern('events')\n" +
      '@Entity()\n' +
      'class User {}\n' +
      "await axios.get('/upstream');\n" +
      "@GrpcMethod('Users', 'Find')\n" +
      "@Query('user')\n" +
      "program.command('serve');\n";
    const root = fixture({
      'package.json': JSON.stringify({ dependencies: { axios: '^1.6.0' } }),
      'src/live.ts': signalSource,
      'src/unselected.ts': signalSource,
      'src/generated/hidden.ts': signalSource,
      'src/not-included.js': signalSource,
    });
    const profile = tsProfile({
      substrate: {
        language: 'ts',
        include: ['src/**/*.ts'],
        exclude: ['src/generated/**'],
      },
      entities: [classDecoratorRule('Entity')],
      entrypoints: [
        ...(queueDecoratorRule ?? []),
        {
          kind: 'grpc',
          detect: { via: 'method-decorator', names: { GrpcMethod: 'unary' } },
          service: { arg: 0, as: 'string-literal' },
          method: { arg: 1, as: 'string-literal' },
        },
        {
          kind: 'graphql',
          detect: { via: 'class-decorator', name: 'Resolver' },
          operation: { Query: 'query' },
        },
        {
          kind: 'cli',
          detect: { via: 'call-shape', callee: '*.command' },
          command: { arg: 0, as: 'string-literal' },
          action: { call: 'action', arg: 0 },
        },
      ] as ExtractionProfile['entrypoints'],
    });

    const signals = tsSourceSignals({
      repoRoot: root,
      outPath: join(root, 'out.json'),
      parsed: {} as unknown as ParsedRepo,
      profile,
      sourceFiles: ['src/live.ts'],
    });

    expect({
      http: signals.http,
      queue: signals.queue,
      entities: signals.entities,
      externalCalls: signals.externalCalls,
      grpc: signals.grpc,
      graphql: signals.graphql,
      cli: signals.cli,
    }).toEqual({ http: 1, queue: 1, entities: 1, externalCalls: 1, grpc: 1, graphql: 1, cli: 1 });
    expect(signals.hits?.queue?.map((hit) => hit.file)).toEqual(['src/live.ts']);
    expect(signals.hits?.externalCalls?.map((hit) => hit.file)).toEqual(['src/live.ts']);
  });
});

describe('emittedLocationsFromRepo', () => {
  const loc = (n: number) => ({ filePath: `src/f${n}.ts`, startLine: n, endLine: n });

  it("maps each cluster-report category to its nodes' locations", () => {
    const parsed = {
      entrypoints: [
        { type: 'http', location: loc(1) },
        { type: 'queue', location: loc(2) },
        // Not a cluster-report category — must not leak into http/queue.
        { type: 'event', location: loc(3) },
      ],
      dbOperations: [{ location: loc(4) }, { location: loc(5) }],
      externalCalls: [{ location: loc(6) }],
    } as unknown as ParsedRepo;

    expect(emittedLocationsFromRepo(parsed)).toEqual({
      http: [loc(1)],
      queue: [loc(2)],
      dbOperations: [loc(4), loc(5)],
      externalCalls: [loc(6)],
    });
  });

  it('returns empty lists for an empty ParsedRepo', () => {
    expect(emittedLocationsFromRepo({} as unknown as ParsedRepo)).toEqual({
      http: [],
      queue: [],
      dbOperations: [],
      externalCalls: [],
    });
  });
});

describe('tsSourceSignals — schemaMirror wiring (evidence-gated)', () => {
  const baseFor = (root: string) => ({
    repoRoot: root,
    outPath: join(root, 'out.json'),
    parsed: parsedWithOps(['User', 'Team', 'unknown']),
    sourceFiles: ['src/x.ts'],
  });

  it('supplies the operated-entity denominator when schemaMirror is set WITH generator evidence', () => {
    const root = fixture({
      'package.json': JSON.stringify({ devDependencies: { '@mikro-orm/entity-generator': '^6.0.0' } }),
      'src/x.ts': 'export const x = 1;\n',
    });
    const signals = tsSourceSignals({ ...baseFor(root), profile: tsProfile({ schemaMirror: true }) });
    expect(signals.dbOperations).toBe(2);
    expect(signals.dbOperationsNote).toBeUndefined();
  });

  it('accepts evidence from `dependencies` too (union with devDependencies)', () => {
    const root = fixture({
      'package.json': JSON.stringify({ dependencies: { 'sequelize-auto': '^0.8.8' } }),
      'src/x.ts': 'export const x = 1;\n',
    });
    expect(tsSourceSignals({ ...baseFor(root), profile: tsProfile({ schemaMirror: true }) }).dbOperations).toBe(2);
  });

  it('ignores schemaMirror WITHOUT evidence: all-entities basis + an "ignored" note', () => {
    const root = fixture({
      'package.json': JSON.stringify({ dependencies: { '@mikro-orm/core': '^6.0.0' } }),
      'src/x.ts': 'export const x = 1;\n',
    });
    const signals = tsSourceSignals({ ...baseFor(root), profile: tsProfile({ schemaMirror: true }) });
    expect(signals.dbOperations).toBeUndefined();
    expect(signals.dbOperationsNote).toBe('schemaMirror ignored (no entity-generator dependency found)');
  });

  it('supplies neither denominator nor note when schemaMirror is unset', () => {
    const root = fixture({ 'src/x.ts': 'export const x = 1;\n' });
    const signals = tsSourceSignals({ ...baseFor(root), profile: tsProfile() });
    expect(signals.dbOperations).toBeUndefined();
    expect(signals.dbOperationsNote).toBeUndefined();
  });
});
