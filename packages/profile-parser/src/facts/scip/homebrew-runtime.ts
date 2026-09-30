import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** Homebrew records the runtime dependency packages; don't expose its whole prefix to an indexer. */
export function homebrewRuntimeReadRoots(executable: string): string[] {
  let keg = dirname(realpathSync(executable));
  while (basename(dirname(dirname(keg))) !== 'Cellar') {
    const parent = dirname(keg);
    if (parent === keg) return [];
    keg = parent;
  }
  const cellar = dirname(dirname(keg));
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(join(keg, 'INSTALL_RECEIPT.json'), 'utf8'));
  } catch {
    throw new Error(
      `Cannot read the Homebrew runtime receipt for ${basename(dirname(keg))}. Repair that Homebrew installation or choose basic analysis.`,
    );
  }
  const dependencies: unknown = receipt.runtime_dependencies ?? [];
  if (!Array.isArray(dependencies)) throw new Error('Homebrew runtime receipt has no dependency list.');
  const roots = [keg];
  // Linuxbrew may patch ELF binaries to use its own loader install-name.
  const loader = join(dirname(cellar), 'lib/ld.so');
  if (process.platform === 'linux' && existsSync(loader)) roots.push(loader);
  for (const dep of dependencies) {
    const name = dep && typeof dep.full_name === 'string' ? dep.full_name.split('/').at(-1) : '';
    if (!name || !/^[A-Za-z0-9][A-Za-z0-9@+_.-]*$/.test(name)) throw new Error('Invalid Homebrew runtime dependency.');
    roots.push(join(dirname(cellar), 'opt', name));
  }
  return roots.filter(existsSync);
}
