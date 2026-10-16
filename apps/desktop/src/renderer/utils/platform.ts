/**
 * Cross-platform path utilities safe for the renderer process.
 */

/** Extract the last segment from a path, handling both `/` and `\` separators. */
export function getBaseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}
