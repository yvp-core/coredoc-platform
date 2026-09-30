import { SUPPORTED_RUST_ANALYZER_VERSION } from './load-diagnostics.js';
import { isolatedPlatformPrerequisite } from '../../facts/scip/system-tools.js';
import { appleToolchain } from '../../facts/scip/apple-toolchain.js';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { executableOnPath } from '../../facts/scip/executable.js';
import { outsideSource } from '../../facts/scip/isolated-process.js';

export const RUST_SCIP_SETUP = `Install the repository’s Rust toolchain and its rust-src component, plus standalone rust-analyzer ${SUPPORTED_RUST_ANALYZER_VERSION} on PATH. Or choose basic analysis.`;

/** Only a named installed toolchain may influence preflight, never a repo-supplied path. */
function toolchainName(repoRoot: string): string | undefined {
  const file = ['rust-toolchain', 'rust-toolchain.toml'].map((name) => join(repoRoot, name)).find(existsSync);
  if (!file) return undefined;
  const source = readFileSync(file, 'utf8').trim();
  const toml = /^\s*\[toolchain\]/m.test(source);
  if (toml && !/^\s*(?:channel|path)\s*=/m.test(source)) return undefined;
  const name = toml ? source.match(/^\s*channel\s*=\s*["']([A-Za-z0-9_.-]+)["']\s*(?:#.*)?$/m)?.[1] : source;
  if (/^\s*path\s*=/m.test(source) || !name || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name))
    throw new Error(
      'Enhanced Rust analysis requires a named installed toolchain; repository-local toolchains are unsupported.',
    );
  return name;
}

export function rustScipTools(repoRoot: string) {
  const toolchain = toolchainName(repoRoot);
  const rustup = executableOnPath('rustup', repoRoot);
  const rustupFile = rustup ? statSync(rustup) : undefined;
  const locate = (name: string) => {
    let executable = executableOnPath(name, repoRoot);
    if (!executable) throw new Error(`${name} was not found on PATH.`);
    const file = statSync(executable);
    const proxy =
      basename(executable) === 'rustup' || (rustupFile && file.dev === rustupFile.dev && file.ino === rustupFile.ino);
    if (proxy) {
      // Resolve only a named toolchain from a neutral directory. The checkout cannot supply
      // a local toolchain path or influence rustup's directory override during host preflight.
      executable = realpathSync(
        // Use rustup's name: a hard-linked cargo/rustc dispatches by argv[0].
        execFileSync(rustup ?? executable, ['which', name, ...(toolchain ? ['--toolchain', toolchain] : [])], {
          cwd: '/',
          encoding: 'utf8',
          timeout: 30_000,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            RUSTUP_HOME: process.env.RUSTUP_HOME,
            RUSTUP_AUTO_INSTALL: '0',
          },
        }).trim(),
      );
    }
    return outsideSource(repoRoot, executable);
  };
  const indexer = locate('rust-analyzer');
  const cargo = locate('cargo');
  const rustc = locate('rustc');
  // Every compiler executable runs only later, inside the read-only source sandbox.
  const sdk = outsideSource(repoRoot, dirname(dirname(rustc)));
  if (!existsSync(join(sdk, 'lib/rustlib/src/rust/library')))
    throw new Error('The selected Rust toolchain has no rust-src component.');
  return { indexer, cargo, rustc, sdk };
}
export function rustScipPrereqs(repoRoot: string): string | null {
  const gate = isolatedPlatformPrerequisite(
    'Enhanced Rust analysis requires macOS or Linux with bubblewrap. Use basic analysis on this platform.',
  );
  if (gate) return gate;
  try {
    appleToolchain(repoRoot);
    rustScipTools(repoRoot);
    return null;
  } catch (error) {
    return `${RUST_SCIP_SETUP} ${error instanceof Error ? error.message : ''}`;
  }
}
