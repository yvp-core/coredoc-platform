/**
 * Gradle and Android-resource layout discovery for the Kotlin substrate.
 *
 * Gradle is read as TEXT (LIM-5): there is no Gradle or JDK in the parse toolchain, so
 * `projectDir` overrides, `buildSrc` and composite builds are not evaluated. Everything here
 * is derived from a repo-relative file listing — no filesystem access — which is what makes the
 * module-root rule ("kept only when a build file exists") a pure predicate over that listing.
 */
import { posix } from 'node:path';

/** Build files that mark a directory as a real Gradle module. */
const BUILD_FILES = ['build.gradle', 'build.gradle.kts'];
const SETTINGS_FILES = ['settings.gradle', 'settings.gradle.kts'];

export interface GradleLayout {
  /**
   * Module directories, repo-relative, POSIX separators. The repo root (`''`) is always
   * present; a `settings` include is kept only when the directory has a build file.
   */
  moduleRoots: string[];
  /** `<module>/src/<set>` directories holding at least one in-scope Kotlin file. */
  sourceSetDirs: string[];
  /** `AndroidManifest.xml` paths under an in-scope source set. */
  manifestFiles: string[];
  /** `res/navigation/*.xml` paths under an in-scope source set. */
  navigationFiles: string[];
  /** `res/layout/*.xml` paths under an in-scope source set. */
  layoutFiles: string[];
}

/** The repo-root settings file, when one exists in the listing. */
export function findSettingsFile(allFiles: readonly string[]): string | undefined {
  return allFiles.find((f) => SETTINGS_FILES.includes(f));
}

/**
 * Gradle paths from `include` statements in a settings file, as written (`:app`, `:core:data`).
 *
 * Text-only: every quoted string on an `include` statement is taken, including continuation
 * lines ending in a comma. `includeBuild` (a composite build) is deliberately not matched.
 */
export function parseSettingsIncludes(text: string): string[] {
  const out: string[] = [];
  const lines = text.split('\n');
  let inInclude = false;
  for (const raw of lines) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (!line) {
      inInclude = false;
      continue;
    }
    const starts = /^include\s*[(\s]/.test(line) || /^include[('"]/.test(line);
    if (!starts && !inInclude) continue;
    for (const m of line.matchAll(/["']([^"']+)["']/g)) {
      const value = m[1].trim();
      if (value.startsWith(':')) out.push(value);
    }
    // A statement continues across lines while it ends in a comma or an open parenthesis.
    inInclude = line.endsWith(',') || line.endsWith('(');
  }
  return [...new Set(out)];
}

/** `:core:data` → `core/data`; the repo root stays `''`. */
export function gradlePathToDir(gradlePath: string): string {
  return gradlePath.replace(/^:/, '').split(':').filter(Boolean).join('/');
}

function hasBuildFile(dir: string, fileSet: ReadonlySet<string>): boolean {
  return BUILD_FILES.some((name) => fileSet.has(dir ? `${dir}/${name}` : name));
}

/**
 * The Gradle module roots and the Android resource files that belong to the in-scope source
 * sets.
 *
 * `allFiles` is the whole repo listing; `kotlinFiles` is the profile-selected `.kt` set, which
 * alone decides which source sets are in scope (D-3: the globs decide, the substrate has no
 * source-set default). No settings file, or no include with a build file, collapses the module
 * roots to the repo root — never a throw.
 */
export function discoverGradleLayout(
  allFiles: readonly string[],
  kotlinFiles: readonly string[],
  settingsText?: string,
): GradleLayout {
  const fileSet = new Set(allFiles);
  const moduleRoots = new Set<string>(['']);
  for (const include of settingsText ? parseSettingsIncludes(settingsText) : []) {
    const dir = gradlePathToDir(include);
    if (dir && hasBuildFile(dir, fileSet)) moduleRoots.add(dir);
  }

  // A source set is `<anything>/src/<set>`; it is in scope when an in-scope .kt file lives under it.
  const sourceSetDirs = new Set<string>();
  for (const file of kotlinFiles) {
    const m = /^(.*\/)?src\/([^/]+)\//.exec(file);
    if (m) sourceSetDirs.add(`${m[1] ?? ''}src/${m[2]}`);
  }

  const manifestFiles: string[] = [];
  const navigationFiles: string[] = [];
  const layoutFiles: string[] = [];
  const inScope = (path: string) => [...sourceSetDirs].some((dir) => path.startsWith(`${dir}/`));
  for (const file of allFiles) {
    if (!inScope(file)) continue;
    const dir = posix.dirname(file);
    if (file.endsWith('/AndroidManifest.xml')) manifestFiles.push(file);
    else if (!file.endsWith('.xml')) continue;
    else if (/(^|\/)res\/navigation(-[^/]+)?$/.test(dir)) navigationFiles.push(file);
    else if (/(^|\/)res\/layout(-[^/]+)?$/.test(dir)) layoutFiles.push(file);
  }

  return {
    moduleRoots: [...moduleRoots].sort(),
    sourceSetDirs: [...sourceSetDirs].sort(),
    manifestFiles: manifestFiles.sort(),
    navigationFiles: navigationFiles.sort(),
    layoutFiles: layoutFiles.sort(),
  };
}

/** The build file of a module root, for `Package.manifestFile`. */
export function moduleBuildFile(dir: string, allFiles: readonly string[] | ReadonlySet<string>): string | undefined {
  const set = allFiles instanceof Set ? allFiles : new Set(allFiles as readonly string[]);
  for (const name of BUILD_FILES) {
    const path = dir ? `${dir}/${name}` : name;
    if (set.has(path)) return path;
  }
  return undefined;
}

/**
 * Whether a layout name resolves to a real `res/layout/<name>.xml` in an in-scope source set,
 * returning that path. Unresolvable names return undefined and set nothing downstream.
 */
export function resolveLayoutFile(name: string, layoutFiles: readonly string[]): string | undefined {
  const suffix = `/${name}.xml`;
  return layoutFiles.find((f) => f.endsWith(suffix));
}
