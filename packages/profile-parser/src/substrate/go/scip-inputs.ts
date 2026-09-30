import { basename } from 'node:path';

/** go/packages needs modules and compiler inputs, not deployment or application secrets.
 * Repositories requiring embedded assets outside this set fall back to basic.
 */
export function goIndexInputs(files: string[]): string[] {
  return files.filter(
    (file) =>
      ['go.mod', 'go.sum', 'go.work', 'go.work.sum'].includes(basename(file)) ||
      /\.(go|c|cc|cpp|cxx|h|hh|hpp|hxx|s|S|syso)$/.test(file),
  );
}
