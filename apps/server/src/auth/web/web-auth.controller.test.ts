import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadGatewayException, BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { WebAuthController } from './web-auth.controller.js';
import {
  CSRF_HEADER,
  CSRF_HEADER_VALUE,
  INVITATION_HANDOFF_COOKIE,
  PKCE_COOKIE,
  REFRESH_COOKIE,
} from './web-auth.constants.js';
import type { WebAuthService, TokenResponse } from './web-auth.service.js';
import { TokenExchangeError, WorkOSInvitationExchangeError } from './web-auth.service.js';
import type { ControlPlaneService } from '../../database/control-plane.service.js';
import type { AuthUser } from '../decorators/current-user.decorator.js';

const CALLBACK = 'http://localhost:3000/api/v1/auth/web/callback';

const { latestMacDownloadUrlMock } = vi.hoisted(() => ({ latestMacDownloadUrlMock: vi.fn() }));

vi.mock('./desktop-release.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./desktop-release.js')>();
  return { ...original, latestMacDownloadUrl: latestMacDownloadUrlMock };
});

function mockRes() {
  return {
    cookie: vi.fn(),
    clearCookie: vi.fn(),
    redirect: vi.fn(),
  };
}

function mockReq(cookies: Record<string, string> = {}, headers: Record<string, string> = {}) {
  return { cookies, headers } as never;
}

function mockService() {
  return {
    generatePkce: vi.fn().mockReturnValue({ verifier: 'v', challenge: 'chal', state: 's' }),
    packPkceCookie: vi.fn().mockResolvedValue('pkce-jws'),
    unpackPkceCookie: vi.fn(),
    validateReturnTo: vi.fn((v: string | undefined) => (v?.startsWith('/') && !v.startsWith('//') ? v : '/')),
    webOrigin: vi.fn((host: string | undefined) =>
      host === 'ai-dashboard.example.com' ? 'https://ai-dashboard.example.com' : 'http://localhost:3000',
    ),
    redirectUri: vi.fn((origin = 'http://localhost:3000') => `${origin}/api/v1/auth/web/callback`),
    exchangeCode: vi.fn(),
    completeWorkosInvitation: vi.fn().mockResolvedValue({
      workosUserId: 'workos-user-1',
      email: 'person@example.com',
      organizationId: 'workos-org-1',
      workspaceId: 'ws-1',
    }),
    packInvitationHandoff: vi.fn().mockResolvedValue('handoff-jws'),
    verifyInvitationLogin: vi.fn().mockResolvedValue(undefined),
    exchangeRefreshToken: vi.fn(),
    setPkceCookie: vi.fn(),
    setInvitationHandoffCookie: vi.fn(),
    clearInvitationHandoffCookie: vi.fn(),
    clearPkceCookie: vi.fn(),
    setSessionCookies: vi.fn(),
    clearSessionCookies: vi.fn(),
  };
}

describe('WebAuthController', () => {
  let svc: ReturnType<typeof mockService>;
  let controlPlane: {
    listWorkspacesForUser: ReturnType<typeof vi.fn>;
    linkPendingMemberships: ReturnType<typeof vi.fn>;
  };
  let controller: WebAuthController;

  beforeEach(() => {
    process.env.SERVER_URL = 'http://localhost:3000';
    svc = mockService();
    controlPlane = {
      listWorkspacesForUser: vi.fn().mockResolvedValue([]),
      linkPendingMemberships: vi.fn().mockResolvedValue(undefined),
    };
    latestMacDownloadUrlMock.mockReset();
    controller = new WebAuthController(
      svc as unknown as WebAuthService,
      controlPlane as unknown as ControlPlaneService,
    );
  });

  describe('WorkOS invitation callback', () => {
    it('exchanges the WorkOS code and starts the normal Coredoc login', async () => {
      const res = mockRes();

      await controller.workosInvitationCallback('workos-code', res as never);

      expect(svc.completeWorkosInvitation).toHaveBeenCalledWith('workos-code');
      expect(svc.clearSessionCookies).toHaveBeenCalledWith(res);
      expect(svc.setInvitationHandoffCookie).toHaveBeenCalledWith(res, 'handoff-jws');
      expect(res.redirect).toHaveBeenCalledWith(
        '/api/v1/auth/web/login?returnTo=%2Fapi%2Fv1%2Fauth%2Fweb%2Finvitation-accepted',
      );
    });

    it('400s when WorkOS did not return a code', async () => {
      const res = mockRes();

      await expect(controller.workosInvitationCallback('', res as never)).rejects.toThrow(BadRequestException);
      expect(svc.completeWorkosInvitation).not.toHaveBeenCalled();
    });

    it('returns a generic 502 when WorkOS rejects the code', async () => {
      svc.completeWorkosInvitation.mockRejectedValue(new WorkOSInvitationExchangeError('provider detail'));
      const res = mockRes();

      const promise = controller.workosInvitationCallback('bad-code', res as never);
      await expect(promise).rejects.toThrow(BadGatewayException);
      await expect(promise).rejects.toMatchObject({
        message: 'WorkOS invitation acceptance could not be completed',
      });
      expect(res.redirect).not.toHaveBeenCalled();
    });
  });

  describe('invitation handoff', () => {
    it('returns a server-owned page with Desktop open and download actions', () => {
      const html = controller.invitationAccepted();

      expect(html).toContain('Invitation accepted');
      expect(html).toContain('coredoc://login');
      expect(html).toContain('Download latest for Apple Silicon');
      expect(html).toContain('Download for Intel Mac');
    });

    it('redirects downloads to the latest public release asset', async () => {
      latestMacDownloadUrlMock.mockResolvedValue(
        'https://github.com/yvp-core/coredoc-platform/releases/latest/download/Coredoc-1.1.0-arm64.dmg',
      );
      const res = mockRes();

      await controller.desktopDownload('arm64', res as never);

      expect(latestMacDownloadUrlMock).toHaveBeenCalledWith('arm64');
      expect(res.redirect).toHaveBeenCalledWith(
        'https://github.com/yvp-core/coredoc-platform/releases/latest/download/Coredoc-1.1.0-arm64.dmg',
      );
    });

    it('rejects unsupported download architectures', async () => {
      await expect(controller.desktopDownload('windows', mockRes() as never)).rejects.toThrow(BadRequestException);
      expect(latestMacDownloadUrlMock).not.toHaveBeenCalled();
    });
  });

  describe('login', () => {
    it('redirects to /authorize with the SDK-required params and sets the PKCE cookie', async () => {
      const res = mockRes();
      await controller.login('/w/acme', mockReq(), res as never);

      expect(svc.setPkceCookie).toHaveBeenCalledWith(res, 'pkce-jws');
      expect(res.redirect).toHaveBeenCalledTimes(1);
      const location = res.redirect.mock.calls[0][0] as string;
      const url = new URL(location);
      expect(url.origin + url.pathname).toBe('http://localhost:3000/authorize');
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('client_id')).toBe('coredoc-web');
      expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:3000/api/v1/auth/web/callback');
      expect(url.searchParams.get('code_challenge')).toBe('chal');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('state')).toBe('s');
    });

    it('sends the code back to the web origin the browser reached us on, not the canonical one', async () => {
      const res = mockRes();
      await controller.login('/w/acme', mockReq({}, { host: 'ai-dashboard.example.com' }), res as never);

      const url = new URL(res.redirect.mock.calls[0][0] as string);
      // /authorize stays on the canonical issuer — only the code's landing host moves.
      expect(url.origin + url.pathname).toBe('http://localhost:3000/authorize');
      expect(url.searchParams.get('redirect_uri')).toBe('https://ai-dashboard.example.com/api/v1/auth/web/callback');
      expect(svc.packPkceCookie).toHaveBeenCalledWith(
        expect.objectContaining({ redirectUri: 'https://ai-dashboard.example.com/api/v1/auth/web/callback' }),
      );
    });

    it('validates returnTo before packing it into the PKCE cookie', async () => {
      const res = mockRes();
      await controller.login('https://evil.com', mockReq(), res as never);
      expect(svc.validateReturnTo).toHaveBeenCalledWith('https://evil.com');
      expect(svc.packPkceCookie).toHaveBeenCalledWith(expect.objectContaining({ returnTo: '/' }));
    });
  });

  describe('callback', () => {
    it('400s when the code param is missing', async () => {
      const res = mockRes();
      await expect(controller.callback('', 'state', mockReq({ [PKCE_COOKIE]: 'jws' }), res as never)).rejects.toThrow(
        BadRequestException,
      );
      expect(svc.unpackPkceCookie).not.toHaveBeenCalled();
    });

    it('400s when the PKCE cookie is absent', async () => {
      const res = mockRes();
      await expect(controller.callback('code', 'state', mockReq({}), res as never)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('400s when the PKCE cookie fails verification (expired/tampered)', async () => {
      svc.unpackPkceCookie.mockRejectedValue(new Error('expired'));
      const res = mockRes();
      await expect(
        controller.callback('code', 'state', mockReq({ [PKCE_COOKIE]: 'bad-jws' }), res as never),
      ).rejects.toThrow(BadRequestException);
    });

    it('400s on state mismatch', async () => {
      svc.unpackPkceCookie.mockResolvedValue({
        verifier: 'v',
        state: 'expected',
        returnTo: '/w/acme',
        redirectUri: CALLBACK,
      });
      const res = mockRes();
      await expect(
        controller.callback('code', 'wrong-state', mockReq({ [PKCE_COOKIE]: 'jws' }), res as never),
      ).rejects.toThrow(BadRequestException);
    });

    it('exchanges the code, sets session cookies, clears the PKCE cookie, and redirects to returnTo', async () => {
      svc.unpackPkceCookie.mockResolvedValue({ verifier: 'v', state: 's', returnTo: '/w/acme', redirectUri: CALLBACK });
      const tokens: TokenResponse = { access_token: 'at', refresh_token: 'rt' };
      svc.exchangeCode.mockResolvedValue(tokens);
      const res = mockRes();

      await controller.callback('the-code', 's', mockReq({ [PKCE_COOKIE]: 'jws' }), res as never);

      expect(svc.exchangeCode).toHaveBeenCalledWith({
        code: 'the-code',
        verifier: 'v',
        redirectUri: CALLBACK,
      });
      expect(svc.setSessionCookies).toHaveBeenCalledWith(res, tokens);
      expect(svc.clearPkceCookie).toHaveBeenCalledWith(res);
      expect(res.redirect).toHaveBeenCalledWith('/w/acme');
    });

    it('exchanges with the redirect_uri from the cookie, not a recomputed canonical one', async () => {
      const secondOriginCallback = 'https://ai-dashboard.example.com/api/v1/auth/web/callback';
      svc.unpackPkceCookie.mockResolvedValue({
        verifier: 'v',
        state: 's',
        returnTo: '/w/acme',
        redirectUri: secondOriginCallback,
      });
      svc.exchangeCode.mockResolvedValue({ access_token: 'at' } satisfies TokenResponse);

      await controller.callback('the-code', 's', mockReq({ [PKCE_COOKIE]: 'jws' }), mockRes() as never);

      expect(svc.exchangeCode).toHaveBeenCalledWith(expect.objectContaining({ redirectUri: secondOriginCallback }));
    });

    it('requires the invitation handoff to match before creating the accepted session', async () => {
      svc.unpackPkceCookie.mockResolvedValue({
        verifier: 'v',
        state: 's',
        returnTo: '/api/v1/auth/web/invitation-accepted',
        redirectUri: CALLBACK,
      });
      const tokens: TokenResponse = { access_token: 'at', refresh_token: 'rt' };
      svc.exchangeCode.mockResolvedValue(tokens);
      const res = mockRes();

      await controller.callback(
        'code',
        's',
        mockReq({ [PKCE_COOKIE]: 'pkce-jws', [INVITATION_HANDOFF_COOKIE]: 'handoff-jws' }),
        res as never,
      );

      expect(svc.verifyInvitationLogin).toHaveBeenCalledWith('handoff-jws', 'at');
      expect(svc.clearInvitationHandoffCookie).toHaveBeenCalledWith(res);
      expect(svc.setSessionCookies).toHaveBeenCalledWith(res, tokens);
    });

    it('rejects an invitation completion when the signed handoff cookie is missing', async () => {
      svc.unpackPkceCookie.mockResolvedValue({
        verifier: 'v',
        state: 's',
        returnTo: '/api/v1/auth/web/invitation-accepted',
        redirectUri: CALLBACK,
      });
      svc.exchangeCode.mockResolvedValue({ access_token: 'at' });
      const res = mockRes();

      await expect(
        controller.callback('code', 's', mockReq({ [PKCE_COOKIE]: 'pkce-jws' }), res as never),
      ).rejects.toThrow(BadRequestException);
      expect(svc.verifyInvitationLogin).not.toHaveBeenCalled();
      expect(svc.setSessionCookies).not.toHaveBeenCalled();
    });

    it('rejects a different ambient WorkOS identity without setting a session', async () => {
      svc.unpackPkceCookie.mockResolvedValue({
        verifier: 'v',
        state: 's',
        returnTo: '/api/v1/auth/web/invitation-accepted',
        redirectUri: CALLBACK,
      });
      svc.exchangeCode.mockResolvedValue({ access_token: 'wrong-at' });
      svc.verifyInvitationLogin.mockRejectedValue(new Error('different identity'));
      const res = mockRes();

      await expect(
        controller.callback(
          'code',
          's',
          mockReq({ [PKCE_COOKIE]: 'pkce-jws', [INVITATION_HANDOFF_COOKIE]: 'handoff-jws' }),
          res as never,
        ),
      ).rejects.toThrow(UnauthorizedException);
      expect(svc.setSessionCookies).not.toHaveBeenCalled();
      expect(svc.clearInvitationHandoffCookie).toHaveBeenCalledWith(res);
    });

    it('maps a failed token exchange to a 502 without echoing tokens', async () => {
      svc.unpackPkceCookie.mockResolvedValue({ verifier: 'v', state: 's', returnTo: '/' });
      svc.exchangeCode.mockRejectedValue(new TokenExchangeError('Invalid PKCE verification'));
      const res = mockRes();

      const promise = controller.callback('c', 's', mockReq({ [PKCE_COOKIE]: 'jws' }), res as never);
      await expect(promise).rejects.toThrow(BadGatewayException);
      await expect(promise).rejects.toMatchObject({ message: 'Invalid PKCE verification' });
    });
  });

  describe('refresh', () => {
    it('403s when the CSRF header is missing, without touching any cookies', async () => {
      const res = mockRes();
      await expect(controller.refresh(mockReq({ [REFRESH_COOKIE]: 'rt-old' }), res as never)).rejects.toThrow(
        ForbiddenException,
      );
      expect(svc.clearSessionCookies).not.toHaveBeenCalled();
      expect(svc.setSessionCookies).not.toHaveBeenCalled();
      expect(svc.exchangeRefreshToken).not.toHaveBeenCalled();
    });

    it('403s when the CSRF header value is wrong, without touching any cookies', async () => {
      const res = mockRes();
      await expect(
        controller.refresh(mockReq({ [REFRESH_COOKIE]: 'rt-old' }, { [CSRF_HEADER]: 'wrong' }), res as never),
      ).rejects.toThrow(ForbiddenException);
      expect(svc.clearSessionCookies).not.toHaveBeenCalled();
      expect(svc.setSessionCookies).not.toHaveBeenCalled();
    });

    it('401s and clears both cookies when the refresh cookie is absent', async () => {
      const res = mockRes();
      await expect(controller.refresh(mockReq({}, { [CSRF_HEADER]: CSRF_HEADER_VALUE }), res as never)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(svc.clearSessionCookies).toHaveBeenCalledWith(res);
    });

    it('401s and clears both cookies when the AS rejects the refresh token', async () => {
      svc.exchangeRefreshToken.mockRejectedValue(new TokenExchangeError('Invalid or expired refresh token'));
      const res = mockRes();
      await expect(
        controller.refresh(mockReq({ [REFRESH_COOKIE]: 'bad-rt' }, { [CSRF_HEADER]: CSRF_HEADER_VALUE }), res as never),
      ).rejects.toThrow(UnauthorizedException);
      expect(svc.clearSessionCookies).toHaveBeenCalledWith(res);
    });

    it('rotates both cookies on a successful refresh', async () => {
      const tokens: TokenResponse = { access_token: 'at2', refresh_token: 'rt2' };
      svc.exchangeRefreshToken.mockResolvedValue(tokens);
      const res = mockRes();

      await controller.refresh(
        mockReq({ [REFRESH_COOKIE]: 'rt-old' }, { [CSRF_HEADER]: CSRF_HEADER_VALUE }),
        res as never,
      );

      expect(svc.exchangeRefreshToken).toHaveBeenCalledWith('rt-old');
      expect(svc.setSessionCookies).toHaveBeenCalledWith(res, tokens);
    });
  });

  describe('logout', () => {
    it('403s when the CSRF header is missing', async () => {
      const res = mockRes();
      await expect(controller.logout(mockReq({}, {}), res as never)).rejects.toThrow(ForbiddenException);
      expect(svc.clearSessionCookies).not.toHaveBeenCalled();
    });

    it('clears both cookies when the CSRF header is present', async () => {
      const res = mockRes();
      await controller.logout(mockReq({}, { [CSRF_HEADER]: CSRF_HEADER_VALUE }), res as never);
      expect(svc.clearSessionCookies).toHaveBeenCalledWith(res);
    });
  });

  describe('me', () => {
    it('returns the current user + their workspace memberships', async () => {
      const user: AuthUser = { id: 'user_1', email: 'a@b.com' };
      controlPlane.listWorkspacesForUser.mockResolvedValue([
        { id: 'ws_1', name: 'Acme', slug: 'acme', role: 'admin', intentEnabled: true },
      ]);

      const result = await controller.me(user);

      expect(controlPlane.linkPendingMemberships).toHaveBeenCalledWith(user);
      expect(controlPlane.listWorkspacesForUser).toHaveBeenCalledWith('user_1');
      expect(result).toEqual({
        user,
        workspaces: [{ id: 'ws_1', name: 'Acme', slug: 'acme', role: 'admin', intentEnabled: true }],
      });
    });
  });
});
