import { basename } from 'node:path';

/** Cargo/build scripts receive source and manifests only. Unlisted assets required
 * by include_* or build scripts cause a visible basic fallback, never a broad copy.
 */
export function rustIndexInputs(files: string[]): string[] {
  return files.filter(
    (file) =>
      ['Cargo.toml', 'Cargo.lock', 'rust-toolchain', 'rust-toolchain.toml'].includes(basename(file)) ||
      /(^|\/)\.cargo\/config(?:\.toml)?$/.test(file) ||
      /\.(rs|c|cc|cpp|cxx|h|hh|hpp|hxx|s|S)$/.test(file),
  );
}
