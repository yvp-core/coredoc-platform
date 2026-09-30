#!/usr/bin/env node
/**
 * Maintainer tool for the offline on-prem license (issue 02).
 *
 *   node scripts/license-tool.mjs keygen  --out ~/coredoc-license-keys
 *   node scripts/license-tool.mjs issue   --key ~/coredoc-license-keys/coredoc-license-private.pem \
 *                                         --customer acme-corp --expires 2027-08-27 --grace-days 30
 *   node scripts/license-tool.mjs verify  --license coredoc-license.json [--public-key <pem file>]
 *
 * Signing and verification go through src/modules/license/license-format.mjs —
 * the same module the server runs — so a license this tool emits and a license
 * the server accepts can never drift apart.
 *
 * The private key NEVER enters this repository: `keygen` refuses to write
 * anywhere inside the repo, and the public key it prints is what release ops
 * pastes into LICENSE_PUBLIC_KEY_PEM.
 */

import { generateKeyPairSync, createPrivateKey, sign as cryptoSign } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, parse as parsePath, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  LICENSE_PUBLIC_KEY_PEM,
  canonicalizeLicensePayload,
  isPlaceholderPublicKey,
  parseLicenseDocument,
  validateLicensePayload,
  verifyLicenseSignature,
} from '../src/modules/license/license-format.mjs';

// realpath, not just resolve: the containment check below compares two
// CANONICAL paths, and the checkout itself can sit under a symlinked ancestor
// (a worktree under /var on macOS, /home -> /export/home on some Linux boxes).
const REPO_ROOT = realpathSync(resolve(fileURLToPath(new URL('../../..', import.meta.url))));
const USAGE = `Usage:
  license-tool.mjs keygen --out <NEW directory OUTSIDE this repo; its parent must exist>
  license-tool.mjs issue  --key <private.pem> --customer <name> --expires <YYYY-MM-DD>
                          [--grace-days <n>] [--issued <YYYY-MM-DD>] [--out <file>]
  license-tool.mjs verify --license <file> [--public-key <pem file>]`;

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function isInsideRepo(target) {
  const rel = relative(REPO_ROOT, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Canonical form of an EXISTING directory, or exit.
 *
 * A LEXICAL check on the requested path is not enough: a symlinked PARENT
 * directory (`/tmp/keys -> <checkout>/keys`) points at a path that no string
 * comparison can see, so the private signing key lands in the repository while
 * the tool reports success. So walk the path root-first, lstat every component,
 * refuse any symlink among them, and return the realpath.
 *
 * Every component must already exist. Creating missing ancestors would reopen
 * the race this function closes: components checked now, directories created a
 * moment later, and another local user free to plant a symlink in between (a
 * shared parent like /tmp is the realistic case). The operator creates the
 * parent; keygen creates only the final directory, and only exclusively.
 *
 * Refusing symlinked components outright (rather than silently following them)
 * keeps the decision the operator can audit: they pass the resolved path, and
 * what they typed is where the key goes.
 */
function canonicalizeExistingParent(parent) {
  const target = resolve(parent);
  const { root } = parsePath(target);
  const components = target.slice(root.length).split(sep).filter(Boolean);
  let walked = root;
  for (const component of components) {
    const next = join(walked, component);
    let stats;
    try {
      stats = lstatSync(next);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        fail(
          `the parent directory ${next} does not exist.\n` +
            'keygen creates only the final --out directory, and only exclusively: creating missing\n' +
            'ancestors would leave a window in which another local user can plant a symlink where the\n' +
            'signing key is about to be written. Create the parent yourself first, then re-run.',
        );
        return '';
      }
      fail(`cannot inspect ${next}: ${error instanceof Error ? error.message : String(error)}`);
      return '';
    }
    if (stats.isSymbolicLink()) {
      fail(
        `refusing to write license keys through the symlink ${next}.\n` +
          `It currently points at ${realpathSync(next)}, which is not what --out says — a symlinked\n` +
          'directory is exactly how a signing key ends up somewhere it must never be (this repo).\n' +
          'Pass the resolved path instead.',
      );
      return '';
    }
    if (!stats.isDirectory()) {
      fail(`refusing to write license keys under ${next}: it exists and is not a directory.`);
      return '';
    }
    walked = next;
  }
  return realpathSync(walked);
}

/**
 * Refuse a --out whose PARENT CHAIN lets a local user swap the key directory.
 *
 * The race this closes (reproduced by a reviewer): keygen mkdirs 0700, verifies
 * the realpath, generates the keypair, and only then opens the key files BY
 * PATHNAME. If any directory on the way to --out is writable by someone else,
 * that someone renames our fresh directory aside and drops a symlink in its
 * place inside that window; the private key lands in their decoy directory while
 * keygen prints success. Node exposes no openat()/O_NOFOLLOW-on-a-directory-fd
 * API, so a descriptor-relative write to a re-verified directory is simply not
 * available in this runtime — this precondition IS the guarantee, and the
 * O_NOFOLLOW opens in writeKeyFile only narrow the residual final-component
 * window.
 *
 * The rule is ssh's "safe path": walk every component from the filesystem root
 * down to and including the immediate parent, and refuse when
 *  - group or other hold write permission WITHOUT the sticky bit — in a sticky
 *    directory (/tmp at 1777) only the entry's own owner may rename or delete
 *    it, so our 0700 directory cannot be swapped; without it, anyone with write
 *    access there can;
 *  - the component is owned by neither this user nor root — its owner can
 *    chmod or rename it back into an unsafe state at any moment, so the current
 *    mode bits prove nothing.
 */
function assertSafeParentChain(canonicalParent) {
  const uid = process.getuid();
  const { root } = parsePath(canonicalParent);
  const chain = [root];
  let walked = root;
  for (const component of canonicalParent.slice(root.length).split(sep).filter(Boolean)) {
    walked = join(walked, component);
    chain.push(walked);
  }
  for (const dir of chain) {
    let stats;
    try {
      stats = statSync(dir);
    } catch (error) {
      fail(`cannot inspect ${dir}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (stats.uid !== uid && stats.uid !== 0) {
      fail(
        `refusing to write license keys: unsafe parent directory ${dir} is owned by uid ${stats.uid}, ` +
          `neither you (uid ${uid}) nor root.\n` +
          'Its owner can rename or re-permission it at any moment, so no permission check on it means\n' +
          'anything. Pass an --out under a directory chain you own, e.g. a 0700 directory under $HOME.',
      );
      return;
    }
    if ((stats.mode & 0o022) !== 0 && (stats.mode & 0o1000) === 0) {
      fail(
        `refusing to write license keys: unsafe parent directory ${dir} is group/other-writable ` +
          `(mode ${(stats.mode & 0o7777).toString(8).padStart(4, '0')}) and has no sticky bit.\n` +
          'Any local user with write access there can rename the key directory aside and substitute a\n' +
          'symlink after keygen creates it, so the private signing key would be written into THEIR\n' +
          'directory while keygen reports success (the writes go by pathname; Node has no openat()).\n' +
          'Use a private parent instead, e.g. a 0700 directory under $HOME, or a sticky one (/tmp, 1777).',
      );
      return;
    }
  }
}

/**
 * Create the --out directory exclusively, then prove it is still the directory
 * that was vetted.
 *
 * `recursive: false` makes mkdir fail with EEXIST on ANY pre-existing entry —
 * including a symlink another local user planted between the parent check and
 * this call, which is the whole point: the race cannot be won silently, only
 * refused. A leftover real directory from a partial run is refused too, because
 * keygen must never write into a directory that might already hold a production
 * signing key.
 */
function createOutDir(dir) {
  try {
    mkdirSync(dir, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      fail(
        `refusing to use the existing ${dir}.\n` +
          'keygen creates its --out directory itself and never writes into one that already exists: it\n' +
          'may hold a production signing key (every license issued from it becomes un-renewable if it is\n' +
          'replaced), or it may be a symlink planted between the parent check and this write. Pass a\n' +
          'fresh --out path, or remove/move the existing directory aside deliberately if you are rotating.',
      );
      return;
    }
    fail(`cannot create ${dir}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  // Cheap proof that the directory just created is the one that was vetted:
  // canonical location unchanged, parent unchanged, still outside the repo.
  const canonical = realpathSync(dir);
  if (canonical !== dir || isInsideRepo(canonical)) {
    fail(
      `refusing to write license keys: ${dir} resolves to ${canonical} after creation, which is not where\n` +
        '--out pointed. Nothing was written. Re-run with a path whose parents you control.',
    );
    return;
  }
  // mkdir's mode is a request (umask applies, some filesystems ignore it) and
  // the entry we just made is the one about to hold a private signing key —
  // assert what actually landed instead of assuming 0700 and our own uid.
  const stats = statSync(dir);
  if (stats.uid !== process.getuid() || (stats.mode & 0o077) !== 0) {
    fail(
      `refusing to write license keys into ${dir}: it is owned by uid ${stats.uid} with mode ` +
        `${(stats.mode & 0o7777).toString(8).padStart(4, '0')} after creation, not yours at 0700.\n` +
        'Nothing was written. Use a filesystem that supports POSIX permissions, and a parent directory\n' +
        'no other local user can write to.',
    );
  }
}

function requireOption(values, name) {
  const value = values[name];
  if (typeof value !== 'string' || value.trim() === '') fail(`--${name} is required\n\n${USAGE}`);
  return value.trim();
}

function requireIsoDate(value, flag) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
    fail(`--${flag} must be an ISO date (YYYY-MM-DD), got "${value}"`);
  }
  return value;
}

/**
 * Create a key file, refusing to follow a symlink at the final component.
 *
 * O_EXCL|O_NOFOLLOW rather than writeFileSync's `wx`: `wx` is O_CREAT|O_EXCL,
 * which already refuses an existing entry, but O_NOFOLLOW states the intent the
 * signing key depends on — never open through a symlink someone planted at this
 * exact name. This is defense in depth only; assertSafeParentChain is what makes
 * the directory-swap attack impossible, because Node has no openat() with which
 * to write relative to an already-verified directory descriptor.
 */
function writeKeyFile(path, contents, mode) {
  let fd;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  } catch (error) {
    fail(`cannot create ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  try {
    writeSync(fd, contents);
  } catch (error) {
    fail(`cannot write ${path}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    closeSync(fd);
  }
}

/**
 * The `mode` passed to openSync is only a request (umask applies, and some
 * filesystems ignore it), so verify what actually landed on disk and repair it —
 * a world-readable private signing key is the failure this tool exists to avoid.
 */
function assertMode(path, expected) {
  if ((statSync(path).mode & 0o777) === expected) return;
  try {
    chmodSync(path, expected);
  } catch (error) {
    fail(
      `cannot set mode ${expected.toString(8)} on ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const actual = statSync(path).mode & 0o777;
  if (actual !== expected) {
    fail(
      `${path} has mode ${actual.toString(8)} after chmod, expected ${expected.toString(8)} — delete it and use a filesystem that supports POSIX permissions.`,
    );
  }
}

function keygen(argv) {
  const { values } = parseArgs({ args: argv, options: { out: { type: 'string' } }, allowPositionals: false });
  // POSIX-only by construction: every guarantee below (owner/mode of the parent
  // chain, the sticky-bit rule, O_NOFOLLOW) is a POSIX one. Refuse rather than
  // silently generating a signing key without them.
  if (typeof process.getuid !== 'function' || constants.O_NOFOLLOW === undefined) {
    fail('keygen requires a POSIX filesystem: it verifies directory ownership and permissions before writing.');
  }
  const out = requireOption(values, 'out');
  const target = resolve(out);
  const name = basename(target);
  if (name === '') fail(`refusing to write license keys to the filesystem root (${target}).`);
  const canonicalParent = canonicalizeExistingParent(dirname(target));
  const dir = join(canonicalParent, name);
  if (isInsideRepo(dir)) {
    fail(
      `refusing to write license keys inside the repository (${dir}).\n` +
        'The signing key must never be committed — pass a path outside the repo, e.g. ~/coredoc-license-keys.',
    );
  }
  // Both checks fail closed BEFORE generating: an existing --out may hold a
  // production signing key, and overwriting one is irreversible — every license
  // already issued from it becomes un-renewable, and swapping
  // LICENSE_PUBLIC_KEY_PEM to the new key invalidates them all.
  assertSafeParentChain(canonicalParent);
  createOutDir(dir);
  const privatePath = join(dir, 'coredoc-license-private.pem');
  const publicPath = join(dir, 'coredoc-license-public.pem');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  writeKeyFile(privatePath, privatePem, 0o600);
  writeKeyFile(publicPath, publicPem, 0o644);
  assertMode(privatePath, 0o600);
  console.log(`private key: ${privatePath}  (keep offline, never commit)`);
  console.log(`public key:  ${publicPath}`);
  console.log('\nPaste this into LICENSE_PUBLIC_KEY_PEM in src/modules/license/license-format.mjs:\n');
  console.log(publicPem);
}

function issue(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      key: { type: 'string' },
      customer: { type: 'string' },
      expires: { type: 'string' },
      issued: { type: 'string' },
      'grace-days': { type: 'string' },
      out: { type: 'string' },
    },
    allowPositionals: false,
  });
  const keyPath = requireOption(values, 'key');
  const customer = requireOption(values, 'customer');
  const expiresAt = requireIsoDate(requireOption(values, 'expires'), 'expires');
  const issuedAt = requireIsoDate(values.issued?.trim() || new Date().toISOString().slice(0, 10), 'issued');
  const graceRaw = values['grace-days']?.trim() ?? '0';
  const graceDays = Number(graceRaw);
  if (!Number.isInteger(graceDays) || graceDays < 0)
    fail(`--grace-days must be a non-negative integer, got "${graceRaw}"`);
  const outPath = resolve(values.out?.trim() || 'coredoc-license.json');

  let privateKey;
  try {
    privateKey = createPrivateKey(readFileSync(keyPath, 'utf8'));
  } catch (error) {
    return fail(`cannot read the signing key ${keyPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    fail(`signing key must be ed25519, got ${privateKey.asymmetricKeyType ?? 'unknown'}`);
  }

  // Field order here is irrelevant — canonicalizeLicensePayload sorts keys.
  const payload = validateLicensePayload({ customer, issuedAt, expiresAt, graceDays });
  const signature = cryptoSign(null, Buffer.from(canonicalizeLicensePayload(payload), 'utf8'), privateKey).toString(
    'base64',
  );
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify({ payload, signature }, null, 2)}\n`);
  console.log(`wrote ${outPath}`);
  console.log(`  customer:  ${customer}`);
  console.log(`  issuedAt:  ${issuedAt}`);
  console.log(`  expiresAt: ${expiresAt} (+${graceDays} grace days)`);
}

function verify(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { license: { type: 'string' }, 'public-key': { type: 'string' } },
    allowPositionals: false,
  });
  const licensePath = resolve(requireOption(values, 'license'));
  const keyFile = values['public-key']?.trim();
  const publicKeyPem = keyFile ? readFileSync(keyFile, 'utf8') : LICENSE_PUBLIC_KEY_PEM;
  if (!keyFile && isPlaceholderPublicKey(publicKeyPem)) {
    fail(
      'LICENSE_PUBLIC_KEY_PEM is still the placeholder in this checkout — ' +
        'pass --public-key <file> to verify against a specific key.',
    );
  }
  let document;
  try {
    document = parseLicenseDocument(readFileSync(licensePath, 'utf8'));
    verifyLicenseSignature(document, publicKeyPem);
  } catch (error) {
    return fail(`${licensePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const daysLeft = Math.floor((Date.parse(document.payload.expiresAt) - Date.now()) / 86_400_000);
  console.log(`signature OK — ${licensePath}`);
  console.log(`  customer:  ${document.payload.customer}`);
  console.log(`  issuedAt:  ${document.payload.issuedAt}`);
  console.log(`  expiresAt: ${document.payload.expiresAt} (${daysLeft} day(s) from now)`);
  console.log(`  graceDays: ${document.payload.graceDays ?? 0}`);
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case 'keygen':
    keygen(rest);
    break;
  case 'issue':
    issue(rest);
    break;
  case 'verify':
    verify(rest);
    break;
  default:
    console.error(command ? `error: unknown command "${command}"\n\n${USAGE}` : USAGE);
    process.exit(1);
}
