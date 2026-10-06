import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Neo4jDriver } from './driver.js';
import { Neo4jRepository } from './repository.js';

// Env-gated like explain-classification.smoke.test.ts: runs only when NEO4J_URI is set.
const GATED = !process.env.NEO4J_URI;
const HASH = 'ovrvwsmoke01';

describe.skipIf(GATED)('Neo4jRepository — getRepoOverview counts (smoke)', () => {
  const driver = new Neo4jDriver();
  const repo = new Neo4jRepository(driver);

  const cleanup = () =>
    driver.withWriteTransaction((tx) =>
      tx.run('MATCH (n) WHERE n.id STARTS WITH $hash DETACH DELETE n', { hash: HASH }),
    );

  beforeAll(async () => {
    await cleanup();
    await driver.withWriteTransaction((tx) =>
      tx.run(
        `CREATE (r:Repository:CodeNode {id: $hash, name: 'overview-smoke', type: 'backend'})
         CREATE (f:File:CodeNode {id: $hash + ':file:app/a.rb', name: 'a.rb'})
         CREATE (c:Class:CodeNode {id: $hash + ':class:app/a.rb:A', name: 'A'})
         CREATE (m:Function:CodeNode {id: $hash + ':method:app/a.rb:A.run', name: 'run'})
         CREATE (fn:Function:CodeNode {id: $hash + ':function:app/a.rb:helper', name: 'helper'})
         CREATE (r)-[:CONTAINS_FILE]->(f)
         CREATE (f)-[:CONTAINS_CLASS]->(c)
         CREATE (c)-[:HAS_METHOD]->(m)
         CREATE (f)-[:CONTAINS_FUNCTION]->(fn)`,
        { hash: HASH },
      ),
    );
  });

  afterAll(async () => {
    await cleanup();
    await driver.close();
  });

  it('counts class methods as functions, not only file-level functions', async () => {
    const [overview] = await repo.getRepoOverview([HASH]);
    expect(overview?.functionCount).toBe(2);
    expect(overview?.classCount).toBe(1);
    expect(overview?.fileCount).toBe(1);
  });
});
