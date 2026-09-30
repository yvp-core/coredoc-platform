import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkOSApiError, WorkOSInvitationsService } from './workos-invitations.service.js';

const originalUpstream = process.env.OAUTH_UPSTREAM;
const originalApiKey = process.env.WORKOS_API_KEY;
const originalAuthkitClientId = process.env.WORKOS_AUTHKIT_CLIENT_ID;

beforeEach(() => {
  process.env.WORKOS_AUTHKIT_CLIENT_ID = 'client_authkit_test';
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalUpstream === undefined) delete process.env.OAUTH_UPSTREAM;
  else process.env.OAUTH_UPSTREAM = originalUpstream;
  if (originalApiKey === undefined) delete process.env.WORKOS_API_KEY;
  else process.env.WORKOS_API_KEY = originalApiKey;
  if (originalAuthkitClientId === undefined) delete process.env.WORKOS_AUTHKIT_CLIENT_ID;
  else process.env.WORKOS_AUTHKIT_CLIENT_ID = originalAuthkitClientId;
});

describe('WorkOSInvitationsService', () => {
  it('is disabled for a non-WorkOS upstream and does not require an API key', () => {
    process.env.OAUTH_UPSTREAM = 'github';
    delete process.env.WORKOS_API_KEY;

    expect(new WorkOSInvitationsService().isEnabled()).toBe(false);
  });

  it('fails fast when WorkOS is selected without a server API key', () => {
    process.env.OAUTH_UPSTREAM = 'workos';
    delete process.env.WORKOS_API_KEY;

    expect(() => new WorkOSInvitationsService()).toThrow(/requires WORKOS_API_KEY/);
  });

  it('fails fast when WorkOS invitations have no AuthKit Application client id', () => {
    process.env.OAUTH_UPSTREAM = 'workos';
    process.env.WORKOS_API_KEY = 'sk_test';
    delete process.env.WORKOS_AUTHKIT_CLIENT_ID;

    expect(() => new WorkOSInvitationsService()).toThrow(/requires WORKOS_AUTHKIT_CLIENT_ID/);
  });

  it('sends an organization-scoped invitation and parses its expiry', async () => {
    process.env.OAUTH_UPSTREAM = 'workos';
    process.env.WORKOS_API_KEY = 'sk_test';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'inv_123', expires_at: '2026-08-11T12:00:00.000Z' }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const delivery = await new WorkOSInvitationsService().send('person@example.com', 'org_123', 'local-inv-1');

    expect(delivery).toEqual({ id: 'inv_123', expiresAt: new Date('2026-08-11T12:00:00.000Z') });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.workos.com/user_management/invitations?organization_id=org_123&email=person%40example.com',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.workos.com/user_management/invitations',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer sk_test',
          'Content-Type': 'application/json',
          'Idempotency-Key': expect.any(String),
        }),
        body: JSON.stringify({ email: 'person@example.com', organization_id: 'org_123' }),
      }),
    );
  });

  it('reuses and resends a pending provider invitation left by local cleanup', async () => {
    process.env.OAUTH_UPSTREAM = 'workos';
    process.env.WORKOS_API_KEY = 'sk_test';
    const providerInvite = {
      id: 'inv_existing',
      email: 'person@example.com',
      organization_id: 'org_123',
      state: 'pending',
      expires_at: '2099-08-11T12:00:00.000Z',
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [providerInvite] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(providerInvite), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new WorkOSInvitationsService().send('person@example.com', 'org_123', 'local-inv-2')).resolves.toEqual({
      id: 'inv_existing',
      expiresAt: new Date('2099-08-11T12:00:00.000Z'),
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://api.workos.com/user_management/invitations?organization_id=org_123&email=person%40example.com',
      'https://api.workos.com/user_management/invitations/inv_existing/resend',
    ]);
  });

  it('recovers an invitation created before an ambiguous response failure', async () => {
    process.env.OAUTH_UPSTREAM = 'workos';
    process.env.WORKOS_API_KEY = 'sk_test';
    const providerInvite = {
      id: 'inv_recovered',
      email: 'person@example.com',
      organization_id: 'org_123',
      state: 'pending',
      expires_at: '2099-08-11T12:00:00.000Z',
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }))
      .mockRejectedValueOnce(new Error('socket closed'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [providerInvite] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new WorkOSInvitationsService().send('person@example.com', 'org_123', 'local-inv-1')).resolves.toEqual({
      id: 'inv_recovered',
      expiresAt: new Date('2099-08-11T12:00:00.000Z'),
    });
  });

  it('marks only a failed mutating request as having an unknown outcome', async () => {
    process.env.OAUTH_UPSTREAM = 'workos';
    process.env.WORKOS_API_KEY = 'sk_test';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }))
      .mockRejectedValueOnce(new Error('socket closed'))
      .mockRejectedValueOnce(new Error('recovery lookup failed'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      new WorkOSInvitationsService().send('person@example.com', 'org_123', 'local-inv-1'),
    ).rejects.toMatchObject<WorkOSApiError>({ outcomeUnknown: true });
  });

  it('does not mark a failed preflight lookup as having an unknown outcome', async () => {
    process.env.OAUTH_UPSTREAM = 'workos';
    process.env.WORKOS_API_KEY = 'sk_test';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));

    await expect(
      new WorkOSInvitationsService().send('person@example.com', 'org_123', 'local-inv-1'),
    ).rejects.toMatchObject<WorkOSApiError>({ outcomeUnknown: false });
  });

  it('creates a workspace organization by external id and associates its existing owner', async () => {
    process.env.OAUTH_UPSTREAM = 'workos';
    process.env.WORKOS_API_KEY = 'sk_test';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'Not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'org_123' }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'om_123' }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const service = new WorkOSInvitationsService();

    const organizationId = await service.ensureOrganization('workspace-123', 'Workspace One');
    await service.ensureOrganizationMembership(organizationId, 'user_owner');

    expect(organizationId).toBe('org_123');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://api.workos.com/organizations/external_id/workspace-123',
      'https://api.workos.com/organizations',
      'https://api.workos.com/user_management/organization_memberships?organization_id=org_123&user_id=user_owner',
      'https://api.workos.com/user_management/organization_memberships',
    ]);
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ body: JSON.stringify({ name: 'Workspace One', external_id: 'workspace-123' }) }),
    );
    expect(fetchMock.mock.calls[3]?.[1]).toEqual(
      expect.objectContaining({ body: JSON.stringify({ organization_id: 'org_123', user_id: 'user_owner' }) }),
    );
  });

  it('uses provider invitation ids only in encoded resend/revoke paths', async () => {
    process.env.OAUTH_UPSTREAM = 'workos';
    process.env.WORKOS_API_KEY = 'sk_test';
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ id: 'inv/unsafe', expires_at: '2026-08-11T12:00:00.000Z' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const service = new WorkOSInvitationsService();

    await service.resend('inv/unsafe');
    await service.revoke('inv/unsafe');

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://api.workos.com/user_management/invitations/inv%2Funsafe/resend',
      'https://api.workos.com/user_management/invitations/inv%2Funsafe/revoke',
    ]);
  });

  it('removes mapped memberships and organizations through encoded provider paths', async () => {
    process.env.OAUTH_UPSTREAM = 'workos';
    process.env.WORKOS_API_KEY = 'sk_test';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: 'om/unsafe' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const service = new WorkOSInvitationsService();

    await expect(service.removeOrganizationMembership('org_123', 'user_123')).resolves.toBe(true);
    await service.deleteOrganization('org/unsafe');

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://api.workos.com/user_management/organization_memberships?organization_id=org_123&user_id=user_123',
      'https://api.workos.com/user_management/organization_memberships/om%2Funsafe',
      'https://api.workos.com/organizations/org%2Funsafe',
    ]);
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ method: 'DELETE' }));
    expect(fetchMock.mock.calls[2]?.[1]).toEqual(expect.objectContaining({ method: 'DELETE' }));
  });

  it('raises a typed error for a rejected WorkOS request', async () => {
    process.env.OAUTH_UPSTREAM = 'workos';
    process.env.WORKOS_API_KEY = 'sk_test';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: 'Invitation already accepted' }), {
          status: 422,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    await expect(new WorkOSInvitationsService().resend('inv_123')).rejects.toMatchObject<WorkOSApiError>({
      name: 'WorkOSApiError',
      status: 422,
    });
  });

  it.each([404, 410])('treats a %i on deleteOrganization as already deleted', async (status) => {
    // Otherwise an organization removed in the WorkOS dashboard would block the
    // local workspace delete forever — nothing ever clears workosOrganizationId.
    process.env.OAUTH_UPSTREAM = 'workos';
    process.env.WORKOS_API_KEY = 'sk_test';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status })));

    await expect(new WorkOSInvitationsService().deleteOrganization('org_123')).resolves.toBeUndefined();
  });

  it.each([404, 410])('treats a %i on revoke as already revoked', async (status) => {
    // An invitation WorkOS no longer knows about is revoked as far as we care;
    // failing here would strand the local pending row and its email address.
    process.env.OAUTH_UPSTREAM = 'workos';
    process.env.WORKOS_API_KEY = 'sk_test';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status })));

    await expect(new WorkOSInvitationsService().revoke('inv_123')).resolves.toBeUndefined();
  });

  it('still surfaces non-gone failures from an idempotent delete', async () => {
    process.env.OAUTH_UPSTREAM = 'workos';
    process.env.WORKOS_API_KEY = 'sk_test';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 500 })));

    await expect(new WorkOSInvitationsService().deleteOrganization('org_123')).rejects.toMatchObject({
      name: 'WorkOSApiError',
      status: 500,
    });
  });
});
