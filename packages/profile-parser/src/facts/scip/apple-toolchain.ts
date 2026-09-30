import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { outsideSource } from './isolated-process.js';

/** Use installed compiler binaries directly: Apple's /usr/bin shims need host caches/Xcode services. */
export function appleToolchain(repoRoot: string): {
  readRoots: string[];
  bin?: string;
  env: NodeJS.ProcessEnv;
  cacheIdentity?: string;
} {
  if (process.platform !== 'darwin') return { readRoots: [], env: {} };
  let selected: string;
  try {
    selected = execFileSync('/usr/bin/xcode-select', ['-p'], {
      cwd: '/',
      env: { PATH: '/usr/bin:/bin' },
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    throw new Error(
      'Enhanced Rust/Go analysis needs Apple command line tools. Run xcode-select --install, select the installed developer directory, or choose basic analysis.',
    );
  }
  if (!isAbsolute(selected)) throw new Error('Invalid installed Apple developer directory.');
  const developer = outsideSource(repoRoot, selected);
  const xcode = existsSync(join(developer, 'Toolchains/XcodeDefault.xctoolchain/usr/bin/clang'));
  const bin = join(developer, xcode ? 'Toolchains/XcodeDefault.xctoolchain/usr/bin' : 'usr/bin');
  const sdk = join(developer, xcode ? 'Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk' : 'SDKs/MacOSX.sdk');
  if (!existsSync(join(bin, 'clang')) || !existsSync(sdk))
    throw new Error(
      'The selected Apple developer directory has no usable clang or macOS SDK. Repair the installation and select it with xcode-select --switch, or choose basic analysis.',
    );
  // Apple updates compiler/SDK builds in place; installation paths cannot identify a cached index.
  const compilerVersion = execFileSync(join(bin, 'clang'), ['--version'], {
    cwd: '/',
    env: { PATH: '/usr/bin:/bin' },
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const cacheIdentity = createHash('sha256')
    .update(compilerVersion)
    .update(readFileSync(join(sdk, 'SDKSettings.json')))
    .digest('hex');
  return {
    cacheIdentity,
    readRoots: [developer],
    bin,
    env: {
      DEVELOPER_DIR: developer,
      SDKROOT: sdk,
      CC: join(bin, 'clang'),
      CXX: join(bin, 'clang++'),
      AR: join(bin, 'ar'),
    },
  };
}
