import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runScipRust } from './scip-run.js';

it.runIf(process.env.COREDOC_RUST_E2E === '1')(
  'rejects a swallowed build-script failure despite a nonempty index',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'rust-load-failure-'));
    const source = join(root, 'source');
    mkdirSync(join(source, 'src'), { recursive: true });
    mkdirSync(join(source, '.cargo'));
    writeFileSync(join(source, '.cargo/config.toml'), '[build]\nrustflags = ["--cfg", "fixture_config"]\n');
    writeFileSync(join(source, 'Cargo.toml'), '[package]\nname="loader_fixture"\nversion="0.1.0"\nedition="2021"\n');
    writeFileSync(join(source, 'src/lib.rs'), 'pub fn value() -> u32 { 42 }\n');
    writeFileSync(join(source, 'Cargo.lock'), 'version = 4\n[[package]]\nname = "loader_fixture"\nversion = "0.1.0"\n');
    writeFileSync(join(source, 'build.rs'), 'fn main() { panic!("fixture build failed"); }\n');
    try {
      const result = await runScipRust(source, { outDir: join(root, 'output') });
      expect(result.ok).toBe(false);
      expect(result.degradeReason).toMatch(/build scripts/i);
      writeFileSync(join(source, 'build.rs'), 'fn main() {}\n');
      mkdirSync(join(source, 'macros/src'), { recursive: true });
      writeFileSync(
        join(source, 'macros/Cargo.toml'),
        '[package]\nname="fixture_macro"\nversion="0.1.0"\nedition="2021"\n[lib]\nproc-macro=true\n',
      );
      writeFileSync(
        join(source, 'macros/src/lib.rs'),
        'use proc_macro::TokenStream;\n#[proc_macro]\npub fn number(_: TokenStream) -> TokenStream { "42u32".parse().unwrap() }\n',
      );
      writeFileSync(
        join(source, 'Cargo.toml'),
        '[package]\nname="loader_fixture"\nversion="0.1.0"\nedition="2021"\n[dependencies]\nfixture_macro={path="macros"}\n',
      );
      writeFileSync(join(source, 'src/lib.rs'), 'pub fn value() -> u32 { fixture_macro::number!() }\n');
      writeFileSync(
        join(source, 'Cargo.lock'),
        'version = 4\n[[package]]\nname = "loader_fixture"\nversion = "0.1.0"\ndependencies = ["fixture_macro"]\n[[package]]\nname = "fixture_macro"\nversion = "0.1.0"\n',
      );
      const recovered = await runScipRust(source, { outDir: join(root, 'output') });
      expect(recovered.ok, recovered.degradeReason).toBe(true);
      const lastGood = readFileSync(recovered.scipPath!);
      rmSync(join(source, 'Cargo.lock'));
      const missingLock = await runScipRust(source, { outDir: join(root, 'output') });
      expect(missingLock.ok).toBe(false);
      expect(missingLock.degradeReason).toContain('cargo metadata');
      expect(existsSync(join(source, 'Cargo.lock'))).toBe(false);
      expect(readFileSync(recovered.scipPath!)).toEqual(lastGood);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  60_000,
);
