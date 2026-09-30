/**
 * keygen safety. Colocated with the other license tests (and with
 * license-format.test.ts, which drives the same tool through execFileSync)
 * because the tool and this module are one unit: the tool mints the key the
 * server's verifier trusts.
 *
 * The failure being pinned: keygen used to write both key files
 * unconditionally, so a second run silently replaced a PRODUCTION signing key —
 * irreversibly, since every license already issued from it becomes
 * un-renewable and a public-key swap invalidates them all.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAndVerifyLicense } from './license-format.mjs';

const TOOL = fileURLToPath(new URL('../../../scripts/license-tool.mjs', import.meta.url));
const REPO_ROOT = realpathSync(fileURLToPath(new URL('../../../../..', import.meta.url)));

// Outside the repository on purpose — keygen refuses to write inside it.
// realpath'd because keygen refuses symlinked path COMPONENTS, and macOS puts
// the tmpdir under the /var -> /private/var symlink.
const workDir = realpathSync(mkdtempSync(join(tmpdir(), 'coredoc-license-keygen-')));

afterAll(() => rmSync(workDir, { recursive: true, force: true }));

const PRIVATE_NAME = 'coredoc-license-private.pem';
const PUBLIC_NAME = 'coredoc-license-public.pem';

function run(args: string[]): { status: number; stderr: string; stdout: string } {
  try {
    const stdout = execFileSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', stdio: 'pipe' });
    return { status: 0, stderr: '', stdout };
  } catch (error) {
    const err = error as { status?: number; stderr?: string; stdout?: string };
    return { status: err.status ?? 1, stderr: err.stderr ?? '', stdout: err.stdout ?? '' };
  }
}

/**
 * keygen creates its --out directory itself (exclusively) and requires the
 * PARENT to exist already, so tests hand it a not-yet-existing child of
 * workDir — never a directory they created themselves.
 */
function outDir(name: string): string {
  return join(workDir, name);
}

describe('license-tool.mjs keygen', () => {
  it('writes a usable keypair with a 0600 private key', () => {
    const dir = outDir('happy');

    const result = run(['keygen', '--out', dir]);

    expect(result.status).toBe(0);
    expect(statSync(join(dir, PRIVATE_NAME)).mode & 0o777).toBe(0o600);
    // The printed public key is what release ops pastes into
    // LICENSE_PUBLIC_KEY_PEM, so it must be the one that verifies the licenses
    // this private key signs.
    const publicPem = readFileSync(join(dir, PUBLIC_NAME), 'utf8');
    expect(result.stdout).toContain(publicPem.trim());
    const licensePath = join(dir, 'license.json');
    expect(
      run([
        'issue',
        '--key',
        join(dir, PRIVATE_NAME),
        '--customer',
        'acme-corp',
        '--expires',
        '2099-01-01',
        '--out',
        licensePath,
      ]).status,
    ).toBe(0);
    expect(parseAndVerifyLicense(readFileSync(licensePath, 'utf8'), publicPem)).toMatchObject({
      customer: 'acme-corp',
    });
  });

  it('refuses to overwrite an existing private key and leaves it byte-identical', () => {
    const dir = outDir('rerun');
    expect(run(['keygen', '--out', dir]).status).toBe(0);
    const before = readFileSync(join(dir, PRIVATE_NAME), 'utf8');

    const second = run(['keygen', '--out', dir]);

    expect(second.status).toBe(1);
    expect(second.stderr).toMatch(/refusing to use the existing/);
    expect(readFileSync(join(dir, PRIVATE_NAME), 'utf8')).toBe(before);
  });

  it('refuses an --out directory that already holds key material, generating nothing', () => {
    const dir = outDir('public-only');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, PUBLIC_NAME), 'stale public key\n');

    const result = run(['keygen', '--out', dir]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/refusing to use the existing/);
    expect(() => statSync(join(dir, PRIVATE_NAME))).toThrow();
  });

  // The round-3 reproduction: components were checked, keys generated, and only
  // then was the ORIGINAL pathname mkdir'd recursively — so another local user
  // could plant a symlink AS the output directory inside that window and take
  // delivery of the private key. mkdir({recursive:false}) turns that into
  // EEXIST, which is fail-closed.
  it('refuses a symlink planted as the --out directory instead of writing through it', () => {
    const decoy = join(workDir, 'decoy-dir');
    mkdirSync(decoy, { recursive: true });
    const dir = outDir('symlink-as-out');
    symlinkSync(decoy, dir);

    const result = run(['keygen', '--out', dir]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/refusing to use the existing/);
    expect(existsSync(join(decoy, PRIVATE_NAME))).toBe(false);
  });

  it('refuses an --out whose parent does not exist rather than creating the chain', () => {
    const missingParent = join(workDir, 'not-created-yet');

    const result = run(['keygen', '--out', join(missingParent, 'keys')]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/parent directory .* does not exist/);
    expect(existsSync(missingParent)).toBe(false);
  });

  // The reviewer's reproduction: only the LEXICAL --out path was checked, so a
  // symlinked PARENT directory walked the private signing key straight into the
  // checkout while the tool reported success.
  it('refuses an --out whose parent directory is a symlink into the repository', () => {
    const link = join(workDir, 'link-into-repo');
    const inRepo = join(REPO_ROOT, 'apps/server/tmp-keys-symlink-target');
    mkdirSync(inRepo, { recursive: true });
    symlinkSync(inRepo, link);

    try {
      const result = run(['keygen', '--out', join(link, 'keys')]);

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/refusing to write license keys (through the symlink|inside the repository)/);
      expect(existsSync(join(inRepo, 'keys', PRIVATE_NAME))).toBe(false);
    } finally {
      rmSync(inRepo, { recursive: true, force: true });
    }
  });

  it('refuses an --out reached through a symlinked parent even outside the repository', () => {
    const real = join(workDir, 'real-target');
    mkdirSync(real, { recursive: true });
    const link = join(workDir, 'link-outside');
    symlinkSync(real, link);

    const result = run(['keygen', '--out', join(link, 'keys')]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/refusing to write license keys through the symlink/);
    // Nothing was created through the link either.
    expect(existsSync(join(real, 'keys'))).toBe(false);
  });

  it('still refuses any path inside the repository', () => {
    const result = run(['keygen', '--out', join(REPO_ROOT, 'apps/server/tmp-keys')]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/refusing to write license keys inside the repository/);
  });
});

/**
 * The round-4 reproduction, turned into a precondition instead of a race.
 *
 * The reviewer swapped the freshly created 0700 output directory for a symlink
 * BETWEEN the post-mkdir realpath check and the key writes (writes go by
 * pathname; Node has no openat()), in a 0777 non-sticky parent under
 * /private/tmp — keygen printed success and the private key landed in their
 * decoy directory. The fix refuses such a parent chain outright, so these tests
 * assert the precondition deterministically rather than trying to win a race.
 */
describe('license-tool.mjs keygen parent-chain safety', () => {
  // Running as root makes every directory writable and the whole notion of an
  // "unsafe parent" vacuous, so the refusals below cannot be observed there.
  const asRoot = process.getuid?.() === 0;

  function parentWithMode(name: string, mode: number): string {
    const parent = join(workDir, name);
    mkdirSync(parent, { recursive: true });
    chmodSync(parent, mode);
    return parent;
  }

  it.skipIf(asRoot)('refuses a world-writable non-sticky parent (the reviewer’s repro precondition)', () => {
    const parent = parentWithMode('parent-0777', 0o777);

    const result = run(['keygen', '--out', join(parent, 'keys')]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/unsafe parent directory .* is group\/other-writable/);
    expect(existsSync(join(parent, 'keys'))).toBe(false);
  });

  it.skipIf(asRoot)('refuses an other-writable non-sticky parent', () => {
    const parent = parentWithMode('parent-0707', 0o707);

    const result = run(['keygen', '--out', join(parent, 'keys')]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/unsafe parent directory .* is group\/other-writable/);
    expect(existsSync(join(parent, 'keys'))).toBe(false);
  });

  it.skipIf(asRoot)('refuses a safe parent that hangs under an other-writable non-sticky ancestor', () => {
    const grandparent = parentWithMode('grandparent-0777', 0o777);
    const parent = join(grandparent, 'private-parent');
    mkdirSync(parent);
    chmodSync(parent, 0o700);

    const result = run(['keygen', '--out', join(parent, 'keys')]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(grandparent);
    expect(result.stderr).toMatch(/unsafe parent directory .* is group\/other-writable/);
    expect(existsSync(join(parent, 'keys'))).toBe(false);
  });

  it('accepts a world-writable STICKY parent — only the entry owner can swap our directory there', () => {
    const parent = parentWithMode('parent-1777', 0o1777);

    const result = run(['keygen', '--out', join(parent, 'keys')]);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(statSync(join(parent, 'keys', PRIVATE_NAME)).mode & 0o777).toBe(0o600);
  });

  it('accepts an ordinary 0755 parent', () => {
    const parent = parentWithMode('parent-0755', 0o755);

    const result = run(['keygen', '--out', join(parent, 'keys')]);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(statSync(join(parent, 'keys', PRIVATE_NAME)).mode & 0o777).toBe(0o600);
  });
});
