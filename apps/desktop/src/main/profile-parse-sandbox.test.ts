import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { buildMacParseSandboxProfile, buildSandboxedParseEnvironment } from './profile-parse-sandbox.js';
import { resolveMacGit } from './git-runtime.js';

const temporaryRoots: string[] = [];

function makeTemporaryRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `${label}-`));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('profile parse sandbox policy', () => {
  it('constructs a credential-free environment from an ambient desktop environment', () => {
    const env = buildSandboxedParseEnvironment({
      sourceEnv: {
        PATH: '/attacker/bin:/usr/bin',
        HOME: '/Users/example',
        ANTHROPIC_API_KEY: 'claude-secret',
        CODEX_API_KEY: 'codex-secret',
        OPENAI_BASE_URL: 'https://attacker.invalid',
        COREDOC_POSTHOG_KEY: 'posthog-secret',
        COREDOC_SERVER_URL: 'https://cloud.invalid',
        COREDOC_RUNTIME_MODULES: '/Applications/Coredoc.app/runtime/node_modules',
        COREDOC_TREESITTER_WASM_DIR: '/Users/example/Library/Coredoc/tree-sitter',
        COREDOC_PROFILE_SCHEMA_DIR: '/Applications/Coredoc.app/runtime/profile-parser',
        ELECTRON_RUN_AS_NODE: '1',
      },
      nodeExecutable: '/Applications/Coredoc.app/Contents/MacOS/Coredoc',
      runtimeBinDirs: ['/Applications/Coredoc.app/runtime/node_modules/.bin'],
      temporaryDir: '/private/tmp/coredoc-profile-parse-123',
      databaseUrl: 'file:/Users/example/Library/Coredoc/workspace/coredoc.db.d/project.db',
    });

    expect(env).toEqual({
      PATH: '/Applications/Coredoc.app/Contents/MacOS:/Applications/Coredoc.app/runtime/node_modules/.bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin',
      HOME: '/private/tmp/coredoc-profile-parse-123',
      TMPDIR: '/private/tmp/coredoc-profile-parse-123',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      ELECTRON_RUN_AS_NODE: '1',
      COREDOC_DB_BACKEND: 'sqlite',
      COREDOC_SQLITE_URL: 'file:/Users/example/Library/Coredoc/workspace/coredoc.db.d/project.db',
      COREDOC_TELEMETRY_DISABLED: '1',
      COREDOC_RUNTIME_MODULES: '/Applications/Coredoc.app/runtime/node_modules',
      COREDOC_TREESITTER_WASM_DIR: '/Users/example/Library/Coredoc/tree-sitter',
      COREDOC_PROFILE_SCHEMA_DIR: '/Applications/Coredoc.app/runtime/profile-parser',
    });
    expect(JSON.stringify(env)).not.toContain('secret');
    expect(JSON.stringify(env)).not.toContain('attacker');
    expect(env.COREDOC_SERVER_URL).toBeUndefined();
    expect(env.COREDOC_POSTHOG_KEY).toBeUndefined();
  });

  it('re-allows only declared user-data roots and then re-denies credential files', () => {
    const profile = buildMacParseSandboxProfile({
      homeDir: '/Users/example',
      readPaths: ['/Users/example/work/repo', '/Applications/Coredoc.app'],
      readFiles: ['/Users/example/Library/Coredoc/workspace/project-a.db'],
      writePaths: ['/Users/example/Library/Coredoc/workspace/compiled/project-a/repo-a'],
      writeFiles: [
        '/Users/example/Library/Coredoc/workspace/output/project-a/repo-a.json',
        '/Users/example/Library/Coredoc/workspace/project-a.db',
      ],
      temporaryDir: '/private/tmp/coredoc-profile-parse-123',
      deniedReadPaths: ['/Users/example/Library/Coredoc/workspace/.env'],
    });

    const denyHome = profile.indexOf('(deny file-read* (subpath "/Users/example"))');
    const allowRepo = profile.indexOf('(allow file-read* (subpath "/Users/example/work/repo"))');
    const denyWorkspaceEnv = profile.indexOf(
      '(deny file-read* (literal "/Users/example/Library/Coredoc/workspace/.env"))',
    );
    const denyCredentialNames = profile.lastIndexOf('(deny file-read* (regex #".*/\\.env(\\..*)?$"))');

    expect(detectInvalidProfileRule(profile)).toBeUndefined();
    expect(denyHome).toBeLessThan(allowRepo);
    expect(allowRepo).toBeLessThan(denyWorkspaceEnv);
    expect(denyWorkspaceEnv).toBeLessThan(denyCredentialNames);
    expect(profile).toContain('(deny network*)');
    expect(profile).toContain(
      '(allow file-write* (literal "/Users/example/Library/Coredoc/workspace/output/project-a/repo-a.json"))',
    );
    expect(profile).not.toContain('(allow file-read* (subpath "/Users/example/Library/Coredoc/workspace"))');
    expect(profile).not.toContain('(allow file-write* (subpath "/Users/example/work/repo"))');
  });
});

// Keeps malformed generated policy failures readable instead of letting sandbox-exec be the first
// observer. This is deliberately tiny: balanced parentheses and a version declaration catch the
// builder regressions that make the whole profile invalid.
function detectInvalidProfileRule(profile: string): string | undefined {
  if (!profile.startsWith('(version 1)')) return 'missing version';
  let depth = 0;
  for (const char of profile) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (depth < 0) return 'unbalanced closing parenthesis';
  }
  return depth === 0 ? undefined : 'unbalanced opening parenthesis';
}

describe.skipIf(process.platform !== 'darwin')('macOS profile parse sandbox', () => {
  it.skipIf(!existsSync('/Library/Developer/CommandLineTools/usr/bin/clang'))(
    'cannot recover a host process token through numeric sysctl',
    () => {
      const root = makeTemporaryRoot('profile-sysctl');
      const source = join(root, 'probe.c');
      const binary = join(root, 'probe');
      // Query only this dummy process, never Electron, the test runner, or another user process.
      const host = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        env: { COREDOC_DUMMY_TOKEN: 'fixture-only' },
        stdio: 'ignore',
      });
      try {
        writeFileSync(
          source,
          `#include <sys/types.h>
#include <sys/sysctl.h>
#include <stdlib.h>
#include <stdio.h>
#include <errno.h>
#include <string.h>
#include <unistd.h>
int main(int argc, char **argv) {
  int mib[] = { CTL_KERN, KERN_PROCARGS2, strcmp(argv[1], "self") == 0 ? getpid() : atoi(argv[1]) };
  char buffer[262144]; size_t size = sizeof(buffer);
  if (sysctl(mib, 3, buffer, &size, NULL, 0) != 0) { printf("denied:%d\\n", errno); return 0; }
  const char *token = "COREDOC_DUMMY_TOKEN=fixture-only";
  int found = 0;
  for (size_t i = 0; i + strlen(token) <= size; ++i)
    if (memcmp(buffer + i, token, strlen(token)) == 0) found = 1;
  printf("readable:%d\\n", found);
}`,
        );
        const compile = spawnSync(
          '/Library/Developer/CommandLineTools/usr/bin/clang',
          ['-isysroot', '/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk', source, '-o', binary],
          { encoding: 'utf8' },
        );
        expect(compile.status, compile.stderr).toBe(0);
        expect(spawnSync(binary, [String(host.pid)], { encoding: 'utf8' }).stdout.trim()).toBe('readable:1');
        const policy = buildMacParseSandboxProfile({
          homeDir: process.env.HOME!,
          readPaths: [root],
          readFiles: [],
          writePaths: [root],
          writeFiles: [],
          temporaryDir: root,
          deniedReadPaths: [],
        });
        const probe = (pid: string) =>
          spawnSync('/usr/bin/sandbox-exec', ['-p', policy, binary, pid], {
            cwd: root,
            env: {},
            encoding: 'utf8',
          });
        const other = probe(String(host.pid));
        expect(other.status, other.stderr).toBe(0);
        expect(other.stdout.trim()).toMatch(/^denied:(1|13)$/);
        expect(probe('self').stdout.trim()).toBe('readable:0');
      } finally {
        host.kill('SIGKILL');
      }
    },
  );

  it.skipIf(!existsSync('/Library/Developer/CommandLineTools/usr/bin/clang'))(
    'denies host Mach service lookup without accessing service data',
    () => {
      const root = makeTemporaryRoot('profile-mach');
      const source = join(root, 'lookup.c');
      const binary = join(root, 'lookup');
      // Lookup only: never request clipboard contents, account records or other user data.
      writeFileSync(
        source,
        `#include <mach/mach.h>
#include <servers/bootstrap.h>
#include <stdio.h>
int main(void) {
  mach_port_t port = MACH_PORT_NULL;
  printf("%d\\n", bootstrap_look_up(bootstrap_port, "com.apple.pasteboard.1", &port));
  if (port != MACH_PORT_NULL) mach_port_deallocate(mach_task_self(), port);
}`,
      );
      const compile = spawnSync(
        '/Library/Developer/CommandLineTools/usr/bin/clang',
        ['-isysroot', '/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk', source, '-o', binary],
        { encoding: 'utf8' },
      );
      expect(compile.status, compile.stderr).toBe(0);
      const policy = buildMacParseSandboxProfile({
        homeDir: process.env.HOME!,
        temporaryDir: root,
        readPaths: [root],
        readFiles: [],
        writePaths: [root],
        writeFiles: [],
        deniedReadPaths: [],
      });
      const run = (rules: string) =>
        spawnSync('/usr/bin/sandbox-exec', ['-p', rules, binary], {
          cwd: root,
          env: {},
          encoding: 'utf8',
          timeout: 5000,
        });
      // A positive control proves the service exists and the probe actually reaches it.
      expect(run(policy + '\n(allow mach-lookup)').stdout.trim()).toBe('0');
      const denied = run(policy);
      expect(denied.status, denied.stderr).toBe(0);
      expect(denied.stdout.trim()).not.toBe('0');
    },
  );

  it('runs Git discovery without Xcode cache writes and preserves ignore rules', () => {
    const root = makeTemporaryRoot('coredoc-git-discovery');
    const repo = join(root, 'repo');
    const home = join(root, 'home');
    mkdirSync(repo);
    mkdirSync(home);
    const git = resolveMacGit();
    const gitDirectory = git.directory;
    const policy = buildMacParseSandboxProfile({
      homeDir: process.env.HOME!,
      readPaths: [repo, ...git.readPaths],
      readFiles: [],
      writePaths: [home],
      writeFiles: [],
      temporaryDir: home,
      deniedReadPaths: [],
    });
    const env = buildSandboxedParseEnvironment({
      sourceEnv: {},
      nodeExecutable: process.execPath,
      runtimeBinDirs: [gitDirectory],
      temporaryDir: home,
      databaseUrl: '',
    });
    const probe = (args: string[]) =>
      spawnSync(
        '/usr/bin/sandbox-exec',
        ['-p', policy, join(gitDirectory, 'git'), '-c', 'core.fsmonitor=false', '-C', repo, ...args],
        { cwd: home, env, encoding: 'utf8' },
      );
    const missing = probe(['rev-parse', '--show-toplevel']);
    expect(missing.status).toBe(128);
    expect(missing.stderr).toMatch(/^fatal: not a git repository/);
    expect(spawnSync(join(gitDirectory, 'git'), ['init', '--quiet', repo]).status).toBe(0);
    writeFileSync(join(repo, '.gitignore'), 'ignored.rb\n');
    writeFileSync(join(repo, 'ignored.rb'), 'ignored');
    writeFileSync(join(repo, 'kept.rb'), 'class Kept; end');
    const list = probe(['ls-files', '--cached', '--others', '--exclude-standard']);
    expect(list.status, list.stderr).toBe(0);
    expect(list.stdout).toContain('kept.rb');
    expect(list.stdout).not.toContain('ignored.rb');
  });

  it('allows parsing roots while blocking sibling secrets and loopback egress', () => {
    const root = makeTemporaryRoot('coredoc-profile-sandbox');
    const repoDir = join(root, 'repo');
    const outputDir = join(root, 'output');
    const sandboxTemp = join(root, 'sandbox-home');
    const secretPath = join(root, 'host-secret.txt');
    const targetDb = join(outputDir, 'project-a.db');
    const otherDb = join(outputDir, 'project-b.db');
    const targetOutput = join(outputDir, 'project-a.json');
    const otherOutput = join(outputDir, 'project-b.json');
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(outputDir, { recursive: true });
    mkdirSync(sandboxTemp, { recursive: true });
    writeFileSync(join(repoDir, 'source.txt'), 'repo-source');
    writeFileSync(secretPath, 'must-not-leak');
    writeFileSync(targetDb, 'target-db');
    writeFileSync(otherDb, 'other-db');
    writeFileSync(otherOutput, 'other-output');

    const nodeRoot = resolve(dirname(process.execPath), '..', '..');
    const profile = buildMacParseSandboxProfile({
      homeDir: process.env.HOME ?? '/Users/unknown',
      readPaths: [repoDir, nodeRoot, sandboxTemp],
      readFiles: [targetDb, targetOutput],
      writePaths: [sandboxTemp],
      writeFiles: [targetDb, targetOutput],
      temporaryDir: sandboxTemp,
      deniedReadPaths: [secretPath],
    });
    const env = buildSandboxedParseEnvironment({
      sourceEnv: { PATH: process.env.PATH, LEAK_ME: 'ambient-secret' },
      nodeExecutable: process.execPath,
      runtimeBinDirs: [],
      temporaryDir: sandboxTemp,
      databaseUrl: `file:${join(outputDir, 'project.db')}`,
    });
    const script = `
      const fs = process.getBuiltinModule('node:fs');
      const net = process.getBuiltinModule('node:net');
      const [repoFile, secretFile, outputFile, targetDb, otherDb, otherOutput] = process.argv.slice(1);
      const result = {
        repo: fs.readFileSync(repoFile, 'utf8'), secret: null, otherDb: null, otherOutput: null,
        network: null, env: process.env.LEAK_ME, cwd: null
      };
      try { result.cwd = process.cwd(); } catch (error) { result.cwd = 'FAIL:' + error.code; }
      try { fs.readFileSync(secretFile, 'utf8'); result.secret = 'READ'; }
      catch (error) { result.secret = error.code; }
      try { fs.readFileSync(otherDb, 'utf8'); result.otherDb = 'READ'; }
      catch (error) { result.otherDb = error.code; }
      try { fs.writeFileSync(otherOutput, 'corrupt'); result.otherOutput = 'WROTE'; }
      catch (error) { result.otherOutput = error.code; }
      fs.writeFileSync(outputFile, 'sandbox-write');
      fs.writeFileSync(targetDb, 'target-db-updated');
      const socket = net.connect({ host: '127.0.0.1', port: 9 });
      socket.once('connect', () => { result.network = 'CONNECTED'; socket.destroy(); finish(); });
      socket.once('error', (error) => { result.network = error.code; finish(); });
      const timer = setTimeout(() => { result.network = 'TIMEOUT'; socket.destroy(); finish(); }, 1000);
      function finish() { clearTimeout(timer); process.stdout.write(JSON.stringify(result)); }
    `;
    const result = spawnSync(
      '/usr/bin/sandbox-exec',
      [
        '-p',
        profile,
        process.execPath,
        '-e',
        script,
        join(repoDir, 'source.txt'),
        secretPath,
        targetOutput,
        targetDb,
        otherDb,
        otherOutput,
      ],
      // Production (spawnSandboxedParse) pins the child's cwd to the run directory — the one
      // always-allowed root — because getcwd(3) fails with EPERM when cwd itself is denied.
      { env, encoding: 'utf8', timeout: 5000, cwd: sandboxTemp },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      repo: 'repo-source',
      secret: 'EPERM',
      otherDb: 'EPERM',
      otherOutput: 'EPERM',
      network: 'EPERM',
      cwd: realpathSync(sandboxTemp),
    });
    expect(readFileSync(targetOutput, 'utf8')).toBe('sandbox-write');
    expect(readFileSync(targetDb, 'utf8')).toBe('target-db-updated');
    expect(readFileSync(otherOutput, 'utf8')).toBe('other-output');

    // Regression guard for the uv_cwd failure: the same policy with cwd in a denied directory
    // makes the very first process.cwd() throw EPERM — which is why the spawn above must never
    // inherit a workspace/monorepo cwd.
    const deniedCwdProbe = spawnSync(
      '/usr/bin/sandbox-exec',
      [
        '-p',
        profile,
        process.execPath,
        '-e',
        'try { process.stdout.write(process.cwd()) } catch (e) { process.stdout.write("FAIL:" + e.code) }',
      ],
      { env, encoding: 'utf8', timeout: 5000, cwd: root },
    );
    expect(deniedCwdProbe.stdout).toBe('FAIL:EPERM');
  });
});
