import { HttpStatus } from '@nestjs/common';
import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../database/prisma.service.js';
import type { AuthUser } from '../../auth/decorators/current-user.decorator.js';
import { IntentReleaseTrigger } from '../../generated/prisma/client.js';
import { WorkspaceMemberRole } from '../members/dto/workspace-role.enum.js';
import { IntentErrorCode, IntentPublicException } from './contract/index.js';
import { IntentReleaseController } from './intent-release.controller.js';
import type { ReleaseCommand } from './intent-release.operations.js';
import { ReleaseActorKind } from './intent-release.fold.js';
import type { IntentHandoffProcessor } from './intent-handoff-processor.service.js';
import { IntentReleaseService } from './intent-release.service.js';

function serviceOn(trigger: IntentReleaseTrigger, repoTrigger: IntentReleaseTrigger | null = null) {
  const findUnique = vi.fn().mockResolvedValue({ intentReleaseTrigger: trigger });
  const findFirst = vi.fn().mockResolvedValue({ intentReleaseTrigger: repoTrigger });
  const prisma = { workspace: { findUnique }, workspaceRepo: { findFirst } } as unknown as PrismaService;
  return { service: new IntentReleaseService(prisma), findUnique };
}

async function refusal(promise: Promise<unknown>): Promise<IntentPublicException> {
  return promise.then(
    () => {
      throw new Error('expected a refusal');
    },
    (error: unknown) => error as IntentPublicException,
  );
}

/** One parsed automatic body — the only shape a service token may record. */
const deployment = {
  kind: 'release',
  repoKey: 'github.com/acme/orders-api',
  deliveredRef: 'v1.2.3',
  deployId: '9911',
  deployedAt: '2026-09-11T10:00:00.000Z',
  trailers: { delivers: [{ itemId: 'cap-one', version: 1 }], retires: [] },
} as unknown as ReleaseCommand;
/** The maintainer's body: `kind` DEFAULTS to release, which is why the gate cannot read it. */
const typedByHand = {
  kind: 'release',
  idempotencyKey: 'k',
  expectedHeadSeq: 0,
  deliveredRef: 'v1.2.3',
  included: [{ itemId: 'cap-one', contentHash: 'a'.repeat(64) }],
  retired: [],
} as unknown as ReleaseCommand;

describe('IntentReleaseService.assertServiceTokenMayRecord', () => {
  it('admits a deploy repository in a manual workspace', async () => {
    const { service } = serviceOn(IntentReleaseTrigger.manual, IntentReleaseTrigger.deploy);
    await expect(service.assertServiceTokenMayRecord('ws_1', deployment)).resolves.toBeUndefined();
  });

  it.each([
    IntentReleaseTrigger.manual,
    IntentReleaseTrigger.merge,
  ])('refuses a %s repository in a deploy workspace', async (repoTrigger) => {
    const { service } = serviceOn(IntentReleaseTrigger.deploy, repoTrigger);
    const error = await refusal(service.assertServiceTokenMayRecord('ws_1', deployment));
    expect(error.publicError.code).toBe(IntentErrorCode.ReleaseModeForbids);
  });

  it('admits a deployment on a deploy workspace — the CI actor of amendment §2', async () => {
    const { service } = serviceOn(IntentReleaseTrigger.deploy);
    await expect(service.assertServiceTokenMayRecord('ws_1', deployment)).resolves.toBeUndefined();
  });

  it.each([
    IntentReleaseTrigger.manual,
    IntentReleaseTrigger.merge,
  ])('refuses a release on a %s workspace with release_mode_forbids', async (trigger) => {
    const { service } = serviceOn(trigger);
    const error = await refusal(service.assertServiceTokenMayRecord('ws_1', deployment));
    expect(error.publicError.code).toBe(IntentErrorCode.ReleaseModeForbids);
    expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
  });

  it.each([
    ['the maintainer body, which would bypass trailers and ordering', typedByHand],
    ['a baseline — only a deployment is machine-recordable', { ...typedByHand, kind: 'baseline' } as ReleaseCommand],
  ])('refuses %s even on a deploy workspace', async (_case, input) => {
    const { service } = serviceOn(IntentReleaseTrigger.deploy);
    const error = await refusal(service.assertServiceTokenMayRecord('ws_1', input));
    expect(error.publicError.code).toBe(IntentErrorCode.ReleaseModeForbids);
    expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
  });
});

describe('IntentReleaseController.record — who may reach the ledger', () => {
  const user: AuthUser = { id: 'user_1', email: 'a@b.com' };
  const body = {
    idempotencyKey: '11111111-1111-4111-8111-111111111111',
    deliveredRef: 'v1.2.3',
    reason: 'deployed to production',
    included: [{ itemId: 'cap-one', contentHash: 'a'.repeat(64) }],
  };
  const releases = { record: vi.fn().mockResolvedValue({ seq: 1 }), assertServiceTokenMayRecord: vi.fn() };
  const handoffs = { recordDeployment: vi.fn().mockResolvedValue({ outcome: 'no_delivery' }) };
  const controller = new IntentReleaseController(
    releases as unknown as IntentReleaseService,
    handoffs as unknown as IntentHandoffProcessor,
  );

  it('gates a service-token caller on the workspace trigger', async () => {
    const request = { serviceTokenWorkspaceId: 'ws_1', serviceTokenId: 'tok_1' } as unknown as Request;
    // `@WorkspaceRoleValue()` is undefined for a token; its creator may be a plain member.
    await controller.record('ws_1', user, undefined as unknown as WorkspaceMemberRole, body, request);
    // The parsed COMMAND, not its kind: a human body carries `kind: 'release'` too.
    expect(releases.assertServiceTokenMayRecord).toHaveBeenCalledWith('ws_1', expect.objectContaining(body));
    expect(releases.record).toHaveBeenCalled();
  });

  it('records a service-token caller as the token, not its creator (AC-2)', async () => {
    releases.record.mockClear();
    const request = { serviceTokenWorkspaceId: 'ws_1', serviceTokenId: 'tok_1' } as unknown as Request;
    await controller.record('ws_1', user, undefined as unknown as WorkspaceMemberRole, body, request);
    expect(releases.record).toHaveBeenCalledWith(
      'ws_1',
      { id: 'service-token:tok_1', role: 'service_token' },
      expect.anything(),
      ReleaseActorKind.Ci,
    );
  });

  it('records a deployment body as the token, not its creator (AC-2)', async () => {
    const request = { serviceTokenWorkspaceId: 'ws_1', serviceTokenId: 'tok_1' } as unknown as Request;
    const deployment = {
      kind: 'release',
      repoKey: 'coredoc-parser',
      deliveredRef: 'a'.repeat(40),
      deployId: 'deploy-1',
      deployedAt: '2026-09-23T10:00:00Z',
    };
    await controller.record('ws_1', user, undefined as unknown as WorkspaceMemberRole, deployment, request);
    expect(handoffs.recordDeployment).toHaveBeenCalledWith(
      'ws_1',
      expect.objectContaining(deployment),
      { id: 'service-token:tok_1', role: 'service_token' },
      ReleaseActorKind.Ci,
    );
  });

  it('records a deployment body sent by a member session as that member, not as CI', async () => {
    handoffs.recordDeployment.mockClear();
    const deployment = {
      kind: 'release',
      repoKey: 'coredoc-parser',
      deliveredRef: 'b'.repeat(40),
      deployId: 'deploy-2',
      deployedAt: '2026-09-23T11:00:00Z',
    };
    await controller.record('ws_1', user, WorkspaceMemberRole.Member, deployment, {} as Request);
    expect(handoffs.recordDeployment).toHaveBeenCalledWith(
      'ws_1',
      expect.objectContaining(deployment),
      { id: 'user_1', role: WorkspaceMemberRole.Member },
      ReleaseActorKind.Maintainer,
    );
  });

  it('records a member session as that member', async () => {
    releases.record.mockClear();
    await controller.record('ws_1', user, WorkspaceMemberRole.Member, body, {} as Request);
    expect(releases.record).toHaveBeenCalledWith(
      'ws_1',
      { id: 'user_1', role: WorkspaceMemberRole.Member },
      expect.anything(),
      ReleaseActorKind.Maintainer,
    );
  });

  it('spends no query gating a human admin — the manual path is unchanged', async () => {
    releases.assertServiceTokenMayRecord.mockClear();
    await controller.record('ws_1', user, WorkspaceMemberRole.Admin, body, {} as Request);
    expect(releases.assertServiceTokenMayRecord).not.toHaveBeenCalled();
  });
});
