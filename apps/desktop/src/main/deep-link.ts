export type CoredocDeepLink = { type: 'auth-callback'; url: string } | { type: 'login' };

/**
 * Keep the desktop protocol surface intentionally small. In particular, deep
 * links cannot select a server URL; Desktop always authenticates against its
 * configured server.
 */
export function parseCoredocDeepLink(rawUrl: string): CoredocDeepLink {
  const url = new URL(rawUrl);

  if (url.protocol !== 'coredoc:') {
    throw new Error('Unsupported deep-link protocol');
  }

  if (url.hostname === 'auth' && url.pathname === '/callback') {
    return { type: 'auth-callback', url: rawUrl };
  }

  if (url.hostname === 'login' && (url.pathname === '' || url.pathname === '/') && !url.search && !url.hash) {
    return { type: 'login' };
  }

  throw new Error('Unsupported Coredoc deep link');
}
