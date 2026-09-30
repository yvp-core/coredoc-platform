/**
 * Server-driven PKCE web login. The browser never talks to /authorize or
 * /token directly — see web-auth.service.ts for the full flow description.
 */

import {
  BadGatewayException,
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthGuard } from '../auth.guard.js';
import { CurrentUser, type AuthUser } from '../decorators/current-user.decorator.js';
import { ControlPlaneService } from '../../database/control-plane.service.js';
import {
  CSRF_HEADER,
  CSRF_HEADER_VALUE,
  INVITATION_HANDOFF_COOKIE,
  PKCE_COOKIE,
  REFRESH_COOKIE,
  WEB_CLIENT_ID,
} from './web-auth.constants.js';
import { serverUrl } from '../oauth/server-url.js';
import {
  WebAuthService,
  TokenExchangeError,
  WorkOSInvitationExchangeError,
  type TokenResponse,
} from './web-auth.service.js';
import { invitationHandoffPage } from './invitation-handoff-page.js';
import { DesktopReleaseError, latestMacDownloadUrl } from './desktop-release.js';

type CookieRequest = Request & { cookies?: Record<string, string> };

@Controller()
export class WebAuthController {
  constructor(
    private readonly webAuth: WebAuthService,
    private readonly controlPlane: ControlPlaneService,
  ) {}

  /**
   * `/authorize` is always on serverUrl() (the SDK owns a single issuer and a
   * single upstream IdP callback), but the code comes back to whichever
   * allowed web origin the browser started on — so the PKCE cookie, which is
   * host-only, is present at the callback and the session lands on the host
   * the user is actually using.
   */
  @Get('auth/web/login')
  async login(
    @Query('returnTo') returnTo: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const validReturnTo = this.webAuth.validateReturnTo(returnTo);
    const redirectUri = this.webAuth.redirectUri(this.webAuth.webOrigin(req.headers.host));
    const { verifier, challenge, state } = this.webAuth.generatePkce();
    const pkceJws = await this.webAuth.packPkceCookie({
      verifier,
      state,
      returnTo: validReturnTo,
      redirectUri,
    });
    this.webAuth.setPkceCookie(res, pkceJws);

    const url = new URL(`${serverUrl()}/authorize`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', WEB_CLIENT_ID);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);

    res.redirect(url.toString());
  }

  @Get('auth/web/callback')
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Req() req: CookieRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    return this.handleCallback(code, state, req.cookies?.[PKCE_COOKIE], req.cookies?.[INVITATION_HANDOFF_COOKIE], res);
  }

  @Get('auth/web/workos-invitation-callback')
  async workosInvitationCallback(
    @Query('code') code: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    if (!code) {
      throw new BadRequestException('Missing code parameter');
    }

    try {
      const accepted = await this.webAuth.completeWorkosInvitation(code);
      const handoff = await this.webAuth.packInvitationHandoff(accepted);
      // Do not let an unrelated existing browser session survive into the
      // invitation success page while the identity-bound login is in flight.
      this.webAuth.clearSessionCookies(res);
      this.webAuth.setInvitationHandoffCookie(res, handoff);
    } catch (error) {
      if (error instanceof WorkOSInvitationExchangeError) {
        throw new BadGatewayException('WorkOS invitation acceptance could not be completed');
      }
      throw error;
    }

    // Run the ordinary two-layer Coredoc login now that WorkOS has completed
    // the invitation. This replaces any existing Coredoc browser session with
    // the account that just accepted the invite and links its local pending
    // workspace membership in PrismaOAuthStore.upsertUserProfile().
    res.redirect('/api/v1/auth/web/login?returnTo=%2Fapi%2Fv1%2Fauth%2Fweb%2Finvitation-accepted');
  }

  @Get('auth/web/invitation-accepted')
  @UseGuards(AuthGuard)
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  )
  @Header('Referrer-Policy', 'no-referrer')
  invitationAccepted(): string {
    return invitationHandoffPage();
  }

  @Get('auth/web/desktop-download')
  async desktopDownload(@Query('arch') architecture: string, @Res({ passthrough: true }) res: Response): Promise<void> {
    if (architecture !== 'arm64' && architecture !== 'x64') {
      throw new BadRequestException('Unsupported desktop architecture');
    }

    try {
      res.redirect(await latestMacDownloadUrl(architecture));
    } catch (error) {
      if (error instanceof DesktopReleaseError) {
        throw new BadGatewayException('Desktop download is temporarily unavailable');
      }
      throw error;
    }
  }

  /** Split out so controller tests can drive it without a full Express request mock. */
  private async handleCallback(
    code: string,
    state: string,
    pkceCookie: string | undefined,
    invitationHandoffCookie: string | undefined,
    res: Response,
  ): Promise<void> {
    if (!code) {
      throw new BadRequestException('Missing code parameter');
    }

    if (!pkceCookie) {
      throw new BadRequestException('Missing or expired login session');
    }

    let pkce: Awaited<ReturnType<WebAuthService['unpackPkceCookie']>>;
    try {
      pkce = await this.webAuth.unpackPkceCookie(pkceCookie);
    } catch {
      throw new BadRequestException('Missing or expired login session');
    }

    if (pkce.state !== state) {
      throw new BadRequestException('Invalid state parameter');
    }

    let tokens: TokenResponse;
    try {
      tokens = await this.webAuth.exchangeCode({
        code,
        verifier: pkce.verifier,
        redirectUri: pkce.redirectUri,
      });
    } catch (error) {
      const message = error instanceof TokenExchangeError ? error.message : 'Token exchange failed';
      throw new BadGatewayException(message);
    }

    if (pkce.returnTo === '/api/v1/auth/web/invitation-accepted') {
      if (!invitationHandoffCookie) {
        this.webAuth.clearPkceCookie(res);
        throw new BadRequestException('Missing or expired invitation handoff');
      }
      try {
        await this.webAuth.verifyInvitationLogin(invitationHandoffCookie, tokens.access_token);
      } catch {
        this.webAuth.clearInvitationHandoffCookie(res);
        this.webAuth.clearPkceCookie(res);
        throw new UnauthorizedException('Invitation login did not match the account that accepted the invitation');
      }
      this.webAuth.clearInvitationHandoffCookie(res);
    }

    this.webAuth.setSessionCookies(res, tokens);
    this.webAuth.clearPkceCookie(res);
    res.redirect(pkce.returnTo);
  }

  @Post('auth/web/refresh')
  @HttpCode(204)
  async refresh(@Req() req: CookieRequest, @Res({ passthrough: true }) res: Response): Promise<void> {
    return this.handleRefresh(req.headers[CSRF_HEADER] as string | undefined, req.cookies?.[REFRESH_COOKIE], res);
  }

  private async handleRefresh(
    csrfHeader: string | undefined,
    refreshCookie: string | undefined,
    res: Response,
  ): Promise<void> {
    if (csrfHeader !== CSRF_HEADER_VALUE) {
      throw new ForbiddenException('Missing CSRF header');
    }

    if (!refreshCookie) {
      this.webAuth.clearSessionCookies(res);
      throw new UnauthorizedException('Missing refresh session');
    }

    try {
      const tokens = await this.webAuth.exchangeRefreshToken(refreshCookie);
      this.webAuth.setSessionCookies(res, tokens);
    } catch {
      this.webAuth.clearSessionCookies(res);
      throw new UnauthorizedException('Invalid or expired refresh session');
    }
  }

  @Post('auth/web/logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    return this.handleLogout(req.headers[CSRF_HEADER] as string | undefined, res);
  }

  /**
   * Clears cookies only — the SDK's refresh tokens are stateless HS256 JWTs
   * with no jti/store tracking, so a refresh token issued before this logout
   * remains valid (against /token) until its own exp. See
   * WebAuthService.exchangeRefreshToken for the same constraint.
   */
  private async handleLogout(csrfHeader: string | undefined, res: Response): Promise<void> {
    if (csrfHeader !== CSRF_HEADER_VALUE) {
      throw new ForbiddenException('Missing CSRF header');
    }
    this.webAuth.clearSessionCookies(res);
  }

  @Get('me')
  @UseGuards(AuthGuard)
  async me(@CurrentUser() user: AuthUser) {
    await this.controlPlane.linkPendingMemberships(user);
    const workspaces = await this.controlPlane.listWorkspacesForUser(user.id);
    return {
      user,
      workspaces: workspaces.map((w) => ({
        id: w.id,
        name: w.name,
        slug: w.slug,
        role: w.role,
        intentEnabled: w.intentEnabled,
      })),
    };
  }
}
