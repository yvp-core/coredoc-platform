import { execFileSync } from 'node:child_process';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, delimiter, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { rustScipTools } from './scip-tool.js';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(proxy: 'symlink' | 'hardlink' = 'symlink') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rust-tool-preflight-')));
  roots.push(root);
  const repo = join(root, 'repo');
  const bin = join(root, 'bin');
  const sdk = join(root, 'sdk');
  mkdirSync(repo);
  mkdirSync(bin);
  mkdirSync(join(sdk, 'bin'), { recursive: true });
  mkdirSync(join(sdk, 'lib/rustlib/src/rust/library'), { recursive: true });
  const rustup = join(bin, 'rustup');
  writeFileSync(rustup, 'never executed');
  chmodSync(rustup, 0o755);
  for (const name of ['rust-analyzer', 'cargo', 'rustc']) {
    (proxy === 'hardlink' ? linkSync : symlinkSync)(rustup, join(bin, name));
    writeFileSync(join(sdk, 'bin', name), 'compiler');
  }
  vi.stubEnv('PATH', bin);
  vi.mocked(execFileSync).mockImplementation((_file, args) => `${join(sdk, 'bin', args![1])}\n`);
  return { repo, sdk, rustup };
}

it.each(['', '# Compiler version\n\n'])('resolves a named installed toolchain with leading comment %j', (comment) => {
  const { repo, sdk, rustup } = fixture();
  writeFileSync(join(repo, 'rust-toolchain.toml'), `${comment}[toolchain]\nchannel = "1.93.0"\n`);
  expect(rustScipTools(repo).sdk).toBe(sdk);
  for (const name of ['rust-analyzer', 'cargo', 'rustc']) {
    expect(execFileSync).toHaveBeenCalledWith(
      rustup,
      ['which', name, '--toolchain', '1.93.0'],
      expect.objectContaining({ cwd: '/', env: expect.objectContaining({ RUSTUP_AUTO_INSTALL: '0' }) }),
    );
  }
  expect(execFileSync).toHaveBeenCalledTimes(3);
});

it('refuses a repository-selected toolchain path before host execution', () => {
  const { repo } = fixture();
  writeFileSync(join(repo, 'rust-toolchain.toml'), '[toolchain]\npath = "./toolchain"\n');
  expect(() => rustScipTools(repo)).toThrow('repository-local toolchains are unsupported');
  expect(execFileSync).not.toHaveBeenCalled();
});

it('uses the default installed toolchain for a components-only configuration', () => {
  const { repo, rustup } = fixture();
  writeFileSync(join(repo, 'rust-toolchain.toml'), '[toolchain]\ncomponents = ["rust-src"]\n');
  rustScipTools(repo);
  expect(execFileSync).toHaveBeenCalledWith(rustup, ['which', 'rustc'], expect.anything());
});

// rustup can install proxies as hard links: canonical filenames alone cannot identify them.
it('resolves hard-linked rustup proxies through the rustup executable', () => {
  const { repo, sdk, rustup } = fixture('hardlink');
  writeFileSync(join(repo, 'rust-toolchain.toml'), '[toolchain]\nchannel = "1.93.0"\n');
  expect(rustScipTools(repo)).toEqual({
    sdk,
    indexer: join(sdk, 'bin/rust-analyzer'),
    cargo: join(sdk, 'bin/cargo'),
    rustc: join(sdk, 'bin/rustc'),
  });
  expect(execFileSync).toHaveBeenCalledTimes(3);
  expect(execFileSync).toHaveBeenCalledWith(rustup, ['which', 'rustc', '--toolchain', '1.93.0'], expect.anything());
});

it('does not redirect independent SDK binaries through an unrelated rustup', () => {
  const { repo, sdk, rustup } = fixture();
  for (const name of ['rust-analyzer', 'cargo', 'rustc']) chmodSync(join(sdk, 'bin', name), 0o755);
  vi.stubEnv('PATH', join(sdk, 'bin') + delimiter + dirname(rustup));
  expect(rustScipTools(repo).sdk).toBe(sdk);
  expect(execFileSync).not.toHaveBeenCalled();
});
