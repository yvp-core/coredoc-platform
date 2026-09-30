import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TelemetryTokenController } from './telemetry-token.controller.js';
import type { TokensService } from './tokens.service.js';
import type { AuthUser } from '../../auth/decorators/current-user.decorator.js';

const user: AuthUser = { id: 'user_1', email: 'a@b.com' };

function mockService() {
  return {
    createToken: vi.fn().mockResolvedValue({
      id: 't',
      name: 'otel:host',
      token: 'cdt_x',
      permissions: ['telemetry:write'],
      expiresAt: null,
      createdAt: new Date('2026-01-01'),
    }),
    rotateInstallationToken: vi.fn().mockResolvedValue({
      id: 'installation-token',
      name: 'capture-agent:11111111-1111-4111-8111-111111111111',
      token: 'cdt_installation',
      permissions: ['telemetry:write'],
      expiresAt: null,
      createdAt: new Date('2026-01-01'),
    }),
    listInstallationTokens: vi.fn().mockResolvedValue([
      {
        id: 'installation-token',
        name: 'capture-agent:11111111-1111-4111-8111-111111111111',
        tokenPrefix: 'cdt_install',
        expiresAt: null,
        createdAt: new Date('2026-01-01'),
        lastUsedAt: null,
      },
    ]),
    revokeInstallationToken: vi.fn().mockResolvedValue(undefined),
    listOwnedTelemetryTokens: vi.fn().mockResolvedValue([
      {
        id: '22222222-2222-4222-8222-222222222222',
        name: 'otel:legacy',
        tokenPrefix: 'cdt_legacy00',
        expiresAt: null,
        createdAt: new Date('2026-01-01'),
        lastUsedAt: null,
      },
    ]),
    revokeOwnedTelemetryToken: vi.fn().mockResolvedValue(undefined),
  };
}

describe('TelemetryTokenController.mint', () => {
  let svc: ReturnType<typeof mockService>;
  let controller: TelemetryTokenController;
  beforeEach(() => {
    svc = mockService();
    controller = new TelemetryTokenController(svc as unknown as TokensService);
  });

  it('creates or rotates an installation token and returns its revocation metadata', async () => {
    const installationId = '11111111-1111-4111-8111-111111111111';

    const result = await controller.putInstallation('ws_1', installationId, user);

    expect(svc.rotateInstallationToken).toHaveBeenCalledWith('ws_1', installationId, 'user_1');
    expect(result).toEqual({
      id: 'installation-token',
      name: `capture-agent:${installationId}`,
      token: 'cdt_installation',
      createdAt: new Date('2026-01-01'),
      expiresAt: null,
    });
  });

  it('lists only installation metadata for the authenticated principal', async () => {
    await expect(controller.listInstallations('ws_1', user)).resolves.toEqual([
      expect.objectContaining({ id: 'installation-token', tokenPrefix: 'cdt_install' }),
    ]);
    expect(svc.listInstallationTokens).toHaveBeenCalledWith('ws_1', 'user_1');
  });

  it('revokes an installation token under the authenticated principal', async () => {
    const installationId = '11111111-1111-4111-8111-111111111111';

    await expect(controller.deleteInstallation('ws_1', installationId, user)).resolves.toBeUndefined();
    expect(svc.revokeInstallationToken).toHaveBeenCalledWith('ws_1', installationId, 'user_1');
  });

  it('lists caller-owned telemetry metadata for marker-safe legacy migration', async () => {
    await expect(controller.listOwned('ws_1', user)).resolves.toEqual([
      expect.objectContaining({ name: 'otel:legacy', tokenPrefix: 'cdt_legacy00' }),
    ]);
    expect(svc.listOwnedTelemetryTokens).toHaveBeenCalledWith('ws_1', 'user_1');
  });

  it('revokes a caller-owned legacy token by ID', async () => {
    const tokenId = '22222222-2222-4222-8222-222222222222';

    await expect(controller.deleteOwned('ws_1', tokenId, user)).resolves.toBeUndefined();
    expect(svc.revokeOwnedTelemetryToken).toHaveBeenCalledWith('ws_1', tokenId, 'user_1');
  });

  it('mints with the telemetry permission set, forced server-side', async () => {
    await controller.mint('ws_1', { name: 'otel:host' }, user);
    expect(svc.createToken.mock.calls[0][4]).toEqual(['telemetry:write']);
  });

  it('owns the token to the authenticated principal', async () => {
    await controller.mint('ws_1', { name: 'otel:host' }, user);
    expect(svc.createToken.mock.calls[0][2]).toBe('user_1');
  });

  it('defaults the name to "otel" when none is given', async () => {
    await controller.mint('ws_1', {}, user);
    expect(svc.createToken.mock.calls[0][1]).toBe('otel');
  });

  it('returns only the plaintext token', async () => {
    const res = await controller.mint('ws_1', { name: 'otel:host' }, user);
    expect(res).toEqual({ token: 'cdt_x' });
  });

  it('returns each freshly created token without caching or adding secret-shaped response fields', async () => {
    svc.createToken
      .mockResolvedValueOnce({
        id: 't1',
        name: 'otel:host:first',
        token: 'cdt_fresh_one',
        permissions: ['telemetry:write'],
        expiresAt: null,
        createdAt: new Date('2026-01-01'),
      })
      .mockResolvedValueOnce({
        id: 't2',
        name: 'otel:host:second',
        token: 'cdt_fresh_two',
        permissions: ['telemetry:write'],
        expiresAt: null,
        createdAt: new Date('2026-01-01'),
      });

    await expect(controller.mint('ws_1', { name: 'otel:host:first' }, user)).resolves.toEqual({
      token: 'cdt_fresh_one',
    });
    await expect(controller.mint('ws_1', { name: 'otel:host:second' }, user)).resolves.toEqual({
      token: 'cdt_fresh_two',
    });
    expect(svc.createToken).toHaveBeenCalledTimes(2);
  });
});
