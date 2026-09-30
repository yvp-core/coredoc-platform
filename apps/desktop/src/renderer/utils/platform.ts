/**
 * Cross-platform path and OS utilities safe for the renderer process.
 * Uses navigator APIs instead of Node.js process.platform.
 */

/** Extract the last segment from a path, handling both `/` and `\` separators. */
export function getBaseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

export function isWindows(): boolean {
  return navigator.platform?.startsWith('Win') || /Windows/i.test(navigator.userAgent);
}

export function isMac(): boolean {
  return navigator.platform?.startsWith('Mac') || /Macintosh/i.test(navigator.userAgent);
}

export function isLinux(): boolean {
  return navigator.platform?.startsWith('Linux') || /Linux/i.test(navigator.userAgent);
}
