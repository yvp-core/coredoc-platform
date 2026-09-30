import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkOSApiError, type WorkOSInvitationsService } from '../../auth/workos-invitations.service.js';
import type { ControlPlaneService } from '../../database/control-plane.service.js';
import { MembersService } from './members.service.js';

const originalServerUrl = process.env.SERVER_URL;
const originalMcpServerUrl = process.env.MCP_SERVER_URL;
const originalAllowedDomains = process.env.ALLOWED_EMAIL_DOMAINS;

function pendingInvitation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'local-inv-1',
    workspaceId: 'ws-1',
    memberUserId: 'pending:person@example.com',
    workosInvitationId: null,
    expiresAt: null,
    lastSentAt: null,
    createdAt: new Date('2026-08-04T10:00:00.000Z'),
    member: {
      workspaceId: 'ws-1',
      userId: 'pending:person@example.com',
      email: 'person@example.com',
      displayName: null,
      role: 'member',
      pending: true,
      joinedAt: new Date('2026-08-04T10:00:00.000Z'),
    },
    ...overrides,
  };
}

function harness(workosEnabled: boolean) {
  const controlPlane = {
    getWorkspaceById: vi.fn().mockResolvedValue({
      id: 'ws-1',
      name: 'Workspace One',
      workosOrganizationId: workosEnabled ? 'workos-org-1' : null,
    }),
    createPendingInvitation: vi.fn().mockResolvedValue(pendingInvitation()),
    markInvitationDelivered: vi.fn().mockResolvedValue(undefined),
    renewManualInvitation: vi.fn().mockResolvedValue({ count: 1 }),
    removePendingInvitation: vi.fn().mockResolvedValue(true),
    getPendingInvitation: vi.fn().mockResolvedValue(pendingInvitation()),
    listPendingInvitations: vi.fn().mockResolvedValue([pendingInvitation()]),
    countPendingInvitationsByWorkosId: vi.fn().mockResolvedValue(1),
    getWorkspaceOwnerWorkosIdentity: vi
      .fn()
      .mockResolvedValue({ provider: 'workos', provider_user_id: 'workos-owner-1' }),
    setWorkspaceWorkosOrganizationId: vi.fn().mockResolvedValue(undefined),
    getMember: vi.fn(),
    getWorkosIdentity: vi.fn(),
    getInvitationForMember: vi.fn().mockResolvedValue(null),
    removeMember: vi.fn(),
  };
  const workos = {
    isEnabled: vi.fn().mockReturnValue(workosEnabled),
    send: vi.fn().mockResolvedValue({ id: 'workos-inv-1', expiresAt: new Date('2026-08-11T10:00:00.000Z') }),
    resend: vi.fn().mockResolvedValue({ id: 'workos-inv-1', expiresAt: new Date('2026-08-11T10:00:00.000Z') }),
    revoke: vi.fn().mockResolvedValue(undefined),
    ensureOrganization: vi.fn().mockResolvedValue('workos-org-1'),
    ensureOrganizationMembership: vi.fn().mockResolvedValue(undefined),
    removeOrganizationMembership: vi.fn().mockResolvedValue(true),
  };
  return {
    controlPlane,
    workos,
    service: new MembersService(
      controlPlane as unknown as ControlPlaneService,
      workos as unknown as WorkOSInvitationsService,
    ),
  };
}

describe('MembersService invitations', () => {
  beforeEach(() => {
    delete process.env.MCP_SERVER_URL;
    delete process.env.ALLOWED_EMAIL_DOMAINS;
    process.env.SERVER_URL = 'https://coredoc.example.com/';
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (originalServerUrl === undefined) delete process.env.SERVER_URL;
    else process.env.SERVER_URL = originalServerUrl;
    if (originalMcpServerUrl === undefined) delete process.env.MCP_SERVER_URL;
    else process.env.MCP_SERVER_URL = originalMcpServerUrl;
    if (originalAllowedDomains === undefined) delete process.env.ALLOWED_EMAIL_DOMAINS;
    else process.env.ALLOWED_EMAIL_DOMAINS = originalAllowedDomains;
  });

  it('sends and records a WorkOS email while keeping workspace authorization local', async () => {
    const { service, controlPlane, workos } = harness(true);

    await expect(service.inviteMember('ws-1', 'admin-1', 'Person@Example.com')).resolves.toEqual({
      invited: true,
      emailSent: true,
      expiresAt: '2026-08-11T10:00:00.000Z',
      signInUrl: 'https://coredoc.example.com/api/v1/auth/web/login',
    });
    expect(workos.send).toHaveBeenCalledWith('person@example.com', 'workos-org-1', 'local-inv-1');
    expect(controlPlane.markInvitationDelivered).toHaveBeenCalledWith(
      'local-inv-1',
      'workos-inv-1',
      new Date('2026-08-11T10:00:00.000Z'),
      expect.any(Date),
    );
  });

  it('lazily creates the WorkOS organization and associates the existing owner', async () => {
    const { service, controlPlane, workos } = harness(true);
    controlPlane.getWorkspaceById.mockResolvedValue({
      id: 'ws-1',
      name: 'Workspace One',
      workosOrganizationId: null,
    });

    await service.inviteMember('ws-1', 'admin-1', 'person@example.com');

    expect(workos.ensureOrganization).toHaveBeenCalledWith('ws-1', 'Workspace One');
    expect(workos.ensureOrganizationMembership).toHaveBeenCalledWith('workos-org-1', 'workos-owner-1');
    expect(controlPlane.setWorkspaceWorkosOrganizationId).toHaveBeenCalledWith('ws-1', 'workos-org-1');
    expect(workos.send).toHaveBeenCalledWith('person@example.com', 'workos-org-1', 'local-inv-1');
  });

  it('does not reserve pending access when WorkOS organization preparation fails', async () => {
    const { service, controlPlane, workos } = harness(true);
    controlPlane.getWorkspaceById.mockResolvedValue({
      id: 'ws-1',
      name: 'Workspace One',
      workosOrganizationId: null,
    });
    workos.ensureOrganization.mockRejectedValue(new Error('provider unavailable'));

    await expect(service.inviteMember('ws-1', 'admin-1', 'person@example.com')).rejects.toBeInstanceOf(
      BadGatewayException,
    );
    expect(controlPlane.createPendingInvitation).not.toHaveBeenCalled();
  });

  it('creates pending access without calling WorkOS for GitHub/on-prem deployments', async () => {
    const { service, controlPlane, workos } = harness(false);

    await expect(service.inviteMember('ws-1', 'admin-1', 'person@example.com')).resolves.toEqual({
      invited: true,
      emailSent: false,
      expiresAt: '2026-08-18T10:00:00.000Z',
      signInUrl: 'https://coredoc.example.com/api/v1/auth/web/login',
    });
    expect(workos.send).not.toHaveBeenCalled();
    expect(controlPlane.removePendingInvitation).not.toHaveBeenCalled();
    expect(workos.ensureOrganization).not.toHaveBeenCalled();
  });

  it('removes an active WorkOS organization membership when a SaaS member is removed', async () => {
    const { service, controlPlane, workos } = harness(true);
    controlPlane.getMember.mockResolvedValue({ userId: 'profile-1', role: 'member', pending: false });
    controlPlane.getWorkosIdentity.mockResolvedValue({ provider_user_id: 'workos-user-1' });

    await expect(service.removeMember('ws-1', 'profile-1')).resolves.toEqual({
      removed: true,
      providerCleanupSucceeded: true,
    });

    expect(workos.removeOrganizationMembership).toHaveBeenCalledWith('workos-org-1', 'workos-user-1');
    expect(controlPlane.removeMember).toHaveBeenCalledWith('ws-1', 'profile-1');
  });

  it('keeps local removal authoritative when WorkOS membership cleanup fails', async () => {
    const { service, controlPlane, workos } = harness(true);
    controlPlane.getMember.mockResolvedValue({ userId: 'profile-1', role: 'member', pending: false });
    controlPlane.getWorkosIdentity.mockResolvedValue({ provider_user_id: 'workos-user-1' });
    workos.removeOrganizationMembership.mockRejectedValue(new Error('provider unavailable'));

    await expect(service.removeMember('ws-1', 'profile-1')).resolves.toEqual({
      removed: true,
      providerCleanupSucceeded: false,
    });

    expect(controlPlane.removeMember).toHaveBeenCalledWith('ws-1', 'profile-1');
  });

  it('removes the local pending grant when initial WorkOS delivery fails', async () => {
    const { service, controlPlane, workos } = harness(true);
    workos.send.mockRejectedValue(new Error('provider unavailable'));

    await expect(service.inviteMember('ws-1', 'admin-1', 'person@example.com')).rejects.toBeInstanceOf(
      BadGatewayException,
    );
    expect(controlPlane.removePendingInvitation).toHaveBeenCalledWith('ws-1', 'local-inv-1');
  });

  it('keeps the stable local operation id after an ambiguous WorkOS transport failure', async () => {
    const { service, controlPlane, workos } = harness(true);
    workos.send.mockRejectedValue(new WorkOSApiError('socket closed', undefined, true));

    await expect(service.inviteMember('ws-1', 'admin-1', 'person@example.com')).rejects.toThrow(/kept/);
    expect(controlPlane.removePendingInvitation).not.toHaveBeenCalled();
  });

  it('rolls back pending access when WorkOS returns a malformed response', async () => {
    const { service, controlPlane, workos } = harness(true);
    workos.send.mockRejectedValue(new WorkOSApiError('WorkOS invitation response is missing id'));

    await expect(service.inviteMember('ws-1', 'admin-1', 'person@example.com')).rejects.toThrow(
      /No pending workspace access was created/,
    );
    expect(controlPlane.removePendingInvitation).toHaveBeenCalledWith('ws-1', 'local-inv-1');
  });

  it('projects sent and expired lifecycle state without exposing the WorkOS invitation id', async () => {
    const { service, controlPlane } = harness(true);
    controlPlane.listPendingInvitations.mockResolvedValue([
      pendingInvitation({
        workosInvitationId: 'secret-provider-id',
        expiresAt: new Date('2020-01-01T00:00:00.000Z'),
        lastSentAt: new Date('2026-08-04T10:01:00.000Z'),
      }),
    ]);

    const [result] = await service.listPendingInvites('ws-1');

    expect(result).toMatchObject({ id: 'local-inv-1', state: 'expired', emailSent: true });
    expect(result).not.toHaveProperty('workosInvitationId');
  });

  it('projects a stale null-expiry manual invitation as expired', async () => {
    const { service, controlPlane } = harness(false);
    controlPlane.listPendingInvitations.mockResolvedValue([
      pendingInvitation({ createdAt: new Date('2020-01-01T00:00:00.000Z') }),
    ]);

    const [result] = await service.listPendingInvites('ws-1');
    expect(result).toMatchObject({ state: 'expired', expiresAt: new Date('2020-01-15T00:00:00.000Z') });
  });

  it('returns the manual sign-in fallback when resend is requested without WorkOS', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-05T12:00:00.000Z'));
    const { service, controlPlane, workos } = harness(false);

    await expect(service.resendInvite('ws-1', 'local-inv-1')).resolves.toEqual({
      resent: false,
      emailSent: false,
      expiresAt: '2026-08-19T12:00:00.000Z',
      signInUrl: 'https://coredoc.example.com/api/v1/auth/web/login',
    });
    expect(controlPlane.renewManualInvitation).toHaveBeenCalledWith(
      'ws-1',
      'local-inv-1',
      new Date('2026-08-05T12:00:00.000Z'),
    );
    expect(workos.resend).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('revokes the last referenced WorkOS invitation before deleting local pending access', async () => {
    const { service, controlPlane, workos } = harness(true);
    controlPlane.getPendingInvitation.mockResolvedValue(pendingInvitation({ workosInvitationId: 'workos-inv-1' }));

    await expect(service.revokeInvite('ws-1', 'local-inv-1')).resolves.toEqual({
      revoked: true,
      emailRevoked: true,
    });
    expect(workos.revoke).toHaveBeenCalledWith('workos-inv-1');
    expect(controlPlane.removePendingInvitation).toHaveBeenCalledWith('ws-1', 'local-inv-1');
  });

  it('revokes local pending access even when WorkOS cleanup fails', async () => {
    const { service, controlPlane, workos } = harness(true);
    controlPlane.getPendingInvitation.mockResolvedValue(pendingInvitation({ workosInvitationId: 'workos-inv-1' }));
    workos.revoke.mockRejectedValue(new Error('provider unavailable'));

    await expect(service.revokeInvite('ws-1', 'local-inv-1')).resolves.toEqual({
      revoked: true,
      emailRevoked: false,
    });
    expect(controlPlane.removePendingInvitation).toHaveBeenCalledWith('ws-1', 'local-inv-1');
  });

  it('revokes the WorkOS invitation when a pending member is removed via the members route', async () => {
    // GET /members is unfiltered and includes pending placeholders, so deleting
    // one here is a normal admin action and must not orphan the invitation.
    const { service, controlPlane, workos } = harness(true);
    controlPlane.getMember.mockResolvedValue({ userId: 'pending:person@example.com', role: 'member', pending: true });
    controlPlane.getInvitationForMember.mockResolvedValue(pendingInvitation({ workosInvitationId: 'workos-inv-1' }));

    await expect(service.removeMember('ws-1', 'pending:person@example.com')).resolves.toEqual({
      removed: true,
      providerCleanupSucceeded: true,
    });

    expect(workos.revoke).toHaveBeenCalledWith('workos-inv-1');
    expect(workos.removeOrganizationMembership).not.toHaveBeenCalled();
    expect(controlPlane.removeMember).toHaveBeenCalledWith('ws-1', 'pending:person@example.com');
  });

  it('removes a pending member locally when its WorkOS invitation cannot be revoked', async () => {
    const { service, controlPlane, workos } = harness(true);
    controlPlane.getMember.mockResolvedValue({ userId: 'pending:person@example.com', role: 'member', pending: true });
    controlPlane.getInvitationForMember.mockResolvedValue(pendingInvitation({ workosInvitationId: 'workos-inv-1' }));
    workos.revoke.mockRejectedValue(new Error('provider unavailable'));

    await expect(service.removeMember('ws-1', 'pending:person@example.com')).resolves.toEqual({
      removed: true,
      providerCleanupSucceeded: false,
    });
    expect(controlPlane.removeMember).toHaveBeenCalledWith('ws-1', 'pending:person@example.com');
  });

  it('rejects an invite that cannot pass the configured login-domain policy', async () => {
    process.env.ALLOWED_EMAIL_DOMAINS = 'example.com';
    const { service, controlPlane } = harness(false);
    await expect(service.inviteMember('ws-1', 'admin-1', 'person@outside.test')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(controlPlane.createPendingInvitation).not.toHaveBeenCalled();
  });

  it('rejects resend when the configured login-domain policy no longer allows the invitee', async () => {
    process.env.ALLOWED_EMAIL_DOMAINS = 'example.com';
    const { service, controlPlane, workos } = harness(true);
    controlPlane.getPendingInvitation.mockResolvedValue(
      pendingInvitation({ member: { ...pendingInvitation().member, email: 'person@outside.test' } }),
    );

    await expect(service.resendInvite('ws-1', 'local-inv-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(workos.resend).not.toHaveBeenCalled();
    expect(workos.send).not.toHaveBeenCalled();
  });
});
