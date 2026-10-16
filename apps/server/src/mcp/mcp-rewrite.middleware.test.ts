import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import { isMcpRequestPath, McpRewriteMiddleware, WORKSPACE_HEADER } from './mcp-rewrite.middleware.js';
import { McpAuthKind } from './mcp-auth-context.js';
import { AuthService } from '../auth/auth.service.js';
import { TokenPermission } from '../auth/token-permissions.js';
import { SESSION_COOKIE } from '../auth/web/web-auth.constants.js';
import type { AuthUser } from '../auth/decorators/current-user.decorator.js';

const WS_A = '11111111-1111-1111-1111-111111111111';
const WS_B = '22222222-2222-2222-2222-222222222222';
const WS_C = '33333333-3333-3333-3333-333333333333';

const user: AuthUser = { id: 'user_1', email: 'dev@example.com' };

function makeAuthService(overrides: Partial<{ verifyAccessToken: unknown }> = {}) {
  return {
    verifyAccessToken: vi.fn().mockResolvedValue(user),
    ...overrides,
  } as any;
}

function makeControlPlane(overrides: Record<string, unknown> = {}) {
  return {
    getServiceTokenByHash: vi.fn().mockResolvedValue(null),
    getMember: vi.fn().mockResolvedValue(null),
    getWorkspaceById: vi.fn().mockResolvedValue(null),
    listWorkspacesForUser: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as any;
}

function makeReq(url: string, headers: Record<string, string> = {}) {
  return {
    originalUrl: url,
    url,
    headers,
  } as any;
}

/**
 * A req object with NO `cookies` property, and a `cookies` accessor that
 * throws if anything ever reads it. Used to prove the MCP path never parses
 * cookies at all — not "parses them and ignores the result," but never
 * touches `req.cookies` in the first place.
 */
function makeReqWithCookieTrap(url: string, headers: Record<string, string> = {}) {
  const req: any = {
    originalUrl: url,
    url,
    headers,
  };
  Object.defineProperty(req, 'cookies', {
    enumerable: true,
    get() {
      throw new Error('MCP transport must never read req.cookies');
    },
  });
  return req;
}

function makeRes() {
  const res: any = {
    statusCode: undefined as number | undefined,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
  };
  res.setHeader = vi.fn((name: string, value: string) => {
    res.headers[name] = value;
  });
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn((body: unknown) => {
    res.body = body;
    return res;
  });
  return res;
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

/**
 * Assert the RFC 9728 challenge on a 401. This header is what tells an MCP
 * client to drop the token it holds and re-run OAuth; without it a client with
 * an expired or foreign token retries that token forever. `invalidToken`
 * distinguishes the two legal shapes: credentials were presented and rejected
 * (RFC 6750 error code) vs. none were presented at all.
 */
function expectChallenge(res: ReturnType<typeof makeRes>, { invalidToken }: { invalidToken: boolean }) {
  const header = res.headers['WWW-Authenticate'] as string;
  expect(header).toContain('resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"');
  if (invalidToken) {
    expect(header).toContain('error="invalid_token"');
  } else {
    expect(header).not.toContain('error=');
  }
}

function serviceTokenRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tok_1',
    workspaceId: WS_A,
    name: 'ci-token',
    createdBy: 'user_1',
    permissions: [],
    ...overrides,
  };
}

const CDT_TOKEN = 'cdt_test_token';
const CDT_HASH = createHash('sha256').update(CDT_TOKEN).digest('hex');

describe('isMcpRequestPath', () => {
  it('matches the workspace-scoped transport paths', () => {
    expect(isMcpRequestPath(`/api/v1/workspaces/${WS_A}/mcp`)).toBe(true);
    expect(isMcpRequestPath(`/api/v1/workspaces/${WS_A}/mcp/sse`)).toBe(true);
    expect(isMcpRequestPath(`/api/v1/workspaces/${WS_A}/mcp/messages?sessionId=abc`)).toBe(true);
  });

  it('matches the direct root transport paths', () => {
    expect(isMcpRequestPath('/mcp')).toBe(true);
    expect(isMcpRequestPath('/mcp/')).toBe(true);
    expect(isMcpRequestPath('/sse')).toBe(true);
    expect(isMcpRequestPath('/messages?sessionId=abc')).toBe(true);
  });

  it('does not match sibling or unrelated routes', () => {
    expect(isMcpRequestPath(`/api/v1/workspaces/${WS_A}/mcp-config`)).toBe(false);
    expect(isMcpRequestPath('/api/v1/workspaces')).toBe(false);
    expect(isMcpRequestPath('/mcpx')).toBe(false);
    expect(isMcpRequestPath('/messagesx')).toBe(false);
    expect(isMcpRequestPath('/.well-known/oauth-protected-resource')).toBe(false);
    expect(isMcpRequestPath('/token')).toBe(false);
  });
});

describe('McpRewriteMiddleware — workspace-scoped path (back-compat)', () => {
  beforeEach(() => {
    process.env['MCP_SERVER_URL'] = 'https://mcp.example.com';
  });

  it('passes through non-MCP URLs untouched', async () => {
    const middleware = new McpRewriteMiddleware(makeAuthService(), makeControlPlane());
    const req = makeReq('/api/v1/workspaces');
    const res = makeRes();
    const next = vi.fn();

    await middleware.use(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.url).toBe('/api/v1/workspaces');
    expect(res.status).not.toHaveBeenCalled();
  });

  it('rejects a missing Authorization header with 401 + resource metadata', async () => {
    const middleware = new McpRewriteMiddleware(makeAuthService(), makeControlPlane());
    const req = makeReq(`/api/v1/workspaces/${WS_A}/mcp`);
    const res = makeRes();
    const next = vi.fn();

    await middleware.use(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    // Full value, not just the path substring — proves serverUrl() flows through.
    expect(res.headers['WWW-Authenticate']).toContain('https://mcp.example.com/.well-known/oauth-protected-resource');
    expectChallenge(res, { invalidToken: false });
  });

  it('falls back to SERVER_URL for the resource_metadata host (never "undefined") when MCP_SERVER_URL is unset', async () => {
    delete process.env['MCP_SERVER_URL'];
    process.env['SERVER_URL'] = 'https://api.coredoc.example';
    try {
      const middleware = new McpRewriteMiddleware(makeAuthService(), makeControlPlane());
      const req = makeReq(`/api/v1/workspaces/${WS_A}/mcp`);
      const res = makeRes();

      await middleware.use(req, res, vi.fn());

      const header = res.headers['WWW-Authenticate'] as string;
      expect(header).toContain('https://api.coredoc.example/.well-known/oauth-protected-resource');
      expect(header).not.toContain('undefined');
    } finally {
      delete process.env['SERVER_URL'];
    }
  });

  it('authenticates a user JWT, checks membership, rewrites the URL, and attaches context', async () => {
    const controlPlane = makeControlPlane({
      getMember: vi.fn().mockResolvedValue({ role: 'admin' }),
    });
    const middleware = new McpRewriteMiddleware(makeAuthService(), controlPlane);
    const req = makeReq(`/api/v1/workspaces/${WS_A}/mcp`, bearer('jwt-token'));
    const res = makeRes();
    const next = vi.fn();

    await middleware.use(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.url).toBe('/mcp');
    expect(req.workspaceId).toBe(WS_A);
    expect(req.user).toEqual(user);
    expect(req.userWorkspaceRole).toBe('admin');
    expect(controlPlane.getMember).toHaveBeenCalledWith(WS_A, user.id);
  });

  it('rewrites the SSE subpaths', async () => {
    const controlPlane = makeControlPlane({ getMember: vi.fn().mockResolvedValue({ role: 'member' }) });
    const middleware = new McpRewriteMiddleware(makeAuthService(), controlPlane);
    const req = makeReq(`/api/v1/workspaces/${WS_A}/mcp/sse`, bearer('jwt-token'));
    const res = makeRes();
    const next = vi.fn();

    await middleware.use(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.url).toBe('/sse');
  });

  it('rejects an invalid JWT with 401', async () => {
    const authService = makeAuthService({
      verifyAccessToken: vi.fn().mockRejectedValue(new Error('bad token')),
    });
    const middleware = new McpRewriteMiddleware(authService, makeControlPlane());
    const req = makeReq(`/api/v1/workspaces/${WS_A}/mcp`, bearer('bad-jwt'));
    const res = makeRes();
    const next = vi.fn();

    await middleware.use(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expectChallenge(res, { invalidToken: true });
  });

  it('rejects a non-member user with 403 and NO challenge — re-authenticating cannot grant membership', async () => {
    const middleware = new McpRewriteMiddleware(makeAuthService(), makeControlPlane());
    const req = makeReq(`/api/v1/workspaces/${WS_A}/mcp`, bearer('jwt-token'));
    const res = makeRes();
    const next = vi.fn();

    await middleware.use(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.headers['WWW-Authenticate']).toBeUndefined();
  });

  it('accepts a cdt_ token scoped to the requested workspace', async () => {
    const controlPlane = makeControlPlane({
      getServiceTokenByHash: vi.fn().mockResolvedValue(serviceTokenRow()),
      getMember: vi.fn().mockResolvedValue({ role: 'member' }),
    });
    const middleware = new McpRewriteMiddleware(makeAuthService(), controlPlane);
    const req = makeReq(`/api/v1/workspaces/${WS_A}/mcp`, bearer(CDT_TOKEN));
    const res = makeRes();
    const next = vi.fn();

    await middleware.use(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(controlPlane.getServiceTokenByHash).toHaveBeenCalledWith(CDT_HASH);
    expect(req.workspaceId).toBe(WS_A);
    expect(req.user.email).toBe('service-token:ci-token');
  });

  it('rejects an exact telemetry-purpose token on workspace-scoped MCP with 403', async () => {
    const controlPlane = makeControlPlane({
      getServiceTokenByHash: vi
        .fn()
        .mockResolvedValue(serviceTokenRow({ permissions: [TokenPermission.TelemetryWrite] })),
      getMember: vi.fn().mockResolvedValue({ role: 'owner' }),
    });
    const middleware = new McpRewriteMiddleware(makeAuthService(), controlPlane);
    const req = makeReq(`/api/v1/workspaces/${WS_A}/mcp`, bearer(CDT_TOKEN));
    const res = makeRes();
    const next = vi.fn();

    await middleware.use(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Telemetry tokens may access only telemetry ingestion endpoints' });
    expect(controlPlane.getMember).not.toHaveBeenCalled();
  });

  it('rejects a cdt_ token bound to a different workspace with 403', async () => {
    const controlPlane = makeControlPlane({
      getServiceTokenByHash: vi.fn().mockResolvedValue(serviceTokenRow({ workspaceId: WS_B })),
    });
    const middleware = new McpRewriteMiddleware(makeAuthService(), controlPlane);
    const req = makeReq(`/api/v1/workspaces/${WS_A}/mcp`, bearer(CDT_TOKEN));
    const res = makeRes();
    const next = vi.fn();

    await middleware.use(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it('rejects an unknown cdt_ token with 401', async () => {
    const middleware = new McpRewriteMiddleware(makeAuthService(), makeControlPlane());
    const req = makeReq(`/api/v1/workspaces/${WS_A}/mcp`, bearer(CDT_TOKEN));
    const res = makeRes();
    const next = vi.fn();

    await middleware.use(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expectChallenge(res, { invalidToken: true });
  });
});

describe('McpRewriteMiddleware — direct root path (workspace-agnostic)', () => {
  beforeEach(() => {
    process.env['MCP_SERVER_URL'] = 'https://mcp.example.com';
  });

  it('rejects a missing Authorization header with 401 + resource metadata', async () => {
    const middleware = new McpRewriteMiddleware(makeAuthService(), makeControlPlane());
    const req = makeReq('/mcp');
    const res = makeRes();
    const next = vi.fn();

    await middleware.use(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.headers['WWW-Authenticate']).toContain('oauth-protected-resource');
    expectChallenge(res, { invalidToken: false });
  });

  it('rejects an invalid JWT with 401', async () => {
    const authService = makeAuthService({
      verifyAccessToken: vi.fn().mockRejectedValue(new Error('bad token')),
    });
    const middleware = new McpRewriteMiddleware(authService, makeControlPlane());
    const req = makeReq('/mcp', bearer('bad-jwt'));
    const res = makeRes();
    const next = vi.fn();

    await middleware.use(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expectChallenge(res, { invalidToken: true });
  });

  describe('user JWT', () => {
    it('auto-selects the single accessible workspace', async () => {
      const controlPlane = makeControlPlane({
        listWorkspacesForUser: vi.fn().mockResolvedValue([{ id: WS_A, slug: 'acme', name: 'Acme', role: 'owner' }]),
      });
      const middleware = new McpRewriteMiddleware(makeAuthService(), controlPlane);
      const req = makeReq('/mcp', bearer('jwt-token'));
      const res = makeRes();
      const next = vi.fn();

      await middleware.use(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(req.url).toBe('/mcp');
      expect(req.workspaceId).toBe(WS_A);
      expect(req.user).toEqual(user);
      expect(req.userWorkspaceRole).toBe('owner');
    });

    it('rejects a user with zero accessible workspaces with 403', async () => {
      const middleware = new McpRewriteMiddleware(makeAuthService(), makeControlPlane());
      const req = makeReq('/mcp', bearer('jwt-token'));
      const res = makeRes();
      const next = vi.fn();

      await middleware.use(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
    });

    it('with multiple workspaces and no header, responds 400 listing the accessible workspaces', async () => {
      const controlPlane = makeControlPlane({
        listWorkspacesForUser: vi.fn().mockResolvedValue([
          { id: WS_A, slug: 'acme', name: 'Acme', role: 'owner' },
          { id: WS_B, slug: 'globex', name: 'Globex', role: 'member' },
        ]),
      });
      const middleware = new McpRewriteMiddleware(makeAuthService(), controlPlane);
      const req = makeReq('/mcp', bearer('jwt-token'));
      const res = makeRes();
      const next = vi.fn();

      await middleware.use(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toContain(WORKSPACE_HEADER);
      expect(res.body.accessibleWorkspaces).toEqual([
        { id: WS_A, slug: 'acme', name: 'Acme' },
        { id: WS_B, slug: 'globex', name: 'Globex' },
      ]);
    });

    it('honors the workspace header by id', async () => {
      const controlPlane = makeControlPlane({
        listWorkspacesForUser: vi.fn().mockResolvedValue([
          { id: WS_A, slug: 'acme', name: 'Acme', role: 'owner' },
          { id: WS_B, slug: 'globex', name: 'Globex', role: 'member' },
        ]),
      });
      const middleware = new McpRewriteMiddleware(makeAuthService(), controlPlane);
      const req = makeReq('/mcp', { ...bearer('jwt-token'), [WORKSPACE_HEADER]: WS_B });
      const res = makeRes();
      const next = vi.fn();

      await middleware.use(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(req.workspaceId).toBe(WS_B);
      expect(req.userWorkspaceRole).toBe('member');
    });

    it('honors the workspace header by slug, case-insensitively', async () => {
      const controlPlane = makeControlPlane({
        listWorkspacesForUser: vi.fn().mockResolvedValue([
          { id: WS_A, slug: 'acme', name: 'Acme', role: 'owner' },
          { id: WS_B, slug: 'globex', name: 'Globex', role: 'member' },
        ]),
      });
      const middleware = new McpRewriteMiddleware(makeAuthService(), controlPlane);
      const req = makeReq('/mcp', { ...bearer('jwt-token'), [WORKSPACE_HEADER]: 'Globex' });
      const res = makeRes();
      const next = vi.fn();

      await middleware.use(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(req.workspaceId).toBe(WS_B);
    });

    it('rejects a header naming a workspace the user is not a member of with 403', async () => {
      const controlPlane = makeControlPlane({
        listWorkspacesForUser: vi.fn().mockResolvedValue([
          { id: WS_A, slug: 'acme', name: 'Acme', role: 'owner' },
          { id: WS_B, slug: 'globex', name: 'Globex', role: 'member' },
        ]),
      });
      const middleware = new McpRewriteMiddleware(makeAuthService(), controlPlane);
      const req = makeReq('/mcp', { ...bearer('jwt-token'), [WORKSPACE_HEADER]: WS_C });
      const res = makeRes();
      const next = vi.fn();

      await middleware.use(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
    });

    it('rejects a header naming a foreign workspace even with a single accessible workspace', async () => {
      const controlPlane = makeControlPlane({
        listWorkspacesForUser: vi.fn().mockResolvedValue([{ id: WS_A, slug: 'acme', name: 'Acme', role: 'owner' }]),
      });
      const middleware = new McpRewriteMiddleware(makeAuthService(), controlPlane);
      const req = makeReq('/mcp', { ...bearer('jwt-token'), [WORKSPACE_HEADER]: WS_B });
      const res = makeRes();
      const next = vi.fn();

      await middleware.use(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
    });

    it('responds 400 when a slug header matches more than one accessible workspace', async () => {
      // slug is not globally unique in the control-plane schema
      const controlPlane = makeControlPlane({
        listWorkspacesForUser: vi.fn().mockResolvedValue([
          { id: WS_A, slug: 'acme', name: 'Acme One', role: 'owner' },
          { id: WS_B, slug: 'acme', name: 'Acme Two', role: 'member' },
        ]),
      });
      const middleware = new McpRewriteMiddleware(makeAuthService(), controlPlane);
      const req = makeReq('/mcp', { ...bearer('jwt-token'), [WORKSPACE_HEADER]: 'acme' });
      const res = makeRes();
      const next = vi.fn();

      await middleware.use(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(400);
      expect(res.body.accessibleWorkspaces).toHaveLength(2);
    });

    it('works on the /sse and /messages transports too', async () => {
      const controlPlane = makeControlPlane({
        listWorkspacesForUser: vi.fn().mockResolvedValue([{ id: WS_A, slug: 'acme', name: 'Acme', role: 'owner' }]),
      });
      const middleware = new McpRewriteMiddleware(makeAuthService(), controlPlane);

      for (const url of ['/sse', '/messages?sessionId=abc']) {
        const req = makeReq(url, bearer('jwt-token'));
        const res = makeRes();
        const next = vi.fn();
        await middleware.use(req, res, next);
        expect(next).toHaveBeenCalledOnce();
        expect(req.workspaceId).toBe(WS_A);
        expect(req.url).toBe(url);
      }
    });
  });

  describe('cdt_ service token', () => {
    it('scopes to the token workspace without any header', async () => {
      const controlPlane = makeControlPlane({
        getServiceTokenByHash: vi.fn().mockResolvedValue(serviceTokenRow()),
        getMember: vi.fn().mockResolvedValue({ role: 'member' }),
      });
      const middleware = new McpRewriteMiddleware(makeAuthService(), controlPlane);
      const req = makeReq('/mcp', bearer(CDT_TOKEN));
      const res = makeRes();
      const next = vi.fn();

      await middleware.use(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(req.workspaceId).toBe(WS_A);
      expect(req.user.email).toBe('service-token:ci-token');
      expect(req.userWorkspaceRole).toBe('member');
      // A service token never consults the user membership list
      expect(controlPlane.listWorkspacesForUser).not.toHaveBeenCalled();
    });

    it('rejects an exact telemetry-purpose token on direct-root MCP with 403', async () => {
      const controlPlane = makeControlPlane({
        getServiceTokenByHash: vi
          .fn()
          .mockResolvedValue(serviceTokenRow({ permissions: [TokenPermission.TelemetryWrite] })),
        getMember: vi.fn().mockResolvedValue({ role: 'owner' }),
      });
      const middleware = new McpRewriteMiddleware(makeAuthService(), controlPlane);
      const req = makeReq('/mcp', bearer(CDT_TOKEN));
      const res = makeRes();
      const next = vi.fn();

      await middleware.use(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
      expect(res.body).toEqual({ error: 'Telemetry tokens may access only telemetry ingestion endpoints' });
      expect(controlPlane.getMember).not.toHaveBeenCalled();
    });

    it('accepts a header that matches the token workspace id', async () => {
      const controlPlane = makeControlPlane({
        getServiceTokenByHash: vi.fn().mockResolvedValue(serviceTokenRow()),
        getMember: vi.fn().mockResolvedValue({ role: 'member' }),
      });
      const middleware = new McpRewriteMiddleware(makeAuthService(), controlPlane);
      const req = makeReq('/mcp', { ...bearer(CDT_TOKEN), [WORKSPACE_HEADER]: WS_A });
      const res = makeRes();
      const next = vi.fn();

      await middleware.use(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(req.workspaceId).toBe(WS_A);
      // No slug lookup needed when the id matches directly
      expect(controlPlane.getWorkspaceById).not.toHaveBeenCalled();
    });

    it('accepts a header that matches the token workspace slug', async () => {
      const controlPlane = makeControlPlane({
        getServiceTokenByHash: vi.fn().mockResolvedValue(serviceTokenRow()),
        getWorkspaceById: vi.fn().mockResolvedValue({ id: WS_A, slug: 'acme', name: 'Acme' }),
        getMember: vi.fn().mockResolvedValue({ role: 'member' }),
      });
      const middleware = new McpRewriteMiddleware(makeAuthService(), controlPlane);
      const req = makeReq('/mcp', { ...bearer(CDT_TOKEN), [WORKSPACE_HEADER]: 'Acme' });
      const res = makeRes();
      const next = vi.fn();

      await middleware.use(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(req.workspaceId).toBe(WS_A);
      expect(controlPlane.getWorkspaceById).toHaveBeenCalledWith(WS_A);
    });

    it('rejects a header that contradicts the token workspace with 403 — never a silent override', async () => {
      const controlPlane = makeControlPlane({
        getServiceTokenByHash: vi.fn().mockResolvedValue(serviceTokenRow()),
        getWorkspaceById: vi.fn().mockResolvedValue({ id: WS_A, slug: 'acme', name: 'Acme' }),
        getMember: vi.fn().mockResolvedValue({ role: 'member' }),
      });
      const middleware = new McpRewriteMiddleware(makeAuthService(), controlPlane);
      const req = makeReq('/mcp', { ...bearer(CDT_TOKEN), [WORKSPACE_HEADER]: WS_B });
      const res = makeRes();
      const next = vi.fn();

      await middleware.use(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
      expect(req.workspaceId).toBeUndefined();
      expect(req.user).toBeUndefined();
    });

    it('rejects an unknown cdt_ token with 401', async () => {
      const middleware = new McpRewriteMiddleware(makeAuthService(), makeControlPlane());
      const req = makeReq('/mcp', bearer(CDT_TOKEN));
      const res = makeRes();
      const next = vi.fn();

      await middleware.use(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
      expectChallenge(res, { invalidToken: true });
    });

    it('rejects when the token creator is no longer a workspace member with 403', async () => {
      const controlPlane = makeControlPlane({
        getServiceTokenByHash: vi.fn().mockResolvedValue(serviceTokenRow()),
      });
      const middleware = new McpRewriteMiddleware(makeAuthService(), controlPlane);
      const req = makeReq('/mcp', bearer(CDT_TOKEN));
      const res = makeRes();
      const next = vi.fn();

      await middleware.use(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
    });
  });
});

// =============================================================================
// Invariant: a session cookie must NEVER confer MCP access.
//
// MCP transport auth lives entirely in this middleware and must read only the
// Authorization header. This is the load-bearing safety property of the whole
// B1-1 web-session-auth design (docs/web-ui-plan-2026-07.md §3.1): the
// browser-cookie auth path added for the SPA (AuthGuard + WebAuthModule) must
// stay completely invisible to MCP clients, which authenticate exclusively
// with Bearer tokens. These tests pin the middleware's CURRENT behavior — they
// do not exercise a hypothetical cookie-honoring middleware, since none
// exists; they prove the present code already upholds the invariant, and they
// fail loudly if that ever regresses.
// =============================================================================
describe('McpRewriteMiddleware — session cookie never confers MCP access (invariant)', () => {
  const JWT_SECRET = 'a'.repeat(32);

  beforeEach(() => {
    process.env['MCP_SERVER_URL'] = 'https://mcp.example.com';
    process.env['OAUTH_JWT_SECRET'] = JWT_SECRET;
  });

  async function signAccessJwt(): Promise<string> {
    const secret = new TextEncoder().encode(JWT_SECRET);
    return new SignJWT({ type: 'access', user_data: { email: 'dev@example.com' } })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user_1')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(secret);
  }

  it.each([
    ['/mcp', '/mcp (direct root path)'],
    [`/api/v1/workspaces/${WS_A}/mcp`, 'workspace-scoped rewrite path'],
  ])('rejects a request carrying ONLY a valid coredoc_session cookie with 401, identically to an unauthenticated request, on %s', async (url) => {
    const sessionJwt = await signAccessJwt();
    const authService = new AuthService(); // real verification — proves rejection is not a mock artifact
    const controlPlane = makeControlPlane({
      getMember: vi.fn().mockResolvedValue({ role: 'member' }),
      listWorkspacesForUser: vi.fn().mockResolvedValue([{ id: WS_A, slug: 'acme', name: 'Acme', role: 'owner' }]),
    });
    const middleware = new McpRewriteMiddleware(authService, controlPlane);

    // No Authorization header at all — only a Cookie header carrying a
    // validly-signed session JWT. The req object has no `cookies` property
    // and traps any read of one, so this also proves the middleware never
    // even attempts to parse the cookie.
    const req = makeReqWithCookieTrap(url, { cookie: `${SESSION_COOKIE}=${sessionJwt}` });
    const res = makeRes();
    const next = vi.fn();

    await middleware.use(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Missing or invalid Authorization header' });
    expect(res.headers['WWW-Authenticate']).toContain('oauth-protected-resource');
    // req.cookies was never read — the getter above would have thrown into
    // the middleware's try/catch or up through the test otherwise. Confirm
    // no unexpected auth work happened downstream either.
    expect(controlPlane.getMember).not.toHaveBeenCalled();
    expect(controlPlane.listWorkspacesForUser).not.toHaveBeenCalled();
  });

  it.each([
    ['/mcp', '/mcp (direct root path)'],
    [`/api/v1/workspaces/${WS_A}/mcp`, 'workspace-scoped rewrite path'],
  ])('control case: the SAME session JWT succeeds when sent as a Bearer header on %s — proving the 401 above is about the missing header, not a broken fixture', async (url) => {
    const sessionJwt = await signAccessJwt();
    const authService = new AuthService();
    const controlPlane = makeControlPlane({
      getMember: vi.fn().mockResolvedValue({ role: 'owner' }),
      listWorkspacesForUser: vi.fn().mockResolvedValue([{ id: WS_A, slug: 'acme', name: 'Acme', role: 'owner' }]),
    });
    const middleware = new McpRewriteMiddleware(authService, controlPlane);

    const req = makeReq(url, bearer(sessionJwt));
    const res = makeRes();
    const next = vi.fn();

    await middleware.use(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
    expect(req.user.id).toBe('user_1');
    expect(req.workspaceId).toBe(WS_A);
  });

  // Crude by design: a source-level guard that makes any future cookie read
  // introduced into the MCP transport path a loud, named failure. If this
  // test starts failing because someone added a legitimate non-cookie word
  // matching /cookie/i (e.g. a comment), that's an acceptable false positive —
  // the fix is to rephrase the comment, not to weaken this guard.
  it('source guard: mcp-rewrite.middleware.ts contains no match for /cookie/i — MCP transport must never read cookies, see docs/web-ui-plan-2026-07.md §3.1', () => {
    const middlewarePath = fileURLToPath(new URL('./mcp-rewrite.middleware.ts', import.meta.url));
    const source = readFileSync(middlewarePath, 'utf8');
    expect(source).not.toMatch(/cookie/i);
  });
});

// =============================================================================
// Auth-kind + token-permission propagation.
//
// A service token authenticates AS the user who created it, so `req.user` and
// `req.userWorkspaceRole` alone cannot tell a human session from a machine one.
// These two extra server-set properties are what MCP tools authorize on (see
// mcp/intent-auth.ts) — without them, an owner-created token is indistinguishable
// from the owner.
// =============================================================================
describe('McpRewriteMiddleware — auth kind and service-token permissions on the trusted request', () => {
  beforeEach(() => {
    process.env['MCP_SERVER_URL'] = 'https://mcp.example.com';
  });

  it.each([
    ['workspace-scoped path', `/api/v1/workspaces/${WS_A}/mcp`],
    ['direct root path', '/mcp'],
  ])('marks a user JWT as authKind "jwt" with no token permissions on the %s', async (_name, url) => {
    const controlPlane = makeControlPlane({
      getMember: vi.fn().mockResolvedValue({ role: 'admin' }),
      listWorkspacesForUser: vi.fn().mockResolvedValue([{ id: WS_A, slug: 'acme', name: 'Acme', role: 'admin' }]),
    });
    const middleware = new McpRewriteMiddleware(makeAuthService(), controlPlane);
    const req = makeReq(url, bearer('jwt-token'));
    const next = vi.fn();

    await middleware.use(req, makeRes(), next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.mcpAuthKind).toBe(McpAuthKind.Jwt);
    expect(req.serviceTokenPermissions).toBeUndefined();
  });

  it.each([
    ['workspace-scoped path', `/api/v1/workspaces/${WS_A}/mcp`],
    ['direct root path', '/mcp'],
  ])('marks a cdt_ token as authKind "service" and copies its permissions on the %s', async (_name, url) => {
    const permissions = [TokenPermission.IntentRead, TokenPermission.IntentPropose];
    const controlPlane = makeControlPlane({
      getServiceTokenByHash: vi.fn().mockResolvedValue(serviceTokenRow({ permissions })),
      getMember: vi.fn().mockResolvedValue({ role: 'owner' }),
    });
    const middleware = new McpRewriteMiddleware(makeAuthService(), controlPlane);
    const req = makeReq(url, bearer(CDT_TOKEN));
    const next = vi.fn();

    await middleware.use(req, makeRes(), next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.mcpAuthKind).toBe(McpAuthKind.ServiceToken);
    expect(req.serviceTokenPermissions).toEqual(permissions);
    // A copy, not the control-plane row's array — a tool must not be able to
    // mutate stored token state through the request.
    expect(req.serviceTokenPermissions).not.toBe(permissions);
    // The creator's role still rides along; the auth kind is what refuses it.
    expect(req.userWorkspaceRole).toBe('owner');
  });
});

describe('McpRewriteMiddleware — agent runner tokens work only on the runner API', () => {
  it.each([
    ['workspace-scoped', `/api/v1/workspaces/${WS_A}/mcp`],
    ['direct root', '/mcp'],
  ])('refuses an exact agent-runner token on the %s path with 403', async (_name, url) => {
    const controlPlane = makeControlPlane({
      getServiceTokenByHash: vi
        .fn()
        .mockResolvedValue(serviceTokenRow({ permissions: [TokenPermission.AgentRunnerRun] })),
      getMember: vi.fn().mockResolvedValue({ role: 'owner' }),
    });
    const middleware = new McpRewriteMiddleware(makeAuthService(), controlPlane);
    const res = makeRes();
    const next = vi.fn();

    await middleware.use(makeReq(url, bearer(CDT_TOKEN)), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Agent runner tokens may access only the agent runner API' });
  });
});
