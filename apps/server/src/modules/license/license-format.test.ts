import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';
import {
  assertValidLicensePublicKey,
  canonicalizeLicensePayload,
  isPlaceholderPublicKey,
  parseAndVerifyLicense,
  parseLicenseDocument,
} from './license-format.mjs';

const TOOL = fileURLToPath(new URL('../../../scripts/license-tool.mjs', import.meta.url));
const FIXTURE_PRIVATE_KEY = fileURLToPath(new URL('./test-fixtures/test-license-private.pem', import.meta.url));
const FIXTURE_PUBLIC_KEY = readFileSync(
  fileURLToPath(new URL('./test-fixtures/test-license-public.pem', import.meta.url)),
  'utf8',
);

const workDir = mkdtempSync(join(tmpdir(), 'coredoc-license-'));

afterAll(() => rmSync(workDir, { recursive: true, force: true }));

function issue(args: string[], outName: string): string {
  const out = join(workDir, outName);
  execFileSync(process.execPath, [TOOL, 'issue', '--key', FIXTURE_PRIVATE_KEY, '--out', out, ...args], {
    encoding: 'utf8',
  });
  return out;
}

describe('canonicalizeLicensePayload', () => {
  it('is insensitive to key order — the signed bytes are the same either way', () => {
    const a = canonicalizeLicensePayload({ customer: 'acme', expiresAt: '2027-08-27', graceDays: 30 });
    const b = canonicalizeLicensePayload({ graceDays: 30, expiresAt: '2027-08-27', customer: 'acme' });

    expect(a).toBe(b);
    expect(a).toBe('{"customer":"acme","expiresAt":"2027-08-27","graceDays":30}');
  });

  it('rejects nested values instead of silently serializing them in insertion order', () => {
    expect(() => canonicalizeLicensePayload({ customer: 'acme', seats: { max: 5 } })).toThrow(/must be a string/);
    expect(() => canonicalizeLicensePayload('acme')).toThrow(/must be a JSON object/);
  });
});

describe('license-tool.mjs ↔ server verifier round trip', () => {
  it('issues a license the server verifier accepts', () => {
    const file = issue(['--customer', 'acme-corp', '--expires', '2027-08-27', '--grace-days', '30'], 'valid.json');

    const payload = parseAndVerifyLicense(readFileSync(file, 'utf8'), FIXTURE_PUBLIC_KEY);

    expect(payload).toMatchObject({ customer: 'acme-corp', expiresAt: '2027-08-27', graceDays: 30 });
  });

  it('verifies its own output through the tool as well', () => {
    const file = issue(['--customer', 'acme-corp', '--expires', '2027-08-27'], 'tool-verify.json');

    const output = execFileSync(
      process.execPath,
      [
        TOOL,
        'verify',
        '--license',
        file,
        '--public-key',
        fileURLToPath(new URL('./test-fixtures/test-license-public.pem', import.meta.url)),
      ],
      { encoding: 'utf8' },
    );

    expect(output).toContain('signature OK');
    expect(output).toContain('acme-corp');
  });

  it('rejects a tampered payload', () => {
    const file = issue(['--customer', 'acme-corp', '--expires', '2026-01-01'], 'tampered.json');
    const document = parseLicenseDocument(readFileSync(file, 'utf8'));
    const tampered = join(workDir, 'tampered-written.json');
    writeFileSync(
      tampered,
      JSON.stringify({ payload: { ...document.payload, expiresAt: '2099-01-01' }, signature: document.signature }),
    );

    expect(() => parseAndVerifyLicense(readFileSync(tampered, 'utf8'), FIXTURE_PUBLIC_KEY)).toThrow(
      /signature does not match/,
    );
  });

  it('rejects a license signed by a different key', () => {
    // realpath'd: keygen refuses symlinked path components, and macOS's tmpdir
    // sits under the /var -> /private/var symlink.
    // keygen creates its own --out directory, so point it at a fresh child.
    const otherKeysParent = realpathSync(mkdtempSync(join(tmpdir(), 'coredoc-license-keys-')));
    const otherKeys = join(otherKeysParent, 'keys');
    execFileSync(process.execPath, [TOOL, 'keygen', '--out', otherKeys], { encoding: 'utf8' });
    const file = join(workDir, 'other-key.json');
    execFileSync(
      process.execPath,
      [
        TOOL,
        'issue',
        '--key',
        join(otherKeys, 'coredoc-license-private.pem'),
        '--customer',
        'evil-corp',
        '--expires',
        '2099-01-01',
        '--out',
        file,
      ],
      { encoding: 'utf8' },
    );

    expect(() => parseAndVerifyLicense(readFileSync(file, 'utf8'), FIXTURE_PUBLIC_KEY)).toThrow(
      /signature does not match/,
    );
    rmSync(otherKeysParent, { recursive: true, force: true });
  });

  it('refuses to write signing keys inside the repository', () => {
    const insideRepo = fileURLToPath(new URL('./test-fixtures/should-never-exist', import.meta.url));

    expect(() => execFileSync(process.execPath, [TOOL, 'keygen', '--out', insideRepo], { encoding: 'utf8' })).toThrow();
  });
});

describe('parse/validate failures', () => {
  it.each([
    ['not json at all', /not valid JSON/],
    ['{"payload":{"customer":"a","issuedAt":"2026-01-01","expiresAt":"2027-01-01"}}', /missing or empty "signature"/],
    ['{"payload":{"issuedAt":"2026-01-01","expiresAt":"2027-01-01"},"signature":"x"}', /payload.customer/],
    ['{"payload":{"customer":"a","issuedAt":"2026-01-01","expiresAt":"nope"},"signature":"x"}', /payload.expiresAt/],
    [
      '{"payload":{"customer":"a","issuedAt":"2026-01-01","expiresAt":"2027-01-01","graceDays":-1},"signature":"x"}',
      /payload.graceDays/,
    ],
  ])('names the reason for %s', (contents, expected) => {
    expect(() => parseLicenseDocument(contents)).toThrow(expected);
  });

  it('refuses to verify anything while the baked-in public key is still the placeholder', () => {
    // Guards the release-ops failure mode: an image built before the real key
    // was pasted into LICENSE_PUBLIC_KEY_PEM must reject every license loudly
    // rather than accept an unverifiable one.
    const placeholder =
      '-----BEGIN PUBLIC KEY-----\nREPLACE_WITH_RELEASE_ED25519_PUBLIC_KEY\n-----END PUBLIC KEY-----\n';
    const file = issue(['--customer', 'acme-corp', '--expires', '2099-01-01'], 'placeholder.json');

    expect(isPlaceholderPublicKey(placeholder)).toBe(true);
    expect(() => parseAndVerifyLicense(readFileSync(file, 'utf8'), placeholder)).toThrow(
      /no production license public key/,
    );
  });
});

/**
 * The release gate (.github/workflows/release.yml) and the runtime verifier ask
 * this ONE function whether the baked-in key is usable. A placeholder-only
 * check let "not a PEM", a truncated PEM, and an RSA key through the gate — the
 * release then ships and every licensed server crash-loops at boot.
 */
describe('assertValidLicensePublicKey', () => {
  const PLACEHOLDER = '-----BEGIN PUBLIC KEY-----\nREPLACE_WITH_RELEASE_ED25519_PUBLIC_KEY\n-----END PUBLIC KEY-----\n';
  const rsaPem = generateKeyPairSync('rsa', { modulusLength: 2048 })
    .publicKey.export({ type: 'spki', format: 'pem' })
    .toString();
  // node:crypto's createPublicKey() DERIVES a public key from a private PEM, so
  // a private key pasted into LICENSE_PUBLIC_KEY_PEM verifies licenses happily
  // while the signing key ships in the repo, the image and every release
  // artifact. The committed fixture private key is the reviewer's own proof.
  const fixturePrivatePem = readFileSync(FIXTURE_PRIVATE_KEY, 'utf8');
  const encryptedPrivatePem = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'unit-test' },
  }).privateKey.toString();

  it.each([
    ['the placeholder', PLACEHOLDER, /no production license public key/],
    ['an empty value', '   ', /license public key is empty/],
    ['a value that is not a PEM at all', 'definitely-not-a-pem', /not a usable PEM/],
    ['a truncated PEM', FIXTURE_PUBLIC_KEY.slice(0, FIXTURE_PUBLIC_KEY.length - 40), /not a usable PEM/],
    ['an RSA public key', rsaPem, /must be ed25519, got rsa/],
    ['a PRIVATE key pasted in place of the public one', fixturePrivatePem, /this is a PRIVATE key.*never publish it/],
    ['an encrypted PRIVATE key', encryptedPrivatePem, /ENCRYPTED PRIVATE key.*never publish it/],
    [
      'a bundle that appends the private key after the public one',
      `${FIXTURE_PUBLIC_KEY}\n${fixturePrivatePem}`,
      /this is a PRIVATE key.*never publish it/,
    ],
    [
      'a non-SPKI public envelope',
      '-----BEGIN RSA PUBLIC KEY-----\nMIIBCgKCAQEA\n-----END RSA PUBLIC KEY-----\n',
      /must be an SPKI .*got "-----BEGIN RSA PUBLIC KEY-----"/,
    ],
    ['trailing junk after the public block', `${FIXTURE_PUBLIC_KEY}\nnot-whitespace`, /not a usable PEM/],
  ])('rejects %s with a distinct reason', (_label, pem, expected) => {
    expect(() => assertValidLicensePublicKey(pem)).toThrow(expected);
  });

  it('accepts a real Ed25519 public key', () => {
    expect(assertValidLicensePublicKey(FIXTURE_PUBLIC_KEY).asymmetricKeyType).toBe('ed25519');
    const generated = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(assertValidLicensePublicKey(generated).asymmetricKeyType).toBe('ed25519');
  });
});
