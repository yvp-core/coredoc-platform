import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { homebrewRuntimeReadRoots } from './homebrew-runtime.js';

it.each(['bin/node', 'libexec/bin/go'])('reads only declared dependencies for %s', (entry) => {
  const prefix = realpathSync(mkdtempSync(join(tmpdir(), 'homebrew-runtime-')));
  try {
    const keg = join(prefix, 'Cellar/node/24');
    const dependency = join(prefix, 'Cellar/icu4c/77');
    mkdirSync(join(keg, entry, '..'), { recursive: true });
    mkdirSync(join(dependency, 'lib'), { recursive: true });
    mkdirSync(join(prefix, 'opt'));
    symlinkSync(dependency, join(prefix, 'opt/icu4c'));
    writeFileSync(join(keg, entry), 'runtime');
    writeFileSync(
      join(keg, 'INSTALL_RECEIPT.json'),
      JSON.stringify({ runtime_dependencies: [{ full_name: 'homebrew/core/icu4c' }] }),
    );
    expect(homebrewRuntimeReadRoots(join(keg, entry))).toEqual([keg, join(prefix, 'opt/icu4c')]);
    writeFileSync(join(keg, 'INSTALL_RECEIPT.json'), JSON.stringify({ runtime_dependencies: [{ full_name: '..' }] }));
    expect(() => homebrewRuntimeReadRoots(join(keg, entry))).toThrow('Invalid Homebrew runtime dependency');
    writeFileSync(join(keg, 'INSTALL_RECEIPT.json'), '{}');
    expect(homebrewRuntimeReadRoots(join(keg, entry))).toEqual([keg]);
    rmSync(join(keg, 'INSTALL_RECEIPT.json'));
    expect(() => homebrewRuntimeReadRoots(join(keg, entry))).toThrow('Repair that Homebrew installation');
    writeFileSync(join(prefix, 'ordinary-runtime'), 'runtime');
    expect(homebrewRuntimeReadRoots(join(prefix, 'ordinary-runtime'))).toEqual([]);
  } finally {
    rmSync(prefix, { recursive: true, force: true });
  }
});
