import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, readdirSync, rmSync, realpathSync, chmodSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

const outdir = 'dist/cli-bundle';
const outfile = `${outdir}/coredoc-cli.mjs`;

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

// Modules that contain native bindings and are not needed in the CI bundle.
// Instead of marking them external (which leaves bare imports that fail at
// module-load time in ESM), we replace them with lightweight stubs that throw
// only when actually called.
const nativeStubs = [
  'better-sqlite3',
  'libsql',
  '@libsql/client',
];

/** esbuild plugin that resolves native packages to in-memory stubs. */
const stubNativePlugin = {
  name: 'stub-native',
  setup(b) {
    const filter = new RegExp(
      `^(${nativeStubs.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`,
    );
    b.onResolve({ filter }, (args) => ({
      path: args.path,
      namespace: 'stub-native',
    }));
    b.onLoad({ filter: /.*/, namespace: 'stub-native' }, (args) => ({
      contents: `
        const msg = "Module '${args.path}' is not available in the CLI bundle";
        export default new Proxy({}, { get(_, k) { if (k === 'then') return undefined; throw new Error(msg); } });
        export const createClient = () => { throw new Error(msg); };
      `,
      loader: 'js',
    }));
  },
};

// ESM banner: shim CJS globals (__filename, __dirname, require) so bundled CJS
// packages (TypeScript, tree-sitter-wasms) that reference them don't crash with
// "ReferenceError: __filename is not defined in ES module scope".
// esbuild 0.27+ does NOT auto-shim these for all code paths in ESM output.
const esmBanner = `
import { createRequire as __bundleCreateRequire } from 'node:module';
import { fileURLToPath as __bundleFileURLToPath } from 'node:url';
import { dirname as __bundleDirname } from 'node:path';
const require = __bundleCreateRequire(import.meta.url);
const __filename = __bundleFileURLToPath(import.meta.url);
const __dirname = __bundleDirname(__filename);
`.trim();

// The single-file bundle runs from a temp dir with no package.json beside it, so
// the CLI version is baked in here (release CI stamps the manifest from the tag
// before this runs). See packages/cli/src/version.ts for the fallback order.
const cliVersion = JSON.parse(readFileSync(join(rootDir, 'packages/cli/package.json'), 'utf8')).version;

await build({
  entryPoints: ['packages/cli/src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  minify: true,
  outfile,
  banner: {
    js: esmBanner,
  },
  define: {
    __COREDOC_CLI_VERSION__: JSON.stringify(cliVersion),
  },
  plugins: [stubNativePlugin],
});

// Post-process: ensure exactly one shebang at the top of the file.
// The source entry point has a shebang that esbuild preserves, plus our
// banner adds import statements.  We strip any duplicate shebangs and
// guarantee the final file starts with a single #!/usr/bin/env node line.
let code = readFileSync(outfile, 'utf8');
// Remove shebang from the first line only
if (code.startsWith('#!')) {
  code = code.replace(/^#!.*\n?/, '');
}
code = `#!/usr/bin/env node\n${code}`;
writeFileSync(outfile, code);

// Write SHA-256 hash to a sidecar file for the upload workflow
const bundle = readFileSync(outfile);
const sha256 = createHash('sha256').update(bundle).digest('hex');
writeFileSync(`${outdir}/sha256.txt`, sha256);

console.log(`Bundle: ${outfile} (${(bundle.length / 1024 / 1024).toFixed(1)} MB)`);
console.log(`SHA-256: ${sha256}`);

// =============================================================================
// Build runtime-modules directory
// =============================================================================
// A repo's profile.ts imports @coredoc/profile-parser (and @coredoc/core types)
// at runtime, and the typecheck gate compiles it against profile-parser's own
// dist/index.d.ts. When running from the bundle, neither is in node_modules, so
// we ship them as a sidecar node_modules tree. The action sets
// COREDOC_RUNTIME_MODULES to runtime-modules/node_modules so ESM package
// resolution still works.

const runtimeDir = `${outdir}/runtime-modules`;
const runtimeNodeModulesDir = join(runtimeDir, 'node_modules');
mkdirSync(runtimeDir, { recursive: true });
mkdirSync(runtimeNodeModulesDir, { recursive: true });

/**
 * Find a package's real directory on disk.
 *
 * Uses Node's own module resolution (createRequire) to find the exact version
 * that `parentDir` depends on. This correctly follows pnpm's symlink structure
 * and avoids picking the wrong version when multiple exist (e.g. minipass@5 vs @7).
 *
 * For workspace packages (@coredoc/*), resolves from the monorepo packages/ dir.
 */
function findPackagePath(pkgName, parentDir) {
  // Workspace package (e.g. @coredoc/core -> packages/core)
  if (pkgName.startsWith('@coredoc/')) {
    const workspaceSrc = join(rootDir, 'packages', pkgName.replace('@coredoc/', ''));
    if (existsSync(join(workspaceSrc, 'package.json'))) return workspaceSrc;
  }

  // Use Node's module resolution from the parent's directory (or project root).
  // This follows pnpm symlinks and always finds the correct version.
  const resolveFrom = parentDir ?? rootDir;
  try {
    const req = createRequire(join(resolveFrom, 'package.json'));
    // Resolve the package's main entry, then walk up to find the package root.
    // We can't resolve `pkg/package.json` directly because `exports` may block it.
    const entryPath = realpathSync(req.resolve(pkgName));
    // Walk up from the resolved file to find the outermost package.json with matching name.
    // Some packages (e.g. mkdirp) have nested package.json in dist/cjs/ with the same name,
    // so we can't stop at the first match — we need the outermost (real) root.
    let dir = dirname(entryPath);
    let result = null;
    while (dir !== dirname(dir)) {
      if (existsSync(join(dir, 'package.json'))) {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
        if (pkg.name === pkgName) {
          result = dir;
        } else if (result) {
          // We've passed through a different package — stop
          break;
        }
      }
      // Stop at node_modules boundary
      if (dir.endsWith('node_modules')) break;
      dir = dirname(dir);
    }
    return result;
  } catch {
    // Fallback 1: direct path in node_modules
    const direct = join(rootDir, 'node_modules', pkgName);
    if (existsSync(join(direct, 'package.json'))) return direct;

    // Fallback 2: search pnpm store (for packages not symlinked by pnpm).
    // Pick the highest version to prefer ESM-capable releases.
    const pnpmDir = join(rootDir, 'node_modules', '.pnpm');
    if (existsSync(pnpmDir)) {
      const encodedName = pkgName.replace('/', '+');
      const entries = readdirSync(pnpmDir).filter(e => e.startsWith(encodedName + '@')).sort().reverse();
      for (const entry of entries) {
        const nested = join(pnpmDir, entry, 'node_modules', pkgName);
        if (existsSync(join(nested, 'package.json'))) return nested;
      }
    }
    return null;
  }
}

const copiedRuntimePackages = new Set();

/**
 * Recreate the `node_modules/.bin` entries a package manager would have made.
 *
 * The sidecar is assembled by copying package directories, and `.bin` is not part
 * of any package — npm/pnpm synthesize it from each manifest's `bin` field. The
 * engine shells out to bare binaries by name (`scip-typescript`, see
 * profile-parser facts/config.ts), so without these shims the SCIP tier is ENOENT
 * and every resolved edge collapses. The CLI puts this dir on PATH.
 */
function linkPackageBins(pkgName, dest) {
  let bin;
  try {
    bin = JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8')).bin;
  } catch {
    return;
  }
  if (!bin) return;
  const entries = typeof bin === 'string' ? { [pkgName.split('/').pop()]: bin } : bin;
  const binDir = join(runtimeNodeModulesDir, '.bin');
  mkdirSync(binDir, { recursive: true });
  for (const [name, target] of Object.entries(entries)) {
    const targetPath = join(dest, target);
    if (!existsSync(targetPath)) continue;
    chmodSync(targetPath, 0o755);
    const linkPath = join(binDir, name);
    rmSync(linkPath, { force: true });
    // Relative, so the tarball stays position-independent once extracted.
    symlinkSync(join('..', pkgName, target), linkPath);
  }
}

/**
 * Resolve npm alias specifiers (e.g. "npm:string-width@^4.2.0") to real
 * package names. Non-alias specifiers are returned as-is using the dep key.
 */
function resolveDepName(depKey, specifier) {
  if (typeof specifier === 'string' && specifier.startsWith('npm:')) {
    // "npm:string-width@^4.2.0" → "string-width"
    const withoutPrefix = specifier.slice(4); // "string-width@^4.2.0"
    const atIdx = withoutPrefix.lastIndexOf('@');
    return atIdx > 0 ? withoutPrefix.slice(0, atIdx) : withoutPrefix;
  }
  return depKey;
}

function getRuntimeDependencies(pkgJson) {
  const deps = Object.entries(pkgJson.dependencies ?? {}).map(([k, v]) => resolveDepName(k, v));
  const peers = Object.entries(pkgJson.peerDependencies ?? {})
    .filter(([name]) => !pkgJson.peerDependenciesMeta?.[name]?.optional)
    .map(([k, v]) => resolveDepName(k, v));
  return [...new Set([...deps, ...peers])];
}

/** Returns [aliasKey, realPackageName] pairs for recursive copy. */
function getRuntimeDependenciesWithAliases(pkgJson) {
  const result = [];
  for (const [k, v] of Object.entries(pkgJson.dependencies ?? {})) {
    result.push([k, resolveDepName(k, v)]);
  }
  for (const [k, v] of Object.entries(pkgJson.peerDependencies ?? {})) {
    if (!pkgJson.peerDependenciesMeta?.[k]?.optional) {
      result.push([k, resolveDepName(k, v)]);
    }
  }
  return result;
}

/**
 * Copy a runtime package. If aliasName differs from pkgName (npm alias),
 * also create a copy under the alias so require('alias-name') works.
 * parentSrc is the resolved path of the parent package (used to resolve
 * the correct version in pnpm's nested node_modules).
 */
function copyRuntimePackage(pkgName, aliasName, parentSrc) {
  if (!aliasName) aliasName = pkgName;

  if (copiedRuntimePackages.has(pkgName) && copiedRuntimePackages.has(aliasName)) {
    return;
  }

  const rawSrc = findPackagePath(pkgName, parentSrc);
  if (!rawSrc) {
    throw new Error(`Runtime package not found: ${pkgName}`);
  }
  // Always resolve to real path — pnpm symlinks can confuse cpSync in some Node versions
  const src = realpathSync(rawSrc);

  // C# is consumed as WASM data; its native bindings and build dependencies are unused.
  if (pkgName === 'tree-sitter-c-sharp') {
    for (const name of new Set([pkgName, aliasName])) {
      const dest = join(runtimeNodeModulesDir, name);
      mkdirSync(dest, { recursive: true });
      for (const file of ['package.json', 'LICENSE', 'tree-sitter-c_sharp.wasm']) {
        cpSync(join(src, file), join(dest, file));
      }
      copiedRuntimePackages.add(name);
    }
    return;
  }

  // Copy under real name
  if (!copiedRuntimePackages.has(pkgName)) {
    copiedRuntimePackages.add(pkgName);
    const dest = join(runtimeNodeModulesDir, pkgName);
    mkdirSync(dirname(dest), { recursive: true });
    // Use cp -rL (dereference all symlinks) for reliable cross-platform copy.
    // cpSync with dereference:true has edge cases in pnpm stores on some Node versions.
    execFileSync('cp', ['-rL', src, dest]);
    // Workspace packages declare their deps, and the recursion below copies those
    // to the sidecar ROOT — which Node's upward lookup reaches from any nested
    // path. Their own pnpm node_modules is therefore duplication, and `-L` makes
    // it an expensive one: every symlink becomes a full second copy of the tree.
    // Third-party packages keep theirs — nested trees there pin versions.
    if (pkgName.startsWith('@coredoc/')) {
      rmSync(join(dest, 'node_modules'), { recursive: true, force: true });
    }
    linkPackageBins(pkgName, dest);
    const label = src.includes('packages/') ? '(workspace)' : src.includes('.pnpm') ? '(pnpm)' : '';
    console.log(`Runtime: ${pkgName} ${label}`.trim());
  }

  // If aliased, also copy under alias name
  if (aliasName !== pkgName && !copiedRuntimePackages.has(aliasName)) {
    copiedRuntimePackages.add(aliasName);
    const aliasDest = join(runtimeNodeModulesDir, aliasName);
    mkdirSync(dirname(aliasDest), { recursive: true });
    execFileSync('cp', ['-rL', src, aliasDest]);
    console.log(`Runtime: ${aliasName} -> ${pkgName} (alias)`);
  }

  const pkgJsonPath = join(src, 'package.json');
  if (!existsSync(pkgJsonPath)) {
    return;
  }

  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  for (const [depKey, realName] of getRuntimeDependenciesWithAliases(pkgJson)) {
    copyRuntimePackage(realName, depKey, src);
  }
}

// Seed packages needed at runtime:
// - @coredoc/profile-parser: profiles import ExtractionProfile from it, and the
//   typecheck gate compiles them against its dist/index.d.ts (see
//   profile-parser/src/profile-typecheck.ts — a bundled engine has no package
//   root on disk, so COREDOC_PROFILE_SCHEMA_DIR points here)
// - @coredoc/core: profiles import its types; also pulls tree-sitter-wasms +
//   web-tree-sitter, which the substrate resolves through NODE_PATH
// - typescript: parser-loader transpiles profile.ts, and the gate needs a compiler
// Direct and peer dependencies are copied recursively into runtime-modules/node_modules.
// NOT ts-morph: the imperative ts-morph parser tier is decommissioned — extraction
// runs on the tree-sitter + SCIP substrate. Nothing imports it (it was still being
// resolved out of the pnpm store, shipping ~12 MB of dead weight).
const runtimePackages = [
  '@coredoc/profile-parser',
  '@coredoc/core',
  'typescript',
];

for (const pkg of runtimePackages) {
  copyRuntimePackage(pkg);
}

// Create runtime-modules tarball
execFileSync('tar', ['-czf', `${outdir}/runtime-modules.tar.gz`, '-C', outdir, 'runtime-modules']);
const runtimeTar = readFileSync(`${outdir}/runtime-modules.tar.gz`);
const runtimeSha = createHash('sha256').update(runtimeTar).digest('hex');
writeFileSync(`${outdir}/runtime-modules-sha256.txt`, runtimeSha);
console.log(`Runtime modules: ${outdir}/runtime-modules.tar.gz (${(runtimeTar.length / 1024 / 1024).toFixed(1)} MB)`);
console.log(`Runtime SHA-256: ${runtimeSha}`);
