import { describe, it, expect } from 'vitest';
import { StableIdGenerator } from './id-generator.js';

/**
 * Regression: entrypoint IDs are scoped by their owning file.
 *
 * Two handlers exposing the SAME type-identifier from DIFFERENT files (the
 * multi-target monorepo case — e.g. a ts frontend and a ruby backend target
 * both serving `GET /health`, or two packages each registering CLI `sync`)
 * must produce DISTINCT node IDs. Before this scoping, their content-only IDs
 * collided and the `INSERT OR REPLACE INTO nodes` sink silently dropped one
 * handler + its `handles` edge during a merged-repo push.
 */
describe('entrypoint ID file-scoping', () => {
  const g = new StableIdGenerator('/repo', 'repo-key');

  it('gives the same http route in different files distinct IDs', () => {
    const a = g.httpEntrypointId('GET', '/health', 'ui/server.ts');
    const b = g.httpEntrypointId('GET', '/health', 'api/app.rb');
    expect(a).not.toBe(b);
  });

  it('is stable for the same route in the same file', () => {
    expect(g.httpEntrypointId('GET', '/health', 'ui/server.ts')).toBe(
      g.httpEntrypointId('GET', '/health', 'ui/server.ts'),
    );
  });

  it('scopes cli, grpc, graphql, and queue entrypoints by file too', () => {
    expect(g.entrypointId('cli', 'sync', 'pkg-a/cli.ts')).not.toBe(g.entrypointId('cli', 'sync', 'pkg-b/cli.ts'));
    expect(g.grpcEntrypointId('Svc', 'Ping', 'a.ts')).not.toBe(g.grpcEntrypointId('Svc', 'Ping', 'b.ts'));
    expect(g.graphqlEntrypointId('Query', 'users', 'a.ts')).not.toBe(g.graphqlEntrypointId('Query', 'users', 'b.ts'));
    expect(g.queueEntrypointId('kafka', 'orders', 'a.ts')).not.toBe(g.queueEntrypointId('kafka', 'orders', 'b.ts'));
  });

  it('keeps the repoHash:entrypoint:<type> prefix shape intact', () => {
    expect(g.httpEntrypointId('GET', '/health', 'ui/server.ts')).toMatch(/^[a-f0-9]{12}:entrypoint:http:/);
  });
});
