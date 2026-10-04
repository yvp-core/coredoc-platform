import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { WorkspacesService } from './workspaces.service.js';
import type { ControlPlaneService } from '../../database/control-plane.service.js';
import type { WorkOSInvitationsService } from '../../auth/workos-invitations.service.js';
import { IntentReleaseTrigger } from '../../generated/prisma/client.js';
import type { IntentConfig } from '../../config/app-config.js';
import { WorkspaceMemberRole } from '../members/dto/workspace-role.enum.js';

function createMockControlPlane() {
  return {
    listWorkspacesForUser: vi.fn(),
    linkPendingMemberships: vi.fn().mockResolvedValue(undefined),
    getWorkspaceById: vi.fn(),
    createWorkspace: vi.fn(),
    addMember: vi.fn(),
    updateWorkspace: vi.fn(),
    deleteWorkspace: vi.fn(),
  };
}

describe('WorkspacesService', () => {
  let service: WorkspacesService;
  let controlPlane: ReturnType<typeof createMockControlPlane>;
  let workos: {
    isEnabled: ReturnType<typeof vi.fn>;
    deleteOrganization: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    controlPlane = createMockControlPlane();
    workos = {
      isEnabled: vi.fn().mockReturnValue(false),
      deleteOrganization: vi.fn().mockResolvedValue(undefined),
    };
    service = new WorkspacesService(
      controlPlane as unknown as ControlPlaneService,
      workos as unknown as WorkOSInvitationsService,
      {},
    );
  });

  afterEach(() => {
    delete process.env.MCP_SERVER_URL;
    delete process.env.SERVER_URL;
  });

  describe('getUserWorkspaces', () => {
    it('returns workspaces with role for the given user', async () => {
      const workspaces = [
        {
          id: 'ws_1',
          name: 'Workspace One',
          slug: 'workspace-one',
          role: 'admin',
          intentEnabled: true,
          retainGraphArtifacts: true,
        },
      ];
      controlPlane.listWorkspacesForUser.mockResolvedValue(workspaces);

      const result = await service.getUserWorkspaces({ id: 'user_1', email: 'a@b.com' });

      expect(result).toEqual([
        { id: 'ws_1', name: 'Workspace One', slug: 'workspace-one', role: 'admin', intentEnabled: true },
      ]);
      expect(controlPlane.linkPendingMemberships).toHaveBeenCalledWith({ id: 'user_1', email: 'a@b.com' });
      expect(controlPlane.listWorkspacesForUser).toHaveBeenCalledWith('user_1');
    });
  });

  describe('getWorkspace', () => {
    it('returns a workspace by id', async () => {
      const workspace = { id: 'ws_1', name: 'Workspace One', slug: 'workspace-one', intentEnabled: true };
      controlPlane.getWorkspaceById.mockResolvedValue(workspace);

      const result = await service.getWorkspace('ws_1', 'member');

      // Plus the capability advertisement batch-sync clients key on.
      expect(result).toEqual({ ...workspace, capabilities: { batchResolveTargets: true } });
    });

    it('does not expose the internal WorkOS organization mapping', async () => {
      controlPlane.getWorkspaceById.mockResolvedValue({
        id: 'ws_1',
        name: 'Workspace One',
        slug: 'workspace-one',
        workosOrganizationId: 'org_secret',
        retainGraphArtifacts: true,
      });

      const result = await service.getWorkspace('ws_1');

      expect(result).not.toHaveProperty('workosOrganizationId');
      expect(result).not.toHaveProperty('retainGraphArtifacts');
    });

    it('throws NotFoundException when workspace does not exist', async () => {
      controlPlane.getWorkspaceById.mockResolvedValue(null);

      await expect(service.getWorkspace('missing')).rejects.toThrow(NotFoundException);
    });
  });

  describe('intentEnabled under the temporary INTENT_ROLES rollout', () => {
    const PRODUCT_FIRST: IntentConfig = {
      rolloutRoles: [WorkspaceMemberRole.Owner, WorkspaceMemberRole.Admin, WorkspaceMemberRole.Product],
    };

    function rolloutService(intent: IntentConfig) {
      return new WorkspacesService(
        controlPlane as unknown as ControlPlaneService,
        workos as unknown as WorkOSInvitationsService,
        intent,
      );
    }

    it("reports each workspace per the caller's role in it (GET /workspaces, the desktop Intent tab)", async () => {
      controlPlane.listWorkspacesForUser.mockResolvedValue([
        { id: 'ws_pm', name: 'A', slug: 'a', role: 'product', intentEnabled: true },
        { id: 'ws_dev', name: 'B', slug: 'b', role: 'member', intentEnabled: true },
        { id: 'ws_off', name: 'C', slug: 'c', role: 'owner', intentEnabled: false },
      ]);

      const result = await rolloutService(PRODUCT_FIRST).getUserWorkspaces({ id: 'user_1', email: 'a@b.com' });

      expect(result.map((w) => [w.id, w.intentEnabled])).toEqual([
        ['ws_pm', true],
        ['ws_dev', false],
        ['ws_off', false],
      ]);
    });

    it('passes the stored flag through for every role when INTENT_ROLES is unset', async () => {
      controlPlane.listWorkspacesForUser.mockResolvedValue([
        { id: 'ws_dev', name: 'B', slug: 'b', role: 'member', intentEnabled: true },
      ]);

      const result = await rolloutService({}).getUserWorkspaces({ id: 'user_1', email: 'a@b.com' });

      expect(result[0]?.intentEnabled).toBe(true);
    });

    it('narrows GET /workspaces/:id by the actor role, failing closed without one', async () => {
      controlPlane.getWorkspaceById.mockResolvedValue({ id: 'ws_1', name: 'A', slug: 'a', intentEnabled: true });
      const service = rolloutService(PRODUCT_FIRST);

      expect((await service.getWorkspace('ws_1', 'admin')).intentEnabled).toBe(true);
      expect((await service.getWorkspace('ws_1', 'member')).intentEnabled).toBe(false);
      expect((await service.getWorkspace('ws_1')).intentEnabled).toBe(false);
    });
  });

  describe('getMcpConfig', () => {
    // Fix wave (I1): getMcpConfig must use the shared serverUrl() helper
    // (auth/oauth/server-url.ts), not a bare process.env.MCP_SERVER_URL read
    // — the bare read produced a truthy "undefined/api/..." URL whenever only
    // SERVER_URL was configured (MCP_SERVER_URL unset).
    it('builds the mcp url from MCP_SERVER_URL when set', async () => {
      process.env.MCP_SERVER_URL = 'https://mcp.example.com';
      delete process.env.SERVER_URL;
      controlPlane.getWorkspaceById.mockResolvedValue({ id: 'ws_1', name: 'W', slug: 'w' });

      const result = await service.getMcpConfig('ws_1');

      expect(result).toEqual({
        mcpServers: {
          coredoc: {
            url: 'https://mcp.example.com/api/v1/workspaces/ws_1/mcp',
            type: 'http',
          },
        },
      });
    });

    it('falls back to SERVER_URL when MCP_SERVER_URL is unset — never "undefined/..."', async () => {
      delete process.env.MCP_SERVER_URL;
      process.env.SERVER_URL = 'https://api.example.com';
      controlPlane.getWorkspaceById.mockResolvedValue({ id: 'ws_1', name: 'W', slug: 'w' });

      const result = await service.getMcpConfig('ws_1');

      const url = (result.mcpServers as Record<string, { url: string }>).coredoc.url;
      expect(url).toBe('https://api.example.com/api/v1/workspaces/ws_1/mcp');
      expect(url).not.toContain('undefined');
    });

    it('falls back to localhost:3000 when neither env var is set', async () => {
      delete process.env.MCP_SERVER_URL;
      delete process.env.SERVER_URL;
      controlPlane.getWorkspaceById.mockResolvedValue({ id: 'ws_1', name: 'W', slug: 'w' });

      const result = await service.getMcpConfig('ws_1');

      const url = (result.mcpServers as Record<string, { url: string }>).coredoc.url;
      expect(url).toBe('http://localhost:3000/api/v1/workspaces/ws_1/mcp');
    });

    it('throws NotFoundException when workspace does not exist', async () => {
      controlPlane.getWorkspaceById.mockResolvedValue(null);

      await expect(service.getMcpConfig('missing')).rejects.toThrow(NotFoundException);
    });
  });

  describe('createWorkspace', () => {
    it('creates a local workspace and adds the creator as owner', async () => {
      const workspace = { id: 'ws_1', name: 'New Workspace', slug: 'new-workspace' };
      controlPlane.createWorkspace.mockResolvedValue(workspace);

      const result = await service.createWorkspace('profile_abc', 'user@example.com', 'User One', {
        name: 'New Workspace',
        slug: 'new-workspace',
      });

      expect(result).toEqual(workspace);
      expect(controlPlane.createWorkspace).toHaveBeenCalledWith('New Workspace', 'new-workspace');
      expect(controlPlane.addMember).toHaveBeenCalledWith(
        'ws_1',
        'profile_abc',
        'user@example.com',
        'owner',
        'User One',
      );
    });
  });

  describe('updateWorkspace', () => {
    it('updates a workspace name', async () => {
      const workspace = { id: 'ws_1', name: 'Old Name', slug: 'workspace-one' };
      controlPlane.getWorkspaceById.mockResolvedValue(workspace);
      controlPlane.updateWorkspace.mockResolvedValue({
        ...workspace,
        name: 'New Name',
        retainGraphArtifacts: true,
      });

      const result = await service.updateWorkspace('ws_1', { name: 'New Name' });

      expect(controlPlane.updateWorkspace).toHaveBeenCalledWith('ws_1', { name: 'New Name' });
      expect(result!.name).toBe('New Name');
      expect(result).not.toHaveProperty('retainGraphArtifacts');
    });

    it('passes the release trigger through — the only way a workspace leaves `manual`', async () => {
      const workspace = { id: 'ws_1', name: 'W', slug: 'w' };
      controlPlane.getWorkspaceById.mockResolvedValue(workspace);
      controlPlane.updateWorkspace.mockResolvedValue({ ...workspace, intentReleaseTrigger: 'deploy' });

      const result = await service.updateWorkspace('ws_1', { intentReleaseTrigger: IntentReleaseTrigger.deploy });

      expect(controlPlane.updateWorkspace).toHaveBeenCalledWith('ws_1', { intentReleaseTrigger: 'deploy' });
      expect(result).toMatchObject({ intentReleaseTrigger: 'deploy' });
    });

    it('throws NotFoundException when workspace does not exist', async () => {
      controlPlane.getWorkspaceById.mockResolvedValue(null);

      await expect(service.updateWorkspace('missing', { name: 'X' })).rejects.toThrow(NotFoundException);
    });

    it('sends empty updates when no fields provided', async () => {
      const workspace = { id: 'ws_1', name: 'Name', slug: 'slug' };
      controlPlane.getWorkspaceById.mockResolvedValue(workspace);
      controlPlane.updateWorkspace.mockResolvedValue(workspace);

      await service.updateWorkspace('ws_1', {});

      expect(controlPlane.updateWorkspace).toHaveBeenCalledWith('ws_1', {});
    });
  });

  describe('deleteWorkspace', () => {
    it('deletes a workspace', async () => {
      controlPlane.getWorkspaceById.mockResolvedValue({ id: 'ws_1' });

      const result = await service.deleteWorkspace('ws_1');

      expect(result).toEqual({ deleted: true });
      expect(controlPlane.deleteWorkspace).toHaveBeenCalledWith('ws_1');
      expect(workos.deleteOrganization).not.toHaveBeenCalled();
    });

    it('deletes the mapped WorkOS organization before the local SaaS workspace', async () => {
      workos.isEnabled.mockReturnValue(true);
      controlPlane.getWorkspaceById.mockResolvedValue({ id: 'ws_1', workosOrganizationId: 'org_1' });

      await expect(service.deleteWorkspace('ws_1')).resolves.toEqual({ deleted: true });

      expect(workos.deleteOrganization).toHaveBeenCalledWith('org_1');
      expect(workos.deleteOrganization.mock.invocationCallOrder[0]).toBeLessThan(
        controlPlane.deleteWorkspace.mock.invocationCallOrder[0],
      );
    });

    it('preserves the local mapping when WorkOS organization deletion fails', async () => {
      workos.isEnabled.mockReturnValue(true);
      workos.deleteOrganization.mockRejectedValue(new Error('provider unavailable'));
      controlPlane.getWorkspaceById.mockResolvedValue({ id: 'ws_1', workosOrganizationId: 'org_1' });

      await expect(service.deleteWorkspace('ws_1')).rejects.toThrow(/WorkOS organization remains active/);

      expect(controlPlane.deleteWorkspace).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when workspace does not exist', async () => {
      controlPlane.getWorkspaceById.mockResolvedValue(null);

      await expect(service.deleteWorkspace('missing')).rejects.toThrow(NotFoundException);
    });
  });

  describe('enableCloud', () => {
    it('persists isCloud=true and passes ciCdEnabled when provided', async () => {
      const workspace = { id: 'ws_1', name: 'W', slug: 'w', isCloud: false, ciCdEnabled: false };
      controlPlane.getWorkspaceById.mockResolvedValue(workspace);
      controlPlane.updateWorkspace.mockResolvedValue({ ...workspace, isCloud: true, ciCdEnabled: true });

      const result = await service.enableCloud('ws_1', { ciCdEnabled: true });

      expect(controlPlane.updateWorkspace).toHaveBeenCalledWith('ws_1', { isCloud: true, ciCdEnabled: true });
      expect(result).toMatchObject({ isCloud: true, ciCdEnabled: true });
    });

    it('persists isCloud=true and omits ciCdEnabled when not provided', async () => {
      const workspace = { id: 'ws_1', name: 'W', slug: 'w', isCloud: false, ciCdEnabled: false };
      controlPlane.getWorkspaceById.mockResolvedValue(workspace);
      controlPlane.updateWorkspace.mockResolvedValue({ ...workspace, isCloud: true });

      await service.enableCloud('ws_1');

      expect(controlPlane.updateWorkspace).toHaveBeenCalledWith('ws_1', { isCloud: true });
    });

    it('throws NotFoundException when workspace does not exist', async () => {
      controlPlane.getWorkspaceById.mockResolvedValue(null);

      await expect(service.enableCloud('missing', { ciCdEnabled: true })).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateWorkspace with ciCdEnabled', () => {
    it('forwards ciCdEnabled=true', async () => {
      const workspace = { id: 'ws_1', name: 'W', slug: 'w', ciCdEnabled: false };
      controlPlane.getWorkspaceById.mockResolvedValue(workspace);
      controlPlane.updateWorkspace.mockResolvedValue({ ...workspace, ciCdEnabled: true });

      const result = await service.updateWorkspace('ws_1', { ciCdEnabled: true });

      expect(controlPlane.updateWorkspace).toHaveBeenCalledWith('ws_1', { ciCdEnabled: true });
      expect(result).toMatchObject({ ciCdEnabled: true });
    });
  });
});
