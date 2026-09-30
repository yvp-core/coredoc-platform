import { type CliEntrypointDetails, StableIdGenerator } from '@coredoc/core';
import { describe, expect, it } from 'vitest';
import { indexPythonDefs } from './python-callgraph.js';
import { type PythonFile, parsePython } from './python-cst.js';
import { djangoCommandName } from './python-django-commands.js';
import { extractPythonEntrypoints } from './python-entrypoints.js';

const ID = new StableIdGenerator('/demo', 'demo');

async function file(relPath: string, source: string): Promise<PythonFile> {
  return { relPath, source, root: await parsePython(source) };
}

function cli(eps: ReturnType<typeof extractPythonEntrypoints>) {
  return eps.filter((e) => e.type === 'cli');
}

function commands(eps: ReturnType<typeof extractPythonEntrypoints>): string[] {
  return cli(eps)
    .map((e) => (e.details as CliEntrypointDetails).command)
    .sort();
}

const SYNC = `
from django.core.management.base import BaseCommand

class Command(BaseCommand):
    help = "Sync persons"

    def add_arguments(self, parser):
        parser.add_argument("--team-id")

    def handle(self, *args, **options):
        pass
`;

const HYPERCACHE_BASE = `
from django.core.management.base import BaseCommand

class BaseHyperCacheCommand(BaseCommand):
    def handle(self, *args, **options):
        pass
`;

const REFRESH = `
from posthog.management.commands._base_hypercache_command import BaseHyperCacheCommand

class Command(BaseHyperCacheCommand):
    pass
`;

const tree = (): Promise<PythonFile[]> =>
  Promise.all([
    file('posthog/__init__.py', ''),
    file('posthog/management/__init__.py', ''),
    file('posthog/management/commands/__init__.py', ''),
    file('posthog/management/commands/sync_persons_to_clickhouse.py', SYNC),
    file('posthog/management/commands/_base_hypercache_command.py', HYPERCACHE_BASE),
    file('posthog/management/commands/refresh_hypercache.py', REFRESH),
    file(
      'posthog/management/commands/test/test_sync.py',
      'class Command(BaseCommand):\n    def handle(self):\n        pass\n',
    ),
    file('posthog/api/thing.py', 'class Command:\n    def handle(self):\n        pass\n'),
  ]);

describe('djangoCommandName — the Django discovery convention', () => {
  it('accepts a module directly inside management/commands', () => {
    expect(djangoCommandName('posthog/management/commands/sync_persons.py')).toBe('sync_persons');
    expect(djangoCommandName('products/tasks/management/commands/run.py')).toBe('run');
  });

  it('rejects __init__, underscore-prefixed modules, and nested packages', () => {
    // Django's find_commands() skips packages and `_`-prefixed modules — they are shared bases
    // and helpers, not runnable commands.
    expect(djangoCommandName('posthog/management/commands/__init__.py')).toBeUndefined();
    expect(djangoCommandName('posthog/management/commands/_base.py')).toBeUndefined();
    expect(djangoCommandName('posthog/management/commands/test/test_sync.py')).toBeUndefined();
  });

  it('rejects a file outside a management/commands directory', () => {
    expect(djangoCommandName('posthog/api/commands/run.py')).toBeUndefined();
    expect(djangoCommandName('posthog/management/other.py')).toBeUndefined();
  });
});

describe('Django management commands → cli entrypoints (G5)', () => {
  it('emits one cli entrypoint per command module, named after the file', async () => {
    expect(commands(extractPythonEntrypoints(await tree(), ID, {}))).toEqual([
      'refresh_hypercache',
      'sync_persons_to_clickhouse',
    ]);
  });

  it('mints the id through the shared idGen and locates the Command class', async () => {
    const eps = extractPythonEntrypoints(await tree(), ID, {});
    const sync = cli(eps).find((e) => (e.details as CliEntrypointDetails).command === 'sync_persons_to_clickhouse');
    expect(sync?.id).toBe(
      ID.entrypointId('cli', 'sync_persons_to_clickhouse', 'posthog/management/commands/sync_persons_to_clickhouse.py'),
    );
    expect(sync?.location.filePath).toBe('posthog/management/commands/sync_persons_to_clickhouse.py');
  });

  it('wires the handler to Command.handle', async () => {
    const eps = extractPythonEntrypoints(await tree(), ID, {});
    const sync = cli(eps).find((e) => (e.details as CliEntrypointDetails).command === 'sync_persons_to_clickhouse');
    expect(sync?.handlerId).toBe(
      ID.methodId('posthog/management/commands/sync_persons_to_clickhouse.py', 'Command', 'handle'),
    );
  });

  it('follows a repo-declared base class for an inherited handle', async () => {
    const eps = extractPythonEntrypoints(await tree(), ID, {});
    const refresh = cli(eps).find((e) => (e.details as CliEntrypointDetails).command === 'refresh_hypercache');
    expect(refresh?.handlerId).toBe(
      ID.methodId('posthog/management/commands/_base_hypercache_command.py', 'BaseHyperCacheCommand', 'handle'),
    );
  });

  it('drops a Command with no resolvable handle rather than dangling the handlerId', async () => {
    const files = await Promise.all([
      file('app/management/commands/broken.py', 'class Command(SomeExternalBase):\n    pass\n'),
    ]);
    expect(cli(extractPythonEntrypoints(files, ID, {}))).toHaveLength(0);
  });

  it('emits only handlerIds that exist as FunctionNodes (the integrity validator contract)', async () => {
    const files = await tree();
    const known = new Set(indexPythonDefs(files, ID).byId.keys());
    const eps = cli(extractPythonEntrypoints(files, ID, {}));
    expect(eps.length).toBeGreaterThan(0);
    for (const ep of eps) expect(known.has(ep.handlerId)).toBe(true);
  });
});
