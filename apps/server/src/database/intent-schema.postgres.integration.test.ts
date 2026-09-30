import 'dotenv/config';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPrismaAdapter } from './create-prisma-client.js';
import { PrismaClient } from '../generated/prisma/client.js';

/**
 * Constraint matrix for the cloud product-intent schema (spec §13).
 *
 * Everything asserted here is a DATABASE guarantee, not a service-layer
 * promise: cross-workspace links, broken attachment, a feature-attached item
 * pointing at the wrong domain, duplicate identities, and an unprovable repo
 * identity must all be rejected by Postgres itself.
 */
const TEST_DATABASE_URL = process.env.INTENT_SCHEMA_TEST_DATABASE_URL ?? '';
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;

/** The graph repo id: first 12 hex characters of the sha256 of the durable key. */
function graphHash(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

async function expectSqlState(operation: Promise<unknown>, state: string): Promise<void> {
  try {
    await operation;
  } catch (error) {
    const originalCode = (
      error as {
        meta?: { driverAdapterError?: { cause?: { originalCode?: string } } };
      }
    ).meta?.driverAdapterError?.cause?.originalCode;
    expect(originalCode).toBe(state);
    return;
  }
  throw new Error(`Expected PostgreSQL SQLSTATE ${state}`);
}

describe.skipIf(!TEST_DATABASE_URL)('intent schema constraints (PostgreSQL integration)', () => {
  let prisma: PrismaClient;
  let pool: ReturnType<typeof buildPrismaAdapter>;
  let previousDatabaseUrl: string | undefined;
  const workspaceIds: string[] = [];

  beforeAll(async () => {
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    const built = buildPrismaAdapter();
    pool = built;
    prisma = new PrismaClient({ adapter: built?.adapter } as never);
    await prisma.$connect();
  });

  afterAll(async () => {
    for (const workspaceId of workspaceIds.reverse()) {
      await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
    }
    await prisma.$disconnect();
    if (pool?.pool) await pool.pool.end();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  async function createWorkspace(suffix: string): Promise<string> {
    const workspace = await prisma.workspace.create({
      data: { name: `intent-${RUN}-${suffix}`, slug: `intent-${RUN}-${suffix}` },
    });
    workspaceIds.push(workspace.id);
    return workspace.id;
  }

  async function createDomain(workspaceId: string, id: string): Promise<string> {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "intent_domains"
         ("workspace_id", "id", "title", "statement", "created_by", "updated_by", "updated_at")
       VALUES ($1::uuid, $2, 'Domain', 'What this area is.', 'schema-test', 'schema-test', CURRENT_TIMESTAMP)`,
      workspaceId,
      id,
    );
    return id;
  }

  async function createFeature(workspaceId: string, id: string, domainId: string): Promise<string> {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "intent_features"
         ("workspace_id", "id", "domain_id", "title", "statement", "created_by", "updated_by", "updated_at")
       VALUES ($1::uuid, $2, $3, 'Feature', 'What this feature is.', 'schema-test', 'schema-test', CURRENT_TIMESTAMP)`,
      workspaceId,
      id,
      domainId,
    );
    return id;
  }

  function insertItem(
    workspaceId: string,
    id: string,
    options: {
      kind?: string;
      domainId?: string | null;
      featureId?: string | null;
      authority?: string;
      supersededById?: string | null;
      proposedSuccessorOfId?: string | null;
      version?: number;
    } = {},
  ): Promise<number> {
    return prisma.$executeRawUnsafe(
      `INSERT INTO "intent_items"
         ("workspace_id", "id", "domain_id", "feature_id", "kind", "title", "statement",
          "authority", "superseded_by_id", "proposed_successor_of_id", "version",
          "created_by", "updated_by", "updated_at")
       VALUES ($1::uuid, $2, $3, $4, $5::"IntentItemKind", 'Item', 'A bounded statement.',
               $6::"IntentItemAuthority", $7, $8, $9, 'schema-test', 'schema-test', CURRENT_TIMESTAMP)`,
      workspaceId,
      id,
      options.domainId ?? null,
      options.featureId ?? null,
      options.kind ?? 'business_rule',
      options.authority ?? 'candidate',
      options.supersededById ?? null,
      options.proposedSuccessorOfId ?? null,
      options.version ?? 1,
    );
  }

  it('makes a cross-workspace link unrepresentable at every level of the tree', async () => {
    const home = await createWorkspace('tenancy-home');
    const other = await createWorkspace('tenancy-other');
    const homeDomain = await createDomain(home, 'billing');
    const otherDomain = await createDomain(other, 'billing');
    const homeFeature = await createFeature(home, 'invoicing', homeDomain);
    await createFeature(other, 'invoicing', otherDomain);
    await insertItem(home, 'br-home-rule', { domainId: homeDomain });
    await insertItem(other, 'br-other-rule', { domainId: otherDomain });

    // A feature cannot adopt a domain that lives in another workspace.
    await expectSqlState(
      prisma.$executeRawUnsafe(
        `INSERT INTO "intent_features"
           ("workspace_id", "id", "domain_id", "title", "statement", "created_by", "updated_by", "updated_at")
         VALUES ($1::uuid, 'stolen', 'billing-elsewhere', 'F', 'S', 'schema-test', 'schema-test', CURRENT_TIMESTAMP)`,
        home,
      ),
      '23503',
    );

    // A seed cannot name a feature outside its own workspace: the FK carries
    // workspace_id, so "feature invoicing" always means the local one.
    await expectSqlState(
      prisma.$executeRawUnsafe(
        `INSERT INTO "intent_feature_seeds"
           ("workspace_id", "feature_id", "repo_key", "node_id", "created_by")
         VALUES ($1::uuid, 'no-such-feature', 'orders', 'node-1', 'schema-test')`,
        home,
      ),
      '23503',
    );

    // Child rows of an item are reachable only from items in the same workspace.
    await expectSqlState(
      prisma.$executeRawUnsafe(
        `INSERT INTO "intent_anchors"
           ("workspace_id", "item_id", "repo_key", "node_id", "node_type",
            "captured_versioned_id", "created_by")
         VALUES ($1::uuid, 'br-other-rule', 'orders', 'node-1', 'Function', 'node-1@abc', 'schema-test')`,
        home,
      ),
      '23503',
    );
    await expectSqlState(
      prisma.$executeRawUnsafe(
        `INSERT INTO "intent_item_sources"
           ("workspace_id", "item_id", "kind", "ref", "local_id")
         VALUES ($1::uuid, 'br-other-rule', 'spec'::"IntentSourceKind", 'spec/intent', 'S1')`,
        home,
      ),
      '23503',
    );
    await expectSqlState(
      prisma.$executeRawUnsafe(
        `INSERT INTO "intent_authority_transitions"
           ("workspace_id", "item_id", "from_authority", "to_authority", "actor_id", "actor_role",
            "reason", "source_kind", "source_ref")
         VALUES ($1::uuid, 'br-other-rule', 'candidate'::"IntentItemAuthority",
                 'accepted'::"IntentItemAuthority", 'actor', 'maintainer', 'because',
                 'spec'::"IntentAuthoritySourceKind", 'spec/intent')`,
        home,
      ),
      '23503',
    );

    // Supersession and replacement pointers are same-workspace references.
    await insertItem(home, 'br-successor', { domainId: homeDomain });
    await expectSqlState(
      prisma.$executeRawUnsafe(
        `UPDATE "intent_items"
         SET "proposed_successor_of_id" = 'br-other-rule'
         WHERE "workspace_id" = $1::uuid AND "id" = 'br-successor'`,
        home,
      ),
      '23503',
    );
    await expectSqlState(
      prisma.$executeRawUnsafe(
        `UPDATE "intent_items"
         SET "authority" = 'superseded'::"IntentItemAuthority", "superseded_by_id" = 'br-other-rule'
         WHERE "workspace_id" = $1::uuid AND "id" = 'br-home-rule'`,
        home,
      ),
      '23503',
    );

    // The same-workspace versions of both pointers are accepted.
    await prisma.$executeRawUnsafe(
      `UPDATE "intent_items"
       SET "proposed_successor_of_id" = 'br-home-rule'
       WHERE "workspace_id" = $1::uuid AND "id" = 'br-successor'`,
      home,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE "intent_items"
       SET "authority" = 'superseded'::"IntentItemAuthority", "superseded_by_id" = 'br-successor'
       WHERE "workspace_id" = $1::uuid AND "id" = 'br-home-rule'`,
      home,
    );

    // A domain that still owns a feature cannot be deleted (NO ACTION refuses
    // the orphan) while a workspace hard delete still cascades the whole tree.
    await expectSqlState(
      prisma.$executeRawUnsafe(
        `DELETE FROM "intent_domains" WHERE "workspace_id" = $1::uuid AND "id" = $2`,
        home,
        homeDomain,
      ),
      '23503',
    );
    expect(homeFeature).toBe('invoicing');

    await prisma.workspace.delete({ where: { id: home } });
    expect(await prisma.intentDomain.count({ where: { workspaceId: home } })).toBe(0);
    expect(await prisma.intentFeature.count({ where: { workspaceId: home } })).toBe(0);
    expect(await prisma.intentItem.count({ where: { workspaceId: home } })).toBe(0);
    // The other tenant is untouched.
    expect(await prisma.intentItem.count({ where: { workspaceId: other } })).toBe(1);
  });

  it('enforces the attachment XOR and the feature→domain match', async () => {
    const workspaceId = await createWorkspace('attachment');
    const domainId = await createDomain(workspaceId, 'billing');
    const otherDomainId = await createDomain(workspaceId, 'reporting');
    const featureId = await createFeature(workspaceId, 'invoicing', domainId);

    // Product-root attachment: both refs null.
    await insertItem(workspaceId, 'cap-root', { kind: 'capability' });
    // Domain attachment.
    await insertItem(workspaceId, 'uc-domain', { kind: 'use_case', domainId });
    // Feature attachment carries the feature's own domain.
    await insertItem(workspaceId, 'flow-feature', { kind: 'flow', domainId, featureId });

    // A feature reference without a domain is unrepresentable.
    await expectSqlState(insertItem(workspaceId, 'br-orphan-feature', { featureId }), '23514');

    // A feature-attached item naming a DIFFERENT domain is refused by the
    // three-column foreign key, not by service-layer validation.
    await expectSqlState(insertItem(workspaceId, 'br-mismatched', { domainId: otherDomainId, featureId }), '23503');

    // An unknown domain is refused too.
    await expectSqlState(insertItem(workspaceId, 'br-unknown-domain', { domainId: 'no-such-domain' }), '23503');
  });

  it('refuses malformed ids, kind/prefix disagreement, and broken supersession pairing', async () => {
    const workspaceId = await createWorkspace('shape');

    await expectSqlState(insertItem(workspaceId, 'BR-Upper-Case'), '23514');
    // `lim-` belongs to limitation, never to business_rule.
    await expectSqlState(insertItem(workspaceId, 'lim-wrong-prefix'), '23514');
    await expectSqlState(insertItem(workspaceId, 'br-zero-version', { version: 0 }), '23514');

    await insertItem(workspaceId, 'br-live');
    await insertItem(workspaceId, 'br-replacement');
    // A supersession pointer only makes sense on a superseded item.
    await expectSqlState(
      prisma.$executeRawUnsafe(
        `UPDATE "intent_items" SET "superseded_by_id" = 'br-replacement'
         WHERE "workspace_id" = $1::uuid AND "id" = 'br-live'`,
        workspaceId,
      ),
      '23514',
    );
    // And an item never supersedes itself.
    await expectSqlState(
      prisma.$executeRawUnsafe(
        `UPDATE "intent_items"
         SET "authority" = 'superseded'::"IntentItemAuthority", "superseded_by_id" = 'br-live'
         WHERE "workspace_id" = $1::uuid AND "id" = 'br-live'`,
        workspaceId,
      ),
      '23514',
    );

    await expectSqlState(
      prisma.$executeRawUnsafe(
        `INSERT INTO "intent_domains"
           ("workspace_id", "id", "title", "statement", "created_by", "updated_by", "updated_at")
         VALUES ($1::uuid, 'Not A Slug', 'D', 'S', 'schema-test', 'schema-test', CURRENT_TIMESTAMP)`,
        workspaceId,
      ),
      '23514',
    );
  });

  it('enforces the uniqueness set: workspace slugs, anchor, seed, and source identity', async () => {
    const workspaceId = await createWorkspace('uniqueness');
    const domainId = await createDomain(workspaceId, 'billing');
    const featureId = await createFeature(workspaceId, 'invoicing', domainId);
    await insertItem(workspaceId, 'br-unique', { domainId });

    await expectSqlState(createDomain(workspaceId, domainId), '23505');
    await expectSqlState(createFeature(workspaceId, featureId, domainId), '23505');
    await expectSqlState(insertItem(workspaceId, 'br-unique', { domainId }), '23505');

    const insertSeed = (): Promise<number> =>
      prisma.$executeRawUnsafe(
        `INSERT INTO "intent_feature_seeds"
           ("workspace_id", "feature_id", "repo_key", "node_id", "created_by")
         VALUES ($1::uuid, $2, 'orders', 'src/invoice.ts#createInvoice', 'schema-test')`,
        workspaceId,
        featureId,
      );
    await insertSeed();
    await expectSqlState(insertSeed(), '23505');

    const insertAnchor = (): Promise<number> =>
      prisma.$executeRawUnsafe(
        `INSERT INTO "intent_anchors"
           ("workspace_id", "item_id", "repo_key", "node_id", "node_type",
            "captured_versioned_id", "created_by")
         VALUES ($1::uuid, 'br-unique', 'orders', 'src/invoice.ts#createInvoice', 'Function',
                 'src/invoice.ts#createInvoice@abc123', 'schema-test')`,
        workspaceId,
      );
    await insertAnchor();
    await expectSqlState(insertAnchor(), '23505');

    const insertSource = (): Promise<number> =>
      prisma.$executeRawUnsafe(
        `INSERT INTO "intent_item_sources"
           ("workspace_id", "item_id", "kind", "ref", "local_id", "revision")
         VALUES ($1::uuid, 'br-unique', 'spec'::"IntentSourceKind",
                 'spec/intent-cloud-design', 'S13', 'abc123')`,
        workspaceId,
      );
    await insertSource();
    await expectSqlState(insertSource(), '23505');

    // Idempotency keys are unique per workspace, not globally.
    const otherWorkspaceId = await createWorkspace('uniqueness-other');
    const insertMutationRequest = (target: string): Promise<number> =>
      prisma.$executeRawUnsafe(
        `INSERT INTO "intent_mutation_requests"
           ("workspace_id", "idempotency_key", "operation", "request_hash", "response")
         VALUES ($1::uuid, $2, 'propose', $3, '{"ok":true}'::jsonb)`,
        target,
        `key-${RUN}`,
        'a'.repeat(64),
      );
    await insertMutationRequest(workspaceId);
    await insertMutationRequest(otherWorkspaceId);
    await expectSqlState(insertMutationRequest(workspaceId), '23505');
  });

  it('refuses an intent repo key whose hash does not reproduce the graph repo key', async () => {
    const workspaceId = await createWorkspace('identity');

    // Negative paths go through raw SQL: Prisma rewrites constraint failures
    // into its own error codes before the SQLSTATE reaches the driver-adapter
    // error this helper reads.
    await expectSqlState(
      prisma.$executeRawUnsafe(
        `INSERT INTO "workspace_repos" ("workspace_id", "repo_key", "repo_name", "intent_repo_key")
         VALUES ($1::uuid, 'not-the-hash', 'orders', 'orders')`,
        workspaceId,
      ),
      '23514',
    );

    const repo = await prisma.workspaceRepo.create({
      data: {
        workspaceId,
        repoKey: graphHash('orders'),
        repoName: 'orders',
        intentRepoKey: 'orders',
        normalizedGitRemote: 'github.com/Acme/Orders',
      },
    });
    expect(repo.intentRepoKey).toBe('orders');

    // Credentials and the .git suffix never reach the stored remote.
    await expectSqlState(
      prisma.$executeRawUnsafe(
        `INSERT INTO "workspace_repos"
           ("workspace_id", "repo_key", "repo_name", "intent_repo_key", "normalized_git_remote")
         VALUES ($1::uuid, $2, 'payments', 'payments', 'https://user:secret@github.com/Acme/Payments.git')`,
        workspaceId,
        graphHash('payments'),
      ),
      '23514',
    );

    // The durable key is unique within the workspace. Asserted through raw SQL
    // because Prisma rewrites unique violations into P2002 before the SQLSTATE
    // reaches the driver-adapter error this helper reads.
    await expectSqlState(
      prisma.$executeRawUnsafe(
        `INSERT INTO "workspace_repos" ("workspace_id", "repo_key", "repo_name", "intent_repo_key")
         VALUES ($1::uuid, $2, 'orders-copy', 'orders')`,
        workspaceId,
        graphHash('orders'),
      ),
      '23505',
    );
  });

  it('installs pg_trgm and the lexical indexes the context selector relies on', async () => {
    const extensions = await prisma.$queryRawUnsafe<Array<{ extname: string }>>(
      `SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'`,
    );
    expect(extensions).toEqual([{ extname: 'pg_trgm' }]);

    const indexes = await prisma.$queryRawUnsafe<Array<{ name: string; definition: string }>>(
      `SELECT indexname AS name, indexdef AS definition
       FROM pg_indexes
       WHERE schemaname = current_schema()
         AND indexname IN ('intent_items_title_trgm_idx', 'intent_items_statement_trgm_idx')
       ORDER BY indexname`,
    );
    expect(indexes.map((index) => index.name)).toEqual([
      'intent_items_statement_trgm_idx',
      'intent_items_title_trgm_idx',
    ]);
    for (const index of indexes) expect(index.definition).toContain('gin_trgm_ops');
  });
});
