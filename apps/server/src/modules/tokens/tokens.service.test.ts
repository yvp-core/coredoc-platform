import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { TokensService } from './tokens.service.js';
import { TokenPermission } from '../../auth/permissions.guard.js';
import type { ControlPlaneService } from '../../database/control-plane.service.js';

vi.mock('../../database/encryption.js', () => ({
  encrypt: vi.fn((plaintext: string) => `encrypted:${plaintext}`),
  decrypt: vi.fn((ciphertext: string) => ciphertext.replace('encrypted:', '')),
  isEncryptionAvailable: vi.fn(() => true),
}));

function createMockControlPlane() {
  return {
    createServiceToken: vi.fn(),
    getServiceToken: vi.fn(),
    listServiceTokens: vi.fn(),
    deleteServiceToken: vi.fn(),
    replaceInstallationTelemetryToken: vi.fn(),
    deleteInstallationTelemetryToken: vi.fn(),
    deleteOwnedTelemetryToken: vi.fn(),
  };
}

describe('TokensService', () => {
  let service: TokensService;
  let controlPlane: ReturnType<typeof createMockControlPlane>;

  beforeEach(() => {
    controlPlane = createMockControlPlane();
    service = new TokensService(controlPlane as unknown as ControlPlaneService);
  });

  describe('installation telemetry tokens', () => {
    const installationId = '11111111-1111-4111-8111-111111111111';

    it('creates or rotates one exact-purpose token under a server-derived name', async () => {
      controlPlane.replaceInstallationTelemetryToken.mockImplementation(
        (opts: { name: string; permissions: string[]; tokenHash: string; tokenPrefix: string }) =>
          Promise.resolve({
            kind: 'replaced',
            token: {
              id: 'tok_install',
              name: opts.name,
              permissions: opts.permissions,
              expiresAt: null,
              createdAt: new Date('2026-01-01'),
            },
          }),
      );

      const result = await service.rotateInstallationToken('ws_1', installationId, 'user_1');

      expect(result).toMatchObject({
        id: 'tok_install',
        name: `capture-agent:${installationId}`,
        permissions: ['telemetry:write'],
      });
      expect(result.token).toMatch(/^cdt_[0-9a-f]{64}$/);
      expect(controlPlane.replaceInstallationTelemetryToken).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: 'ws_1',
          name: `capture-agent:${installationId}`,
          createdBy: 'user_1',
          permissions: ['telemetry:write'],
          tokenEncrypted: null,
          lastUsedAt: null,
        }),
      );
    });

    it('rejects a non-v4 installation identifier before touching storage', async () => {
      await expect(service.rotateInstallationToken('ws_1', 'not-a-uuid', 'user_1')).rejects.toThrow(
        BadRequestException,
      );
      expect(controlPlane.replaceInstallationTelemetryToken).not.toHaveBeenCalled();
    });

    it('fails closed when the derived name belongs to another actor or purpose', async () => {
      controlPlane.replaceInstallationTelemetryToken.mockResolvedValue({ kind: 'conflict' });

      await expect(service.rotateInstallationToken('ws_1', installationId, 'user_1')).rejects.toThrow(
        ConflictException,
      );
    });

    it('lists only the caller-owned exact-purpose installation tokens without secrets', async () => {
      controlPlane.listServiceTokens.mockResolvedValue([
        {
          id: 'mine',
          name: `capture-agent:${installationId}`,
          tokenPrefix: 'cdt_aaaaaaaa',
          permissions: ['telemetry:write'],
          expiresAt: null,
          createdBy: 'user_1',
          createdAt: new Date('2026-01-01'),
          lastUsedAt: null,
        },
        {
          id: 'foreign',
          name: 'capture-agent:22222222-2222-4222-8222-222222222222',
          tokenPrefix: 'cdt_bbbbbbbb',
          permissions: ['telemetry:write'],
          expiresAt: null,
          createdBy: 'user_2',
          createdAt: new Date('2026-01-01'),
          lastUsedAt: null,
        },
        {
          id: 'wrong-purpose',
          name: 'capture-agent:33333333-3333-4333-8333-333333333333',
          tokenPrefix: 'cdt_cccccccc',
          permissions: ['parser:read'],
          expiresAt: null,
          createdBy: 'user_1',
          createdAt: new Date('2026-01-01'),
          lastUsedAt: null,
        },
      ]);

      const result = await service.listInstallationTokens('ws_1', 'user_1');

      expect(result).toEqual([
        {
          id: 'mine',
          name: `capture-agent:${installationId}`,
          tokenPrefix: 'cdt_aaaaaaaa',
          expiresAt: null,
          createdAt: new Date('2026-01-01'),
          lastUsedAt: null,
        },
      ]);
      expect(JSON.stringify(result)).not.toContain('permissions');
    });

    it('revokes only the caller-owned exact-purpose installation token', async () => {
      controlPlane.deleteInstallationTelemetryToken.mockResolvedValue(true);

      await expect(service.revokeInstallationToken('ws_1', installationId, 'user_1')).resolves.toBeUndefined();
      expect(controlPlane.deleteInstallationTelemetryToken).toHaveBeenCalledWith({
        workspaceId: 'ws_1',
        name: `capture-agent:${installationId}`,
        createdBy: 'user_1',
        permissions: ['telemetry:write'],
      });
    });

    it('does not disclose whether a missing installation token is foreign or wrong-purpose', async () => {
      controlPlane.deleteInstallationTelemetryToken.mockResolvedValue(false);

      await expect(service.revokeInstallationToken('ws_1', installationId, 'user_1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('owned telemetry cleanup', () => {
    it('lists legacy and installation telemetry metadata owned by the caller', async () => {
      controlPlane.listServiceTokens.mockResolvedValue([
        {
          id: '11111111-1111-4111-8111-111111111111',
          name: 'otel:legacy-repo',
          tokenPrefix: 'cdt_legacy00',
          permissions: ['telemetry:write'],
          expiresAt: null,
          createdBy: 'user_1',
          createdAt: new Date('2026-01-01'),
          lastUsedAt: null,
        },
        {
          id: '22222222-2222-4222-8222-222222222222',
          name: 'ci',
          tokenPrefix: 'cdt_ci000000',
          permissions: ['parser:read'],
          expiresAt: null,
          createdBy: 'user_1',
          createdAt: new Date('2026-01-01'),
          lastUsedAt: null,
        },
      ]);

      await expect(service.listOwnedTelemetryTokens('ws_1', 'user_1')).resolves.toEqual([
        expect.objectContaining({
          id: '11111111-1111-4111-8111-111111111111',
          name: 'otel:legacy-repo',
          tokenPrefix: 'cdt_legacy00',
        }),
      ]);
    });

    it('revokes an owned exact-purpose token by opaque ID without disclosing misses', async () => {
      const tokenId = '11111111-1111-4111-8111-111111111111';
      controlPlane.deleteOwnedTelemetryToken.mockResolvedValue(true);

      await expect(service.revokeOwnedTelemetryToken('ws_1', tokenId, 'user_1')).resolves.toBeUndefined();
      expect(controlPlane.deleteOwnedTelemetryToken).toHaveBeenCalledWith({
        workspaceId: 'ws_1',
        tokenId,
        createdBy: 'user_1',
        permissions: ['telemetry:write'],
      });

      controlPlane.deleteOwnedTelemetryToken.mockResolvedValue(false);
      await expect(service.revokeOwnedTelemetryToken('ws_1', tokenId, 'user_1')).rejects.toThrow(NotFoundException);
    });

    it('rejects an invalid token ID before storage access', async () => {
      await expect(service.revokeOwnedTelemetryToken('ws_1', 'not-a-uuid', 'user_1')).rejects.toThrow(
        BadRequestException,
      );
      expect(controlPlane.deleteOwnedTelemetryToken).not.toHaveBeenCalled();
    });
  });

  describe('createToken', () => {
    it('creates a token with cdt_ prefix, predefined CI permissions, and returns plaintext once', async () => {
      controlPlane.createServiceToken.mockImplementation(
        (opts: { name: string; permissions?: string[]; expiresAt?: Date }) =>
          Promise.resolve({
            id: 'tok_1',
            name: opts.name,
            permissions: opts.permissions ?? [],
            expiresAt: opts.expiresAt ?? null,
            createdAt: new Date('2026-01-01'),
          }),
      );

      const result = await service.createToken('ws_1', 'ci-push', 'user_1');

      expect(result.token).toMatch(/^cdt_[0-9a-f]{64}$/);
      expect(result.name).toBe('ci-push');
      expect(result.id).toBe('tok_1');
      // Permissions are predefined for CI/CD
      expect(result.permissions).toEqual([
        'parser:read',
        'parser:write',
        'result:read',
        'result:write',
        'repo:push',
        'intent:release',
        'intent:bindings',
      ]);

      // Verify hash (not plaintext) was stored
      const opts = controlPlane.createServiceToken.mock.calls[0][0];
      expect(opts.tokenHash).not.toBe(result.token);
      expect(opts.tokenHash).toHaveLength(64); // SHA-256 hex

      // Verify predefined CI permissions were stored (not user-supplied)
      expect(opts.permissions).toEqual([
        'parser:read',
        'parser:write',
        'result:read',
        'result:write',
        'repo:push',
        'intent:release',
        'intent:bindings',
      ]);

      // Verify encrypted value and prefix were stored
      expect(opts.tokenEncrypted).toBe(`encrypted:${result.token}`);
      expect(opts.tokenPrefix).toBe(result.token.slice(0, 12));
    });

    it('returns a telemetry token once without persisting encrypted plaintext', async () => {
      controlPlane.createServiceToken.mockImplementation((opts: { name: string; permissions?: string[] }) =>
        Promise.resolve({
          id: 'tok_tel',
          name: opts.name,
          permissions: opts.permissions ?? [],
          expiresAt: null,
          createdAt: new Date('2026-01-01'),
        }),
      );

      const result = await service.createToken('ws_1', 'telemetry', 'user_1', undefined, [
        TokenPermission.TelemetryWrite,
      ]);

      expect(result.permissions).toEqual(['telemetry:write']);
      const opts = controlPlane.createServiceToken.mock.calls[0][0];
      expect(opts.permissions).toEqual(['telemetry:write']);
      expect(result.token).toMatch(/^cdt_[0-9a-f]{64}$/);
      expect(opts.tokenEncrypted).toBeNull();
      expect(opts.tokenHash).not.toBe(result.token);
    });

    it('throws ConflictException on duplicate name', async () => {
      controlPlane.createServiceToken.mockRejectedValue(new Error('unique constraint violated'));

      await expect(service.createToken('ws_1', 'ci-push', 'user_1')).rejects.toThrow(ConflictException);
    });

    it('re-throws non-unique errors', async () => {
      controlPlane.createServiceToken.mockRejectedValue(new Error('database connection failed'));

      await expect(service.createToken('ws_1', 'ci-push', 'user_1')).rejects.toThrow('database connection failed');
    });

    it('stores null encrypted value when encryption key is not configured', async () => {
      const { isEncryptionAvailable } = await import('../../database/encryption.js');
      vi.mocked(isEncryptionAvailable).mockReturnValueOnce(false);

      controlPlane.createServiceToken.mockImplementation((opts: { name: string; permissions?: string[] }) =>
        Promise.resolve({
          id: 'tok_2',
          name: opts.name,
          permissions: opts.permissions ?? [],
          expiresAt: null,
          createdAt: new Date('2026-01-01'),
        }),
      );

      await service.createToken('ws_1', 'dev-token', 'user_1');

      const opts = controlPlane.createServiceToken.mock.calls[0][0];
      expect(opts.tokenEncrypted).toBeNull();
    });
  });

  describe('listTokens', () => {
    it('returns tokens with prefix but without secrets', async () => {
      controlPlane.listServiceTokens.mockResolvedValue([
        {
          id: 'tok_1',
          name: 'ci-push',
          tokenPrefix: 'cdt_a1b2c3d4',
          permissions: ['push'],
          expiresAt: null,
          createdBy: 'user_1',
          createdAt: new Date('2026-01-01'),
          lastUsedAt: null,
        },
      ]);

      const result = await service.listTokens('ws_1');

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('ci-push');
      expect(result[0].tokenPrefix).toBe('cdt_a1b2c3d4');
      // Ensure no token/hash fields exposed
      expect(result[0]).not.toHaveProperty('token');
      expect(result[0]).not.toHaveProperty('tokenHash');
      expect(result[0]).not.toHaveProperty('tokenEncrypted');
    });

    it('returns null tokenPrefix for legacy tokens', async () => {
      controlPlane.listServiceTokens.mockResolvedValue([
        {
          id: 'tok_old',
          name: 'legacy',
          tokenPrefix: null,
          permissions: [],
          expiresAt: null,
          createdBy: 'user_1',
          createdAt: new Date('2025-01-01'),
          lastUsedAt: null,
        },
      ]);

      const result = await service.listTokens('ws_1');
      expect(result[0].tokenPrefix).toBeNull();
    });
  });

  describe('getTokenValue', () => {
    it('decrypts and returns the token plaintext', async () => {
      controlPlane.getServiceToken.mockResolvedValue({
        id: 'tok_1',
        tokenEncrypted: 'encrypted:cdt_abc123',
      });

      const value = await service.getTokenValue('ws_1', 'tok_1');
      expect(value).toBe('cdt_abc123');
    });

    it('returns null for legacy tokens without encrypted value', async () => {
      controlPlane.getServiceToken.mockResolvedValue({
        id: 'tok_old',
        tokenEncrypted: null,
        permissions: [],
      });

      const value = await service.getTokenValue('ws_1', 'tok_old');
      expect(value).toBeNull();
    });

    it('refuses an encrypted legacy telemetry token without exposing its bearer', async () => {
      const secret = 'cdt_legacy_telemetry_secret';
      controlPlane.getServiceToken.mockResolvedValue({
        id: 'tok_telemetry',
        tokenEncrypted: `encrypted:${secret}`,
        permissions: [TokenPermission.TelemetryWrite],
      });

      let rejection: unknown;
      try {
        await service.getTokenValue('ws_1', 'tok_telemetry');
      } catch (error) {
        rejection = error;
      }

      expect(rejection).toBeInstanceOf(ForbiddenException);
      expect(JSON.stringify(rejection)).not.toContain(secret);
    });

    it('throws NotFoundException when token does not exist', async () => {
      controlPlane.getServiceToken.mockResolvedValue(null);

      await expect(service.getTokenValue('ws_1', 'missing')).rejects.toThrow(NotFoundException);
    });
  });

  describe('revokeToken', () => {
    it('revokes an existing token', async () => {
      controlPlane.deleteServiceToken.mockResolvedValue(undefined);

      await expect(service.revokeToken('ws_1', 'tok_1')).resolves.toBeUndefined();
      expect(controlPlane.deleteServiceToken).toHaveBeenCalledWith('ws_1', 'tok_1');
    });

    it('throws NotFoundException when token does not exist', async () => {
      controlPlane.deleteServiceToken.mockRejectedValue(new Error('not found'));

      await expect(service.revokeToken('ws_1', 'missing')).rejects.toThrow(NotFoundException);
    });
  });
});
