/**
 * Linux custom-protocol registration for AppImage builds.
 *
 * On Linux, `app.setAsDefaultProtocolClient(scheme)` only runs `xdg-mime default`
 * against an existing `.desktop` file — it never creates one. AppImages are
 * portable single-file binaries and have no system-installed `.desktop` entry,
 * so the OS cannot resolve `coredoc://` URLs to the running binary and OAuth
 * deep-link callbacks silently fail.
 *
 * This writes a user-local `.desktop` file pointing at `$APPIMAGE` and registers
 * it as the handler for the scheme. Idempotent: rewritten on every launch so
 * the Exec path stays current if the AppImage is moved.
 */

import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function registerLinuxAppImageProtocol(scheme: string, productName: string): Promise<void> {
  if (process.platform !== 'linux') return;

  const appImagePath = process.env.APPIMAGE;
  if (!appImagePath) {
    // Not running from an AppImage. Native installers (.deb/.rpm) ship their
    // own .desktop file with MimeType configured by electron-builder, and
    // setAsDefaultProtocolClient is sufficient there.
    return;
  }

  const applicationsDir = join(homedir(), '.local', 'share', 'applications');
  const desktopFileName = `${scheme}-handler.desktop`;
  const desktopFilePath = join(applicationsDir, desktopFileName);

  // Quote-escape the AppImage path; rare but possible (e.g. "My Apps/")
  const escapedExec = appImagePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  const content = `[Desktop Entry]
Type=Application
Name=${productName}
Comment=${productName} deep-link handler
Exec="${escapedExec}" %U
Terminal=false
Categories=Development;
MimeType=x-scheme-handler/${scheme};
NoDisplay=true
StartupNotify=true
`;

  try {
    await mkdir(applicationsDir, { recursive: true });
    await writeFile(desktopFilePath, content, 'utf-8');
  } catch (err) {
    console.error('[Protocol][linux] Failed to write .desktop file:', err);
    return;
  }

  try {
    await execFileAsync('update-desktop-database', [applicationsDir], { timeout: 5000 });
  } catch (err) {
    // Not fatal — xdg-mime below can still set the default mapping.
    console.warn('[Protocol][linux] update-desktop-database failed (non-fatal):', err);
  }

  try {
    await execFileAsync('xdg-mime', ['default', desktopFileName, `x-scheme-handler/${scheme}`], { timeout: 5000 });
  } catch (err) {
    console.error('[Protocol][linux] xdg-mime default failed:', err);
    return;
  }

  console.log(`[Protocol][linux] Registered ${desktopFilePath} → x-scheme-handler/${scheme}`);
}
