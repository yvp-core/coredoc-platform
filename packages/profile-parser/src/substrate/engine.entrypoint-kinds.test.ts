/**
 * Acceptance for the cli / grpc / graphql entrypoint detectors: a profile declaring
 * each new kind, run over a small in-memory fixture through the full substrate
 * engine, emits entrypoints with the right `type`, a resolved `handlerId` (present in
 * repo.functions, like http), and the kind-specific `details`. Uses `runProfile`
 * (the real tree-sitter + SCIP path), the same harness as run.test.ts.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ParsedRepo } from '@coredoc/core/types';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExtractionProfile } from '../types.js';
import { runProfile } from './run.js';

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Write one fixture file + run a profile over the temp repo. */
async function run(file: string, source: string, entrypoints: ExtractionProfile['entrypoints']): Promise<ParsedRepo> {
  dir = mkdtempSync(join(tmpdir(), 'pp-ep-'));
  writeFileSync(join(dir, file), source);
  const profile: ExtractionProfile = {
    parserId: 'test-entrypoint-kinds',
    substrate: { language: 'ts', include: ['**/*.ts'], exclude: ['**/node_modules/**'] },
    entrypoints,
  };
  const { repo } = await runProfile(profile, dir, 'ep-test');
  return repo;
}

/** Every entrypoint's handlerId must name a real function node (handlerId integrity, like http). */
function assertHandlersResolve(repo: ParsedRepo): void {
  const fnIds = new Set(repo.functions.map((f) => f.id));
  for (const ep of repo.entrypoints) expect(fnIds.has(ep.handlerId)).toBe(true);
}

describe('cli entrypoints (commander fluent chain)', () => {
  const SRC = `import { program } from 'commander';

program
  .command('parse')
  .description('Parse repositories')
  .option('-c, --config <path>', 'config')
  .action(async (options) => {
    await runParse(options);
  });

program
  .command('sync-status <jobId>')
  .action(handleSyncStatus);
`;

  it('emits a cli entrypoint per command with a resolved handler', async () => {
    const repo = await run('cli.ts', SRC, [
      {
        kind: 'cli',
        detect: { via: 'call-shape', callee: '*.command' },
        command: { arg: 0, as: 'string-literal' },
        action: { call: 'action', arg: 0 },
      },
    ]);
    const cli = repo.entrypoints.filter((e) => e.type === 'cli');
    expect(cli.map((e) => (e.details.type === 'cli' ? e.details.command : '')).sort()).toEqual([
      'parse',
      'sync-status',
    ]);
    // The command name drops commander's arg placeholder (`sync-status <jobId>` → `sync-status`).
    assertHandlersResolve(repo);
  });

  it('qualifies subcommands with their group path so same-named commands do not collide', async () => {
    const GROUPED = `import { program } from 'commander';

program.command('push').action(pushAll);

const parserCmd = program.command('parser').description('Manage parser artifacts');
parserCmd.command('push').action(parserPush);

const profileCmd = program.command('profile');
profileCmd.command('push <file>').action(async (file) => {
  await profilePush(file);
});
`;
    const repo = await run('grouped.ts', GROUPED, [
      {
        kind: 'cli',
        detect: { via: 'call-shape', callee: '*.command' },
        command: { arg: 0, as: 'string-literal' },
        action: { call: 'action', arg: 0 },
      },
    ]);
    const cli = repo.entrypoints.filter((e) => e.type === 'cli');
    // Three distinct `push` commands survive: group registrations (no .action) are not
    // emitted themselves, but qualify their subcommands' command path and id.
    expect(cli.map((e) => (e.details.type === 'cli' ? e.details.command : '')).sort()).toEqual([
      'parser push',
      'profile push',
      'push',
    ]);
    expect(new Set(cli.map((e) => e.id)).size).toBe(3);
    assertHandlersResolve(repo);
  });
});

describe('http entrypoints — globalPrefix (NestJS setGlobalPrefix with exclude)', () => {
  const SRC = `import { Controller, Get, Post } from '@nestjs/common';

@Controller('workspaces')
export class WorkspacesController {
  @Get(':id')
  getOne(id: string) {
    return id;
  }
}

@Controller('.well-known')
export class DiscoveryController {
  @Get('oauth-authorization-server')
  metadata() {
    return {};
  }
}

@Controller()
export class OAuthController {
  @Post('token')
  token() {
    return {};
  }
}
`;

  it('prefixes fullPath, leaving exclude-matched routes at the root', async () => {
    const repo = await run('ctrl.ts', SRC, [
      {
        kind: 'http',
        detect: { via: 'class-decorator', name: 'Controller' },
        basePath: { arg: 0, as: 'string-literal' },
        method: { Get: 'GET', Post: 'POST' },
        methodPath: { arg: 0, as: 'string-literal' },
        paramSyntax: 'colon',
        globalPrefix: { path: '/api/v1', exclude: ['.well-known/*', 'token'] },
      },
    ]);
    const byPath = new Map(
      repo.entrypoints
        .filter((e) => e.type === 'http')
        .map((e) => [(e.details as { fullPath: string }).fullPath, e.details as { path: string }]),
    );
    // Prefixed: the ordinary API route.
    expect(byPath.has('/api/v1/workspaces/{id}')).toBe(true);
    // Excluded: wildcard tail and exact match are both served at the root.
    expect(byPath.has('/.well-known/oauth-authorization-server')).toBe(true);
    expect(byPath.has('/token')).toBe(true);
    // The controller-relative `path` stays unprefixed either way.
    expect(byPath.get('/api/v1/workspaces/{id}')?.path).toBe('/{id}');
    assertHandlersResolve(repo);
  });
});

describe('grpc entrypoints (@GrpcMethod method decorator)', () => {
  const SRC = `export class HeroesController {
  @GrpcMethod('HeroesService', 'FindOne')
  findOne(data: unknown) {
    return data;
  }

  @GrpcMethod('HeroesService')
  findMany(data: unknown) {
    return data;
  }
}
`;

  it('captures service + method (method falls back to the decorated method name)', async () => {
    const repo = await run('grpc.ts', SRC, [
      {
        kind: 'grpc',
        detect: { via: 'method-decorator', names: { GrpcMethod: 'unary' } },
        service: { arg: 0, as: 'string-literal' },
        method: { arg: 1, as: 'string-literal' },
      },
    ]);
    const grpc = repo.entrypoints.filter((e) => e.type === 'grpc');
    expect(grpc.length).toBe(2);

    const findOne = grpc.find((e) => e.details.type === 'grpc' && e.details.methodName === 'FindOne');
    expect(findOne?.details).toMatchObject({
      type: 'grpc',
      serviceName: 'HeroesService',
      methodName: 'FindOne',
      streaming: 'unary',
    });
    // arg-1 absent → method name falls back to the decorated method.
    const findMany = grpc.find((e) => e.details.type === 'grpc' && e.details.methodName === 'findMany');
    expect(findMany?.details).toMatchObject({ serviceName: 'HeroesService', methodName: 'findMany' });
    assertHandlersResolve(repo);
  });
});

describe('graphql entrypoints (@Resolver class + @Query/@Mutation fields)', () => {
  const SRC = `class Author {}

@Resolver(() => Author)
export class AuthorResolver {
  @Query(() => [Author], { name: 'authors' })
  getAuthors() {
    return [];
  }

  @Mutation(() => Author)
  createAuthor(input: unknown) {
    return input;
  }
}

@Resolver()
export class RootResolver {
  @Query()
  health() {
    return 'ok';
  }
}
`;

  it('captures operation type, field name (override + fallback), and parent type', async () => {
    const repo = await run('graphql.ts', SRC, [
      {
        kind: 'graphql',
        detect: { via: 'class-decorator', name: 'Resolver' },
        operation: { Query: 'query', Mutation: 'mutation', Subscription: 'subscription' },
        fieldName: { arg: 0, as: 'object-property', key: 'name' },
        parentType: { arg: 0, as: 'arrow-target' },
      },
    ]);
    const gql = repo.entrypoints.filter((e) => e.type === 'graphql');
    expect(gql.length).toBe(3);

    // Explicit field-name override + parent type from `@Resolver(() => Author)`.
    const authors = gql.find((e) => e.details.type === 'graphql' && e.details.fieldName === 'authors');
    expect(authors?.details).toMatchObject({
      type: 'graphql',
      operationType: 'query',
      fieldName: 'authors',
      parentType: 'Author',
    });
    // No name option → field name falls back to the method name.
    const createAuthor = gql.find((e) => e.details.type === 'graphql' && e.details.fieldName === 'createAuthor');
    expect(createAuthor?.details).toMatchObject({ operationType: 'mutation', parentType: 'Author' });
    // `@Resolver()` with no arg → parent type falls back to the root operation type.
    const health = gql.find((e) => e.details.type === 'graphql' && e.details.fieldName === 'health');
    expect(health?.details).toMatchObject({ operationType: 'query', parentType: 'Query' });
    assertHandlersResolve(repo);
  });
});
