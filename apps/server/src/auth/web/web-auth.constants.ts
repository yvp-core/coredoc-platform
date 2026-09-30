/**
 * Constants shared by the web session auth path: the cookie names AuthGuard
 * reads and the WebAuthModule that issues them.
 */

export const SESSION_COOKIE = 'coredoc_session';
export const REFRESH_COOKIE = 'coredoc_refresh';
export const PKCE_COOKIE = 'coredoc_pkce';
export const INVITATION_HANDOFF_COOKIE = 'coredoc_invitation_handoff';
export const CSRF_HEADER = 'x-coredoc-csrf';
export const CSRF_HEADER_VALUE = '1';

/** First-party OAuth client id for the server-driven web login (seeded at boot). */
export const WEB_CLIENT_ID = 'coredoc-web';
