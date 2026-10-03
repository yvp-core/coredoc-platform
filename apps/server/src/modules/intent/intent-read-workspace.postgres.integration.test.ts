/**
 * Workspace import and the file-like reads, end to end against PostgreSQL.
 *
 * One fresh workspace receives a small knowledge base through
 * `POST …/intent/import/workspace` (real guards, AuthGuard stubbed), and the
 * reads are then checked on the rows it wrote: the tree counts, a node read
 * that holds every item with its delivery status and open questions, related
 * nodes with their reasons, search over payload and source refs, relation
 * writes, and relation cleanup when a feature is deleted.
 */
import 'dotenv/config';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthGuard } from '../../auth/auth.guard.js';
import { ControlPlaneService } from '../../database/control-plane.service.js';
import { buildPrismaAdapter } from '../../database/create-prisma-client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { PrismaClient } from '../../generated/prisma/client.js';
import { IntentErrorCode, IntentPublicException } from './contract/index.js';
import { IntentExportService } from './intent-export.service.js';
import { IntentImportController } from './intent-import.controller.js';
import { IntentReadService } from './intent-read.service.js';
import { IntentTreeService } from './intent-tree.service.js';
import {
  CLOUD_INTENT_WORKSPACE_FORMAT_VERSION,
  IntentWorkspaceImportService,
  type CloudIntentWorkspaceImportResultV1,
} from './intent-workspace-import.js';

const TEST_DATABASE_URL = process.env.INTENT_TRANSFER_TEST_DATABASE_URL ?? '';
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
const OWNER = { id: `${RUN}-owner`, email: 'owner@example.com' };
const ACTOR = { id: OWNER.id, role: 'owner' };

const issue = (key: string, title: string) => ({ kind: 'issue', ref: `tracker:${key}`, localId: key, title });

const DOCUMENT = {
  formatVersion: CLOUD_INTENT_WORKSPACE_FORMAT_VERSION,
  source: { ref: 'kb@main', revision: 'b'.repeat(64) },
  dimensions: [
    {
      id: 'app',
      title: 'App',
      values: [
        { id: 'web', title: 'Web' },
        { id: 'kiosk', title: 'Kiosk' },
      ],
    },
  ],
  domains: [
    { id: 'auth', title: 'Sign-in and sessions', statement: 'How people get in and stay in.' },
    { id: 'time-tracking', title: 'Time tracking and attendance' },
  ],
  features: [
    // Listed before its parent: the import must insert parents first.
    { id: 'session-timeouts', domainId: 'auth', parentFeatureId: 'sessions', title: 'Session timeouts' },
    {
      id: 'sessions',
      domainId: 'auth',
      title: 'Sessions and logout',
      statement: 'What keeps someone signed in.',
      layout: [
        { item: 'cap-sessions', style: 'prose' },
        { heading: 'How it works', level: 2 },
        { lines: ['The web keeps the session of the selected company.', '', 'Phones keep one device session.'] },
        { heading: 'Rules', level: 2 },
        { heading: 'Kiosk', level: 3 },
        { item: 'br-session-kiosk-logout-uploads-first' },
        { heading: 'Web', level: 3 },
        { item: 'br-session-web-timeout' },
        { heading: 'Flows', level: 2 },
        { item: 'flow-session-kiosk-logout', style: 'heading' },
        { heading: 'Open questions', level: 2 },
        { item: 'dec-session-unsynced-punches' },
      ],
    },
    { id: 'sign-in', domainId: 'auth', title: 'Sign-in' },
    { id: 'punches', domainId: 'time-tracking', title: 'Punches' },
  ],
  relations: [
    {
      from: { kind: 'feature', id: 'sessions' },
      to: { kind: 'feature', id: 'sign-in' },
      why: 'Every sign-in ends by creating a session',
    },
    {
      from: { kind: 'feature', id: 'punches' },
      to: { kind: 'feature', id: 'sessions' },
      why: 'A forced logout may lose unsent punches',
    },
  ],
  items: [
    {
      id: 'cap-sessions',
      kind: 'capability',
      featureId: 'sessions',
      title: 'Sessions overview',
      statement: 'What keeps someone signed in. *(tracker:PROD-9)*',
      authority: 'accepted',
      sources: [issue('PROD-9', 'Sessions')],
    },
    {
      id: 'br-session-kiosk-logout-uploads-first',
      kind: 'business_rule',
      featureId: 'sessions',
      title: 'Kiosk logout uploads first',
      statement: 'A kiosk logout first uploads the punches it has not sent yet. *(tracker:ACME-301)*',
      appliesWhen: [{ dimension: 'app', in: ['kiosk'] }],
      payload: {
        condition: 'A manager logs a kiosk out',
        requiredOutcome: 'Unsent punches are uploaded before the kiosk clears its data',
        observer: 'Manager',
        exceptions: [],
      },
      authority: 'accepted',
      sources: [issue('ACME-301', 'Kiosk logout')],
    },
    {
      id: 'flow-session-kiosk-logout',
      kind: 'flow',
      featureId: 'sessions',
      title: 'Kiosk logout',
      statement: 'A manager logs a kiosk out.',
      body: [
        '1. **Upload.** The kiosk uploads unsent punches (br-session-kiosk-logout-uploads-first).',
        '2. **Clear.** It clears its data. *(tracker:ACME-301)*',
      ],
      authority: 'accepted',
      sources: [issue('ACME-301', 'Kiosk logout')],
    },
    {
      id: 'br-session-web-timeout',
      kind: 'business_rule',
      featureId: 'sessions',
      title: 'Web sessions time out after 8 hours',
      statement: 'A web session ends 8 hours after sign-in.',
      authority: 'superseded',
      supersededById: 'br-session-web-timeout-v2',
      sources: [issue('PROD-100', 'Session timeout')],
    },
    {
      id: 'br-session-web-timeout-v2',
      kind: 'business_rule',
      featureId: 'sessions',
      title: 'Web sessions time out after 12 hours',
      statement: 'A web session ends 12 hours after sign-in.',
      authority: 'accepted',
      proposedSuccessorOfId: 'br-session-web-timeout',
      sources: [issue('PROD-200', 'Longer sessions')],
    },
    {
      id: 'dec-session-unsynced-punches',
      kind: 'decision',
      featureId: 'sessions',
      title: 'Unsent punches on forced logout',
      statement: 'Open question: should a phone upload unsent punches before a forced logout?',
      payload: {
        question: 'Should a phone upload unsent punches before a forced logout?',
        choiceStatus: 'open',
        rationale: 'Employees lost punches after a forced logout.',
        alternatives: [],
        consequences: [],
      },
      authority: 'accepted',
      sources: [issue('ACME-302', 'Lost punches after logout')],
    },
    {
      id: 'br-auth-one-account',
      kind: 'business_rule',
      domainId: 'auth',
      title: 'One account per e-mail',
      statement: 'An e-mail address belongs to one account.',
      authority: 'accepted',
      sources: [issue('PROD-1', 'Accounts')],
    },
    {
      id: 'br-punch-needs-device',
      kind: 'business_rule',
      featureId: 'punches',
      title: 'Mobile punches need a verified device',
      statement: 'Mobile punching refuses an unverified device.',
      authority: 'candidate',
      sources: [issue('PROD-2', 'Device check')],
    },
  ],
  releases: {
    baseline: {
      deliveredRef: 'kb-import',
      itemIds: ['br-session-kiosk-logout-uploads-first', 'br-session-web-timeout', 'br-auth-one-account'],
    },
    plans: [{ itemId: 'br-session-web-timeout-v2' }],
  },
};

describe.skipIf(!TEST_DATABASE_URL)('workspace import and file-like reads (PostgreSQL integration)', () => {
  let prisma: PrismaClient;
  let pool: ReturnType<typeof buildPrismaAdapter>;
  let previousDatabaseUrl: string | undefined;
  let app: INestApplication;
  let reads: IntentReadService;
  let tree: IntentTreeService;
  let workspaceId: string;
  let result: CloudIntentWorkspaceImportResultV1;

  beforeAll(async () => {
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    pool = buildPrismaAdapter();
    prisma = new PrismaClient({ adapter: pool?.adapter } as never);
    await prisma.$connect();

    const workspace = await prisma.workspace.create({
      data: { name: `intent-read-${RUN}`, slug: `intent-read-${RUN}`, intentEnabled: true },
    });
    workspaceId = workspace.id;
    await prisma.workspaceMember.create({
      data: { workspaceId, userId: OWNER.id, email: OWNER.email, role: 'owner' },
    });

    const moduleRef = await Test.createTestingModule({
      controllers: [IntentImportController],
      providers: [
        { provide: PrismaService, useValue: prisma as unknown as PrismaService },
        ControlPlaneService,
        IntentWorkspaceImportService,
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          context.switchToHttp().getRequest().user = OWNER;
          return true;
        },
      })
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    await app.listen(0, '127.0.0.1');

    reads = new IntentReadService(prisma as unknown as PrismaService);
    tree = new IntentTreeService(prisma as unknown as PrismaService);

    const response = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${workspaceId}/intent/import/workspace`)
      .send({ idempotencyKey: `ws-import-${RUN}`, document: DOCUMENT })
      .expect(201);
    result = response.body as CloudIntentWorkspaceImportResultV1;
  });

  async function removeWorkspace(id: string) {
    await prisma.intentReleaseEvent.deleteMany({ where: { workspaceId: id } });
    await prisma.intentNodeRelation.deleteMany({ where: { workspaceId: id } });
    await prisma.intentAuthorityTransition.deleteMany({ where: { workspaceId: id } });
    await prisma.intentItemSource.deleteMany({ where: { workspaceId: id } });
    await prisma.intentItem.updateMany({
      where: { workspaceId: id },
      data: { supersededById: null, proposedSuccessorOfId: null },
    });
    await prisma.intentItem.deleteMany({ where: { workspaceId: id } });
    await prisma.intentFeature.deleteMany({ where: { workspaceId: id } });
    await prisma.intentDomain.deleteMany({ where: { workspaceId: id } });
    await prisma.intentDimension.deleteMany({ where: { workspaceId: id } });
    await prisma.workspace.delete({ where: { id } }).catch(() => undefined);
  }

  afterAll(async () => {
    await app?.close();
    if (workspaceId) await removeWorkspace(workspaceId);
    await prisma.$disconnect();
    if (pool?.pool) await pool.pool.end();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  it('imports the tree, relations, items and release evidence in one go', async () => {
    expect(result.counts).toEqual({
      domains: 2,
      features: 4,
      dimensions: 1,
      relations: 2,
      items: { accepted: 6, candidate: 1, superseded: 1, rejected: 0 },
      sources: 8,
      baselineItems: 3,
      plans: 1,
    });
    expect(result.releaseHeadSeq).toBe(2);
    const transitions = await prisma.intentAuthorityTransition.findMany({ where: { workspaceId } });
    expect(transitions).toHaveLength(8);
    expect(transitions.every((row) => row.fromAuthority === null && row.sourceKind === 'import')).toBe(true);
  });

  it('exports in the import format, and re-importing that export exports the same document', async () => {
    const exportsService = new IntentExportService(prisma as unknown as PrismaService);
    const first = await exportsService.exportWorkspace(workspaceId);
    expect(first.items).toHaveLength(DOCUMENT.items.length);
    expect(first.relations).toHaveLength(DOCUMENT.relations.length);
    expect(first.features.find((feature) => feature.id === 'session-timeouts')?.parentFeatureId).toBe('sessions');
    expect(first.features.find((feature) => feature.id === 'sessions')?.layout).toEqual(DOCUMENT.features[1]?.layout);
    expect(first.releases?.baseline?.itemIds).toEqual([...DOCUMENT.releases.baseline.itemIds].sort());
    expect(first.releases?.plans).toEqual([
      { itemId: 'br-session-web-timeout-v2', reason: 'Planned in the imported knowledge base' },
    ]);

    const copy = await prisma.workspace.create({
      data: { name: `intent-read-copy-${RUN}`, slug: `intent-read-copy-${RUN}`, intentEnabled: true },
    });
    try {
      await prisma.workspaceMember.create({
        data: { workspaceId: copy.id, userId: OWNER.id, email: OWNER.email, role: 'owner' },
      });
      await request(app.getHttpServer())
        .post(`/api/v1/workspaces/${copy.id}/intent/import/workspace`)
        .send({ idempotencyKey: `ws-roundtrip-${RUN}`, document: first })
        .expect(201);
      expect(await exportsService.exportWorkspace(copy.id)).toEqual(first);
    } finally {
      await removeWorkspace(copy.id);
    }
  });

  it('replays the same key and refuses a second import into the now non-empty workspace', async () => {
    const replay = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${workspaceId}/intent/import/workspace`)
      .send({ idempotencyKey: `ws-import-${RUN}`, document: DOCUMENT })
      .expect(201);
    expect(replay.body).toEqual(result);
    await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${workspaceId}/intent/import/workspace`)
      .send({ idempotencyKey: `ws-import-${RUN}-again`, document: DOCUMENT })
      .expect(409);
  });

  it('lists the nodes as a nested folder, marking the empty ones', async () => {
    const text = await reads.tree(workspaceId);
    expect(text).toContain('# Intent tree: 2 domains, 4 features, 6 accepted items');
    expect(text).toContain(
      '- auth: Sign-in and sessions\n  - sessions: Sessions and logout\n    - session-timeouts: Session timeouts (empty)\n  - sign-in: Sign-in (empty)',
    );
    expect(text).toContain('- time-tracking: Time tracking and attendance (empty)\n  - punches: Punches (empty)');
  });

  it('renders a feature as its document: layout order, sub-headings, item bodies, replacements', async () => {
    const text = await reads.node(workspaceId, { feature: 'sessions' });
    const [document, footer] = text.split('\n\n---\n');
    expect(document).toBe(
      [
        '# Sessions and logout',
        '',
        'What keeps someone signed in. [cap-sessions]',
        'Delivery: no delivery record.',
        '',
        '## How it works',
        'The web keeps the session of the selected company.',
        '',
        'Phones keep one device session.',
        '',
        '## Rules',
        '### Kiosk',
        '- **br-session-kiosk-logout-uploads-first** — A kiosk logout first uploads the punches it has not sent yet.',
        '  Applies when app in kiosk.',
        '  Payload: {"observer":"Manager","condition":"A manager logs a kiosk out","exceptions":[],"requiredOutcome":"Unsent punches are uploaded before the kiosk clears its data"}',
        '',
        '### Web',
        // Still in production: it keeps its place until the planned replacement ships.
        '- **br-session-web-timeout** — A web session ends 8 hours after sign-in.',
        '  Replaced by br-session-web-timeout-v2; still in production until that ships.',
        '- **br-session-web-timeout-v2** — A web session ends 12 hours after sign-in.',
        '  Delivery: planned.',
        '',
        '## Flows',
        '### flow-session-kiosk-logout',
        'A manager logs a kiosk out.',
        '1. **Upload.** The kiosk uploads unsent punches (br-session-kiosk-logout-uploads-first).',
        '2. **Clear.** It clears its data.',
        'Delivery: no delivery record.',
        '',
        '## Open questions',
        '- **dec-session-unsynced-punches** — Open question: should a phone upload unsent punches before a forced logout?',
      ].join('\n'),
    );
    expect(footer).toContain('Feature sessions in domain auth (Sign-in and sessions).');
    expect(footer).toContain('- feature punches: Punches. A forced logout may lose unsent punches');
    expect(footer).toContain(
      'Delivery: 1 in production, 1 planned (br-session-web-timeout-v2), 2 with no delivery record.',
    );
    expect(footer).toContain('Also applies: 1 items on domain auth also apply here');
  });

  it('returns the same document as structure for the web', async () => {
    const doc = await reads.document(workspaceId, { feature: 'sessions' });
    expect(doc.node).toEqual({ kind: 'feature', id: 'sessions', title: 'Sessions and logout', domainId: 'auth' });
    expect(doc.sections.map((section) => section.heading)).toEqual([
      null,
      'How it works',
      'Rules',
      'Flows',
      'Open questions',
    ]);
    const rules = doc.sections[2]?.blocks ?? [];
    expect(
      rules.map((block) => (block.type === 'item' ? block.item.id : block.type === 'heading' ? block.text : '')),
    ).toEqual([
      'Kiosk',
      'br-session-kiosk-logout-uploads-first',
      'Web',
      'br-session-web-timeout',
      'br-session-web-timeout-v2',
    ]);
    const flow = doc.sections[3]?.blocks[0];
    expect(flow).toMatchObject({ type: 'item', style: 'heading', item: { id: 'flow-session-kiosk-logout' } });
    expect(doc.sections[4]?.blocks[0]).toMatchObject({ type: 'item', item: { openQuestion: true } });
    expect(doc.related.map((relation) => relation.id)).toEqual(['sign-in', 'punches']);
    expect(doc.delivery).toEqual({ effective: 1, planned: 1, unrecorded: 2 });
    expect(doc.truncated).toBe(false);
  });

  it('shows a replaced item still in production even where it has no slot', async () => {
    const text = await reads.node(workspaceId, { feature: 'sessions', kind: ['business_rule'] });
    expect(text).toContain('- **br-session-web-timeout** — A web session ends 8 hours after sign-in.');
    expect(text).toContain('Replaced by br-session-web-timeout-v2; still in production until that ships.');
    expect(text).toContain('- **br-session-web-timeout-v2** — A web session ends 12 hours after sign-in.');
  });

  it("fills a replaced item's slot with its successor once the old one is out of production", async () => {
    await prisma.intentReleaseEvent.deleteMany({ where: { workspaceId, kind: 'baseline' } });
    const text = await reads.node(workspaceId, { feature: 'sessions' });
    expect(text).toContain('### Web\n- **br-session-web-timeout-v2** — A web session ends 12 hours after sign-in.');
    expect(text).not.toContain('8 hours');
  });

  it('keeps references with refs: true, appending sources the text does not cite', async () => {
    const text = await reads.node(workspaceId, { feature: 'sessions', refs: true });
    expect(text).toContain('What keeps someone signed in. *(tracker:PROD-9)*');
    expect(text).toContain(
      '- **br-session-kiosk-logout-uploads-first** — A kiosk logout first uploads the punches it has not sent yet. *(tracker:ACME-301)*\n',
    );
    expect(text).toContain(
      '- **br-session-web-timeout-v2** — A web session ends 12 hours after sign-in. *(tracker:PROD-200)*',
    );
    expect(text).toContain('2. **Clear.** It clears its data. *(tracker:ACME-301)*');
  });

  it('renders a node without a layout in kind order, and candidates only when asked', async () => {
    expect(await reads.node(workspaceId, { feature: 'punches' })).toContain('No items are attached here.');
    const withCandidates = await reads.node(workspaceId, { feature: 'punches', includeCandidates: true });
    expect(withCandidates).toContain(
      '## Rules\n- **br-punch-needs-device** — Mobile punching refuses an unverified device.',
    );
    const domain = await reads.node(workspaceId, { domain: 'auth' });
    expect(domain).toContain(
      '# Sign-in and sessions\n\nHow people get in and stay in.\n\n## Rules\n- **br-auth-one-account**',
    );
    expect(domain).toContain('Features: sessions, sign-in');
  });

  it('refuses a guessed id with the nearest declared one', async () => {
    const error = await reads.node(workspaceId, { domain: 'attendance' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(IntentPublicException);
    const body = (error as IntentPublicException).publicError;
    expect(body.code).toBe(IntentErrorCode.DomainNotFound);
    expect(body.message).toContain('nearest: time-tracking');
  });

  it('searches every word across payload and source refs, with a total and paging', async () => {
    const byPayload = await reads.search(workspaceId, { query: 'uploaded kiosk' });
    expect(byPayload).toContain('1 items match every word of "uploaded kiosk"');
    expect(byPayload).toContain('- br-session-kiosk-logout-uploads-first [business_rule] feature sessions');

    const byBody = await reads.search(workspaceId, { query: 'clears data' });
    expect(byBody).toContain('flow-session-kiosk-logout');

    const byProse = await reads.search(workspaceId, { query: 'device session' });
    expect(byProse).toContain('0 items match every word of "device session"');
    expect(byProse).toContain('1 nodes match in their prose:\n- feature sessions: Sessions and logout. ');
    expect(byProse).toContain('Phones keep one device session.');
    expect(await reads.search(workspaceId, { query: 'device session', kind: ['flow'] })).not.toContain('prose');

    const bySource = await reads.search(workspaceId, { query: 'acme-302' });
    expect(bySource).toContain('dec-session-unsynced-punches');

    const paged = await reads.search(workspaceId, { query: 'logout', limit: 1 });
    expect(paged).toContain('3 items match every word of "logout"');
    expect(paged).toContain(
      'TRUNCATED: more matches follow. Continue with after: "br-session-kiosk-logout-uploads-first"',
    );
    const next = await reads.search(workspaceId, {
      query: 'logout',
      limit: 1,
      after: 'br-session-kiosk-logout-uploads-first',
    });
    expect(next).toContain('dec-session-unsynced-punches');
    const last = await reads.search(workspaceId, { query: 'logout', limit: 5, after: 'dec-session-unsynced-punches' });
    expect(last).toContain('flow-session-kiosk-logout');
    expect(last).not.toContain('TRUNCATED');
  });

  it('nests features: sub-features in the node read, same-domain parents only, no cycles, no orphaning', async () => {
    expect(await reads.node(workspaceId, { feature: 'sessions' })).toContain('Sub-features: session-timeouts');
    expect(await reads.node(workspaceId, { feature: 'session-timeouts' })).toContain(
      'under feature sessions (Sessions and logout)',
    );
    const doc = await reads.document(workspaceId, { domain: 'auth' });
    expect(doc.features.map((feature) => feature.id)).toEqual(['sessions', 'sign-in']);

    await expect(
      tree.updateFeature(workspaceId, ACTOR, {
        idempotencyKey: `nest-${RUN}-1`,
        id: 'sessions',
        parentFeatureId: 'session-timeouts',
      }),
    ).rejects.toMatchObject({ publicError: { code: IntentErrorCode.FeatureParentCycle } });
    await expect(
      tree.createFeature(workspaceId, ACTOR, {
        idempotencyKey: `nest-${RUN}-2`,
        id: 'punch-offline',
        domainId: 'time-tracking',
        parentFeatureId: 'sessions',
        title: 'Offline punches',
      }),
    ).rejects.toMatchObject({ publicError: { code: IntentErrorCode.FeatureDomainMismatch } });
    await expect(
      tree.deleteFeature(workspaceId, ACTOR, { idempotencyKey: `nest-${RUN}-3`, id: 'sessions' }),
    ).rejects.toMatchObject({ publicError: { code: IntentErrorCode.TreeNodeNotEmpty } });

    const moved = await tree.updateFeature(workspaceId, ACTOR, {
      idempotencyKey: `nest-${RUN}-4`,
      id: 'session-timeouts',
      parentFeatureId: null,
    });
    expect(moved.feature.parentFeatureId).toBeNull();
    const back = await tree.updateFeature(workspaceId, ACTOR, {
      idempotencyKey: `nest-${RUN}-5`,
      id: 'session-timeouts',
      parentFeatureId: 'sessions',
    });
    expect(back.feature.parentFeatureId).toBe('sessions');
  });

  it('puts, re-words and deletes a relation, and deleting a feature removes its relations', async () => {
    const put = await tree.putRelation(workspaceId, ACTOR, {
      idempotencyKey: `rel-${RUN}-1`,
      from: { kind: 'feature', id: 'sign-in' },
      to: { kind: 'domain', id: 'time-tracking' },
      why: 'Kiosk sign-in starts the punch clock',
    });
    expect(put.created).toBe(true);
    const reworded = await tree.putRelation(workspaceId, ACTOR, {
      idempotencyKey: `rel-${RUN}-2`,
      from: { kind: 'domain', id: 'time-tracking' },
      to: { kind: 'feature', id: 'sign-in' },
      why: 'A kiosk sign-in starts the punch clock',
    });
    expect(reworded.created).toBe(false);
    expect(await reads.node(workspaceId, { domain: 'time-tracking' })).toContain(
      '- feature sign-in: Sign-in. A kiosk sign-in starts the punch clock',
    );

    await expect(
      tree.putRelation(workspaceId, ACTOR, {
        idempotencyKey: `rel-${RUN}-3`,
        from: { kind: 'feature', id: 'sign-in' },
        to: { kind: 'feature', id: 'sign-in' },
        why: 'x',
      }),
    ).rejects.toMatchObject({ publicError: { code: IntentErrorCode.NodeRelationSelf } });

    await tree.deleteRelation(workspaceId, ACTOR, {
      idempotencyKey: `rel-${RUN}-4`,
      from: { kind: 'feature', id: 'sign-in' },
      to: { kind: 'domain', id: 'time-tracking' },
    });
    const deleted = await tree.deleteFeature(workspaceId, ACTOR, { idempotencyKey: `rel-${RUN}-5`, id: 'sign-in' });
    expect(deleted.deleted.removedRelationCount).toBe(1);
    expect(await prisma.intentNodeRelation.count({ where: { workspaceId } })).toBe(1);
  });

  it('carries an archived node through the round trip', async () => {
    await tree.archiveFeature(workspaceId, ACTOR, { idempotencyKey: `arch-${RUN}`, id: 'punches', archived: true });
    const exportsService = new IntentExportService(prisma as unknown as PrismaService);
    const first = await exportsService.exportWorkspace(workspaceId);
    expect(first.features.find((feature) => feature.id === 'punches')?.archived).toBe(true);

    const copy = await prisma.workspace.create({
      data: { name: `intent-read-arch-${RUN}`, slug: `intent-read-arch-${RUN}`, intentEnabled: true },
    });
    try {
      await prisma.workspaceMember.create({
        data: { workspaceId: copy.id, userId: OWNER.id, email: OWNER.email, role: 'owner' },
      });
      await request(app.getHttpServer())
        .post(`/api/v1/workspaces/${copy.id}/intent/import/workspace`)
        .send({ idempotencyKey: `ws-arch-${RUN}`, document: first })
        .expect(201);
      expect(await exportsService.exportWorkspace(copy.id)).toEqual(first);
    } finally {
      await removeWorkspace(copy.id);
    }
  });

  /** A fresh empty workspace for one test, removed afterwards. */
  async function withWorkspace(name: string, run: (id: string) => Promise<void>) {
    const ws = await prisma.workspace.create({
      data: { name: `${name}-${RUN}`, slug: `${name}-${RUN}`, intentEnabled: true },
    });
    try {
      await prisma.workspaceMember.create({
        data: { workspaceId: ws.id, userId: OWNER.id, email: OWNER.email, role: 'owner' },
      });
      await run(ws.id);
    } finally {
      await removeWorkspace(ws.id);
    }
  }

  const importInto = (id: string, document: unknown, key: string) =>
    request(app.getHttpServer())
      .post(`/api/v1/workspaces/${id}/intent/import/workspace`)
      .send({ idempotencyKey: key, document })
      .expect(201);

  it('round-trips replacement chains, rejected proposals and a stale replacement pointer', async () => {
    const rule = (id: string, extra: Record<string, unknown>) => ({
      id,
      kind: 'business_rule',
      domainId: 'billing',
      title: id,
      statement: `${id} says so.`,
      sources: [issue('PROD-1', 'Billing rules')],
      ...extra,
    });
    const document = {
      formatVersion: 1,
      source: { ref: 'chain-fixture', revision: 'a'.repeat(64) },
      domains: [{ id: 'billing', title: 'Billing' }],
      features: [],
      items: [
        rule('br-x', { authority: 'superseded', supersededById: 'br-s' }),
        rule('br-s', { authority: 'superseded', supersededById: 'br-t', proposedSuccessorOfId: 'br-x' }),
        rule('br-t', { authority: 'accepted', proposedSuccessorOfId: 'br-s' }),
        rule('br-r', { authority: 'rejected', proposedSuccessorOfId: 'br-t' }),
        rule('br-c', { authority: 'candidate', appliesWhen: [{ item: 'br-r' }] }),
      ],
    };
    const exportsService = new IntentExportService(prisma as unknown as PrismaService);
    await withWorkspace('chain-a', async (first) => {
      await importInto(first, document, `chain-a-${RUN}`);
      // A competing proposal: it still names br-s, which br-t replaced first.
      await prisma.intentItem.update({
        where: { workspaceId_id: { workspaceId: first, id: 'br-c' } },
        data: { proposedSuccessorOfId: 'br-s' },
      });
      const exported = await exportsService.exportWorkspace(first);
      expect(exported.items.map((item) => [item.id, item.authority])).toEqual([
        ['br-c', 'candidate'],
        ['br-r', 'rejected'],
        ['br-s', 'superseded'],
        ['br-t', 'accepted'],
        ['br-x', 'superseded'],
      ]);
      expect(exported.items.find((item) => item.id === 'br-c')?.proposedSuccessorOfId).toBeUndefined();

      await withWorkspace('chain-b', async (second) => {
        await importInto(second, exported, `chain-b-${RUN}`);
        expect(await exportsService.exportWorkspace(second)).toEqual(exported);
      });
    });
  });

  it('refuses a move that would push the moved subtree past the nesting limit', async () => {
    await withWorkspace('depth', async (id) => {
      await tree.createDomain(id, ACTOR, { idempotencyKey: `depth-d-${RUN}`, id: 'deep', title: 'Deep' });
      // g1 … g8: g8 has 7 ancestors.
      for (let level = 1; level <= 8; level += 1) {
        await tree.createFeature(id, ACTOR, {
          idempotencyKey: `depth-g${level}-${RUN}`,
          id: `g${level}`,
          domainId: 'deep',
          title: `G${level}`,
          ...(level > 1 ? { parentFeatureId: `g${level - 1}` } : {}),
        });
      }
      await tree.createFeature(id, ACTOR, {
        idempotencyKey: `depth-h1-${RUN}`,
        id: 'h1',
        domainId: 'deep',
        title: 'H1',
      });
      await tree.createFeature(id, ACTOR, {
        idempotencyKey: `depth-h2-${RUN}`,
        id: 'h2',
        domainId: 'deep',
        title: 'H2',
        parentFeatureId: 'h1',
      });
      // h1 under g8 has 8 ancestors (allowed), but h2 would have 9.
      await expect(
        tree.updateFeature(id, ACTOR, { idempotencyKey: `depth-mv-${RUN}`, id: 'h1', parentFeatureId: 'g8' }),
      ).rejects.toMatchObject({ publicError: { code: IntentErrorCode.FeatureParentCycle } });
      await expect(
        tree.updateFeature(id, ACTOR, { idempotencyKey: `depth-mv2-${RUN}`, id: 'h2', parentFeatureId: 'g8' }),
      ).resolves.toMatchObject({ feature: { parentFeatureId: 'g8' } });
      await expect(
        tree.createFeature(id, ACTOR, {
          idempotencyKey: `depth-too-${RUN}`,
          id: 'too-deep',
          domainId: 'deep',
          title: 'Too deep',
          parentFeatureId: 'h2',
        }),
      ).rejects.toMatchObject({ publicError: { code: IntentErrorCode.FeatureParentCycle } });
    });
  });

  it('pages a large node with after, and superseded history never hides current items', async () => {
    await withWorkspace('big-node', async (id) => {
      await tree.createDomain(id, ACTOR, { idempotencyKey: `big-d-${RUN}`, id: 'big', title: 'Big' });
      const row = (n: number, authority: 'accepted' | 'superseded') => ({
        workspaceId: id,
        id: `br-${authority === 'accepted' ? 'a' : '0old'}-${String(n).padStart(4, '0')}`,
        kind: 'business_rule' as const,
        domainId: 'big',
        title: `Rule ${n}`,
        statement: `Rule ${n} holds.`,
        authority,
        createdBy: OWNER.id,
        updatedBy: OWNER.id,
      });
      // Superseded ids sort BEFORE the current ones: one shared window would fill with history and drop items unannounced.
      await prisma.intentItem.createMany({
        data: [
          ...Array.from({ length: 401 }, (_, n) => row(n, 'accepted')),
          ...Array.from({ length: 450 }, (_, n) => row(n, 'superseded')),
        ],
      });
      const first = await reads.node(id, { domain: 'big' });
      expect(first).toContain('- **br-a-0399**');
      expect(first).not.toContain('br-a-0400');
      expect(first).toContain('TRUNCATED');
      expect(first).toContain('Continue with after: "br-a-0399"');
      const rest = await reads.node(id, { domain: 'big', after: 'br-a-0399' });
      expect(rest).toContain('- **br-a-0400**');
      expect(rest).not.toContain('TRUNCATED');
    });
  });

  it('orders relation ends bytewise in the database, as the service does', async () => {
    const [constraint] = await prisma.$queryRaw<{ def: string }[]>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname = 'intent_node_relations_canonical_check'`;
    expect(constraint?.def).toContain('COLLATE "C"');

    await withWorkspace('collate', async (id) => {
      await tree.createDomain(id, ACTOR, { idempotencyKey: `col-d-${RUN}`, id: 'money', title: 'Money' });
      for (const feature of ['pay-roll', 'payment'])
        await tree.createFeature(id, ACTOR, {
          idempotencyKey: `col-${feature}-${RUN}`,
          id: feature,
          domainId: 'money',
          title: feature,
        });
      // A glibc en_US collation ignores the hyphen and would order these the other way round.
      const put = await tree.putRelation(id, ACTOR, {
        idempotencyKey: `col-rel-${RUN}`,
        from: { kind: 'feature', id: 'payment' },
        to: { kind: 'feature', id: 'pay-roll' },
        why: 'Payroll pays out through payments',
      });
      expect(put.created).toBe(true);
    });
  });
});
