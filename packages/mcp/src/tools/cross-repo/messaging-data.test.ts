import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScopeContext } from '../../types.js';
import { createMockEntrypointInfo, createMockRepository } from '../../__tests__/fixtures/mock-repository.js';
import {
  collectMessagingGraph,
  displayMessagingSystem,
  messagingStalenessWarning,
  normalizeMessagingSystem,
  normalizeRequestedMessagingSystem,
  predatesMessagingSchema,
  resolveMessagingQueryHashes,
} from './messaging-data.js';

describe('messaging system normalization', () => {
  it('keeps the systemless sentinel internal and renders it as unknown', () => {
    expect(normalizeMessagingSystem(undefined)).toBe('');
    expect(displayMessagingSystem('')).toBe('unknown');
  });

  it('treats a blank requested filter as unfiltered, matching list_entrypoints', () => {
    expect(normalizeRequestedMessagingSystem('   ')).toBeUndefined();
    expect(normalizeRequestedMessagingSystem(' unknown ')).toBe('');
    expect(normalizeRequestedMessagingSystem(' Kafka ')).toBe('kafka');
  });
});

describe('resolveMessagingQueryHashes', () => {
  const hashes = ['repo-a', 'repo-b'];
  const scope: ScopeContext = {
    currentPath: '/workspace/repo-a',
    resolvedRepos: ['repo-a', 'repo-b'],
    repoHashes: hashes,
    crossRepoEnabled: true,
  };
  let savedScope: string | undefined;

  beforeEach(() => {
    savedScope = process.env.COREDOC_SCOPE;
    delete process.env.COREDOC_SCOPE;
  });

  afterEach(() => {
    if (savedScope === undefined) delete process.env.COREDOC_SCOPE;
    else process.env.COREDOC_SCOPE = savedScope;
  });

  it('uses the resolved scope when the caller supplied an explicit scope', () => {
    expect(resolveMessagingQueryHashes('repo-a', scope)).toEqual(hashes);
  });

  it('never widens past a host COREDOC_SCOPE binding', () => {
    process.env.COREDOC_SCOPE = 'project:workspace';
    expect(resolveMessagingQueryHashes(undefined, scope)).toEqual(hashes);
  });

  it('never widens past a cloud workspace boundary', () => {
    expect(resolveMessagingQueryHashes(undefined, { ...scope, origin: 'workspace' })).toEqual(hashes);
  });

  it('widens only a genuinely unbound local query to the whole graph', () => {
    expect(resolveMessagingQueryHashes(undefined, scope)).toEqual([]);
  });
});

describe('predatesMessagingSchema', () => {
  it('treats an absent or unparseable version as stale', () => {
    expect(predatesMessagingSchema(undefined)).toBe(true);
    expect(predatesMessagingSchema('')).toBe(true);
    expect(predatesMessagingSchema('not-a-version')).toBe(true);
  });

  it('flags snapshots older than the messaging schema', () => {
    expect(predatesMessagingSchema('1.0.0')).toBe(true);
    expect(predatesMessagingSchema('0.9.9')).toBe(true);
  });

  it('accepts the messaging schema and anything newer', () => {
    expect(predatesMessagingSchema('1.1.0')).toBe(false);
    expect(predatesMessagingSchema('1.2.0')).toBe(false);
    expect(predatesMessagingSchema('2.0.0')).toBe(false);
  });

  // Language providers suffix their version; only the semver core is comparable.
  it('compares the semver core, ignoring a provider suffix', () => {
    expect(predatesMessagingSchema('1.1.0-python')).toBe(false);
    expect(predatesMessagingSchema('1.0.0-python')).toBe(true);
    expect(predatesMessagingSchema('1.1.0-rust')).toBe(false);
  });
});

describe('messagingStalenessWarning', () => {
  it('says nothing when every repo is current', () => {
    expect(messagingStalenessWarning([])).toBeUndefined();
  });

  it('names the repos and tells the user what to run', () => {
    const one = messagingStalenessWarning(['acme-core']);
    expect(one).toContain('acme-core');
    expect(one).toContain('coredoc parse');
    expect(one).toContain('coredoc push');

    const many = messagingStalenessWarning(['acme-core', 'acme-shifts']);
    expect(many).toContain('acme-core, acme-shifts');
    expect(many).toContain('were');
  });
});

describe('collectMessagingGraph — stale snapshot exclusion', () => {
  const hashes = ['aaa', 'bbb'];

  // Staleness and hash→name attribution come from the SAME rows now
  // (getRepositoryNames carries parserVersion), so the fixture supplies one list.
  function repoWith(nameRows: unknown[], entrypoint: unknown, call: unknown) {
    return createMockRepository({
      getRepoOverview: vi.fn().mockRejectedValue(new Error('getRepoOverview must not be called by this join')),
      getRepositoryNames: vi.fn().mockResolvedValue(nameRows),
      listEntrypoints: vi.fn((params: { type?: string }) =>
        Promise.resolve(params.type === 'queue' ? [entrypoint] : []),
      ),
      getExternalCallsWithMessaging: vi.fn().mockResolvedValue([call]),
    });
  }

  it('drops both producers and consumers belonging to a stale repo', async () => {
    const repo = repoWith(
      [
        { hash: 'aaa', name: 'current-repo', parserVersion: '1.1.0' },
        { hash: 'bbb', name: 'stale-repo', parserVersion: '1.0.0' },
      ],
      createMockEntrypointInfo({
        id: 'bbb:entrypoint:q',
        type: 'queue',
        system: 'kafka',
        destination: 'orders',
        handlerName: 'consumeOrders',
      }),
      { id: 'bbb:external_call:1', callerName: 'publish', filePath: 'b.ts', startLine: 1, destination: 'orders' },
    );

    const graph = await collectMessagingGraph(repo, hashes);

    expect(graph.staleRepos).toEqual(['stale-repo']);
    expect(graph.producers).toEqual([]);
    expect(graph.consumers).toEqual([]);
  });

  it('keeps sites from a current repo', async () => {
    const repo = repoWith(
      [{ hash: 'aaa', name: 'current-repo', parserVersion: '1.1.0' }],
      createMockEntrypointInfo({
        id: 'aaa:entrypoint:q',
        type: 'queue',
        system: 'kafka',
        destination: 'orders',
        handlerName: 'consumeOrders',
      }),
      {
        id: 'aaa:external_call:1',
        callerName: 'publish',
        filePath: 'a.ts',
        startLine: 1,
        system: 'kafka',
        destination: 'orders',
      },
    );

    const graph = await collectMessagingGraph(repo, hashes);

    expect(graph.staleRepos).toEqual([]);
    expect(graph.producers.map((p) => p.repo)).toEqual(['current-repo']);
    expect(graph.consumers.map((c) => c.repo)).toEqual(['current-repo']);
  });

  // Only positive evidence excludes — a hash the repository query never returned
  // resolves to 'unknown', which is not in the stale set, so its sites survive
  // rather than being silently dropped on an unidentified repo.
  it('does not treat a repo with no repository row as stale', async () => {
    const repo = repoWith(
      [],
      createMockEntrypointInfo({
        id: 'aaa:entrypoint:q',
        type: 'queue',
        system: 'kafka',
        destination: 'orders',
        handlerName: 'consumeOrders',
      }),
      {
        id: 'aaa:external_call:1',
        callerName: 'publish',
        filePath: 'a.ts',
        startLine: 1,
        system: 'kafka',
        destination: 'orders',
      },
    );

    const graph = await collectMessagingGraph(repo, hashes);

    expect(graph.staleRepos).toEqual([]);
    expect(graph.producers).toHaveLength(1);
    expect(graph.consumers).toHaveLength(1);
  });
});
