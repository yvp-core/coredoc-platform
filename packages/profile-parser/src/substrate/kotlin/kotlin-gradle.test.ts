import { describe, expect, it } from 'vitest';
import {
  discoverGradleLayout,
  findSettingsFile,
  gradlePathToDir,
  moduleBuildFile,
  parseSettingsIncludes,
  resolveLayoutFile,
} from './kotlin-gradle.js';

const ALL = [
  'settings.gradle.kts',
  'build.gradle.kts',
  'app/build.gradle.kts',
  'app/src/main/AndroidManifest.xml',
  'app/src/main/kotlin/a/b/Impl.kt',
  'app/src/main/res/layout/view_thing.xml',
  'app/src/main/res/navigation/nav_main.xml',
  'app/src/debug/AndroidManifest.xml',
  'app/src/debug/kotlin/a/b/Debug.kt',
  'core/data/build.gradle.kts',
  'core/data/src/main/kotlin/a/c/Repo.kt',
  'tools/notamodule/src/main/kotlin/a/d/Tool.kt',
  'README.md',
];

const KOTLIN = [
  'app/src/main/kotlin/a/b/Impl.kt',
  'app/src/debug/kotlin/a/b/Debug.kt',
  'core/data/src/main/kotlin/a/c/Repo.kt',
];

describe('parseSettingsIncludes', () => {
  it('reads single-line and multi-line include statements', () => {
    expect(parseSettingsIncludes(['include(":app")', 'include ":core:data", ":other"'].join('\n'))).toEqual([
      ':app',
      ':core:data',
      ':other',
    ]);
  });

  it('reads a continuation across lines', () => {
    expect(parseSettingsIncludes('include(\n  ":app",\n  ":core:data"\n)')).toEqual([':app', ':core:data']);
  });

  it('ANTI: includeBuild and a commented-out include contribute nothing', () => {
    expect(parseSettingsIncludes(['includeBuild("../shared")', '// include(":ghost")'].join('\n'))).toEqual([]);
  });

  it('ANTI: a non-Gradle-path string is not an include', () => {
    expect(parseSettingsIncludes('rootProject.name = "thing"')).toEqual([]);
  });
});

describe('gradlePathToDir', () => {
  it('maps a colon path to a directory', () => {
    expect(gradlePathToDir(':core:data')).toBe('core/data');
    expect(gradlePathToDir(':app')).toBe('app');
  });
});

describe('discoverGradleLayout', () => {
  const settings = 'include(":app", ":core:data", ":tools:notamodule")';

  it('keeps a module root only when a build file exists, and always keeps the repo root', () => {
    const layout = discoverGradleLayout(ALL, KOTLIN, settings);
    expect(layout.moduleRoots).toEqual(['', 'app', 'core/data']);
    expect(moduleBuildFile('app', ALL)).toBe('app/build.gradle.kts');
    expect(moduleBuildFile('tools/notamodule', ALL)).toBeUndefined();
  });

  it('ANTI: no settings file collapses the module roots to the repo root, without throwing', () => {
    const layout = discoverGradleLayout(ALL, KOTLIN, undefined);
    expect(layout.moduleRoots).toEqual(['']);
    expect(findSettingsFile(['README.md'])).toBeUndefined();
    expect(findSettingsFile(ALL)).toBe('settings.gradle.kts');
  });

  it('derives source sets from the IN-SCOPE Kotlin files only', () => {
    const layout = discoverGradleLayout(ALL, KOTLIN, settings);
    expect(layout.sourceSetDirs).toEqual(['app/src/debug', 'app/src/main', 'core/data/src/main']);
  });

  it('ANTI: a source set with no in-scope Kotlin file contributes no XML at all', () => {
    const layout = discoverGradleLayout(ALL, ['core/data/src/main/kotlin/a/c/Repo.kt'], settings);
    expect(layout.sourceSetDirs).toEqual(['core/data/src/main']);
    expect(layout.manifestFiles).toEqual([]);
    expect(layout.layoutFiles).toEqual([]);
    expect(layout.navigationFiles).toEqual([]);
  });

  it('finds manifests, navigation and layout files under in-scope source sets', () => {
    const layout = discoverGradleLayout(ALL, KOTLIN, settings);
    expect(layout.manifestFiles).toEqual(['app/src/debug/AndroidManifest.xml', 'app/src/main/AndroidManifest.xml']);
    expect(layout.navigationFiles).toEqual(['app/src/main/res/navigation/nav_main.xml']);
    expect(layout.layoutFiles).toEqual(['app/src/main/res/layout/view_thing.xml']);
  });
});

describe('resolveLayoutFile', () => {
  const layouts = ['app/src/main/res/layout/view_thing.xml'];

  it('resolves a layout name to its file', () => {
    expect(resolveLayoutFile('view_thing', layouts)).toBe('app/src/main/res/layout/view_thing.xml');
  });

  it('ANTI: an unknown layout name resolves to nothing', () => {
    expect(resolveLayoutFile('missing', layouts)).toBeUndefined();
  });
});
