import { type ServerCompatInfo, ServerCompatState } from '../../shared/ipc-types';

/**
 * Banner copy for a version-handshake verdict, or `null` when there is nothing
 * to say. Split out of the .tsx so it is covered by the desktop's
 * node-environment vitest suite, which only collects `.test.ts`.
 */
export function compatBannerMessage(compat: ServerCompatInfo): string | null {
  switch (compat.state) {
    case ServerCompatState.ServerTooOld: {
      // A pre-handshake server reports no version at all (404 on /api/v1/meta).
      const subject = compat.serverVersion ? `Your Coredoc server (v${compat.serverVersion})` : 'Your Coredoc server';
      return `${subject} is older than this app supports — ask your admin to upgrade the server.`;
    }
    case ServerCompatState.ClientTooOld:
      return 'This app is older than your server supports — update the app.';
    case ServerCompatState.Compatible:
      return null;
  }
}
