interface ChromiumCommandLine {
  appendSwitch(name: string, value?: string): void;
}

const MIN_DEBUG_PORT = 1024;
const MAX_DEBUG_PORT = 65_535;

export function parseDesktopQaPort(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  if (!/^\d+$/.test(raw)) {
    throw new Error('COREDOC_DESKTOP_QA_PORT must be an integer between 1024 and 65535');
  }

  const port = Number.parseInt(raw, 10);
  if (port < MIN_DEBUG_PORT || port > MAX_DEBUG_PORT) {
    throw new Error('COREDOC_DESKTOP_QA_PORT must be an integer between 1024 and 65535');
  }
  return port;
}

/**
 * Expose Chromium DevTools only for an explicitly opted-in development run.
 * The QA client drives the real Electron renderer, so preload/IPC and the app's
 * own safeStorage-backed auth path remain intact without exposing credentials.
 */
export function configureDesktopQaDebugging(
  commandLine: ChromiumCommandLine,
  env: NodeJS.ProcessEnv,
  isPackaged: boolean,
): number | null {
  const port = parseDesktopQaPort(env.COREDOC_DESKTOP_QA_PORT);
  if (port === null) return null;
  if (isPackaged) {
    throw new Error('COREDOC_DESKTOP_QA_PORT is supported only by development builds');
  }

  commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  commandLine.appendSwitch('remote-debugging-port', String(port));
  return port;
}
