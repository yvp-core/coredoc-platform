import { describe, it, expect, vi } from 'vitest';

/**
 * Optional-dependency isolation guard.
 *
 * `neo4j-driver` is an OPTIONAL dependency: the default backend is SQLite and the
 * package must load without neo4j-driver installed (the packaged desktop app, a
 * CLI install that never touches the Neo4j backend). `@coredoc/db`'s index
 * statically re-exports this module, so it is evaluated at startup in every
 * consumer.
 *
 * Regression: a top-level `import { int } from 'neo4j-driver'` here made merely
 * importing `@coredoc/db` eagerly `require('neo4j-driver')`, crashing the
 * packaged desktop app at startup ("Cannot find module 'neo4j-driver'"). Guard
 * that the module still loads when neo4j-driver cannot be resolved.
 */
vi.mock('neo4j-driver', () => {
  throw new Error("Cannot find module 'neo4j-driver' (simulated: optional dep not installed)");
});

describe('neo4j driver module — optional-dependency isolation', () => {
  it('loads without eagerly requiring neo4j-driver', async () => {
    const mod = await import('./driver.js');
    expect(typeof mod.Neo4jDriver).toBe('function');
    expect(typeof mod.toInt).toBe('function');
  });
});
