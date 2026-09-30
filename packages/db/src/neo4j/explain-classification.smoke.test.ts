import { afterAll, describe, expect, it } from 'vitest';
import { Neo4jDriver } from './driver.js';
import { Neo4jRepository } from './repository.js';

/**
 * Real-Neo4j smoke test for the read-only Cypher boundary (allowlist +
 * EXPLAIN classification). Env-gated: runs only when NEO4J_URI is set, so it is
 * inert in the default unit-test run. Target the seeded container:
 *
 *   NEO4J_URI=bolt://localhost:7687 NEO4J_USER=neo4j NEO4J_PASSWORD='asd123A!' \
 *     pnpm --filter @coredoc/db test
 *
 * It proves, against a live instance, that a real write is blocked BEFORE
 * execution (no node is created) and a real read classifies read-only and
 * returns.
 */
const GATED = !process.env.NEO4J_URI;

describe.skipIf(GATED)('Neo4jRepository — real-instance read-only boundary (smoke)', () => {
  const driver = new Neo4jDriver();
  const repo = new Neo4jRepository(driver);

  afterAll(async () => {
    await driver.close();
  });

  const countTmp = async (): Promise<number> => {
    const res = await repo.runReadOnlyCypherRows('MATCH (n:Tmp) RETURN count(n) AS c', { limit: 1 });
    const cell = res.rows[0]?.[0];
    return typeof cell === 'number' ? cell : Number(cell ?? 0);
  };

  it('allowlist guard blocks a real write before execution and creates no node', async () => {
    // This exercises the ALLOWLIST (gate a), which rejects CREATE before it ever
    // reaches EXPLAIN — it proves the guard, NOT the classification backstop.
    // The EXPLAIN backstop itself is exercised by the guard-bypassed test below.
    const before = await countTmp();

    await expect(repo.runReadOnlyCypherRows('CREATE (n:Tmp) RETURN n', { limit: 1 })).rejects.toThrow(/read-only/i);

    const after = await countTmp();
    expect(after).toBe(before);
  });

  it('classifies a real read as read-only and returns rows', async () => {
    const res = await repo.runReadOnlyCypherRows('MATCH (n) RETURN count(n) AS c LIMIT 1', { limit: 1 });
    expect(res.columns).toEqual(['c']);
    expect(res.rows).toHaveLength(1);
    expect(typeof res.rows[0]![0]).toBe('number');
  });

  it('EXPLAIN backstop (guard bypassed): a real write classifies non-"r" and blocks, no node created', async () => {
    const before = await countTmp();

    // Reach the private classification directly to prove the EXPLAIN backstop
    // itself — not just the allowlist that normally rejects CREATE first.
    // EXPLAIN plans without executing, so no node is created either way.
    const classify = (
      repo as unknown as {
        runClassifiedNeoRead: (q: string, p: Record<string, unknown>) => Promise<unknown>;
      }
    ).runClassifiedNeoRead.bind(repo);

    await expect(classify('CREATE (n:Tmp) RETURN n', {})).rejects.toThrow(/read-only|classified/i);

    const after = await countTmp();
    expect(after).toBe(before);
  });
});
