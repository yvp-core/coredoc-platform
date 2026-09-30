/**
 * Offline license file format — the ONE implementation of canonicalization,
 * signing input, and signature verification.
 *
 * Written as `.mjs` (not `.ts`) on purpose: the maintainer-facing issuing tool
 * `apps/server/scripts/license-tool.mjs` runs under plain `node` with no build
 * step, while the server imports the same module after `tsc` copies it to
 * `dist/` (`allowJs` in apps/server/tsconfig.json). A signer and a verifier that
 * disagree by one byte of canonical JSON produce licenses that silently fail in
 * the field, so they share this file rather than mirroring each other.
 *
 * File shape (JSON, one object):
 *   {
 *     "payload": { "customer": "...", "issuedAt": "...", "expiresAt": "...", "graceDays": 30 },
 *     "signature": "<base64 Ed25519 detached signature over canonicalizeLicensePayload(payload)>"
 *   }
 *
 * Ed25519 comes from `node:crypto` — no JWT library, no new runtime dependency.
 */

import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

/**
 * Ed25519 public key licenses are verified against in a released image.
 *
 * PLACEHOLDER — release ops MUST replace this constant with the real public key
 * (`node scripts/license-tool.mjs keygen --out <dir outside the repo>` prints
 * it) before publishing an on-prem image. The matching private key never enters
 * this repository. While the placeholder is in place, any deployment that
 * actually mounts a license file fails fast at boot with an explicit message
 * instead of accepting an unverifiable file.
 */
export const LICENSE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAWtSGU7P1+RJSi/z4ZGes0EtO2l4BPEZitoyPQobID30=
-----END PUBLIC KEY-----
`;

/**
 * @typedef {object} LicensePayload
 * @property {string} customer     Customer identifier the license was issued to.
 * @property {string} issuedAt     ISO date (YYYY-MM-DD) the license was issued.
 * @property {string} expiresAt    ISO date (YYYY-MM-DD) the license expires on.
 *                                 Interpreted as UTC midnight at the START of
 *                                 that day.
 * @property {number} [graceDays]  Full-function days granted after `expiresAt`.
 *                                 Absent means no grace window.
 */

/**
 * @typedef {object} LicenseDocument
 * @property {LicensePayload} payload
 * @property {string} signature Base64 Ed25519 detached signature.
 */

export class LicenseFormatError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'LicenseFormatError';
  }
}

/** @param {string} pem */
export function isPlaceholderPublicKey(pem) {
  return pem.includes('REPLACE_WITH_RELEASE_ED25519_PUBLIC_KEY');
}

/**
 * Every `-----BEGIN X-----` label in a PEM blob, in order.
 *
 * @param {string} pem
 * @returns {string[]}
 */
function pemBlockLabels(pem) {
  return [...pem.matchAll(/-----BEGIN ([A-Z0-9 ]+)-----/g)].map((match) => match[1]);
}

/**
 * The ONE definition of "usable license public key", shared by the runtime
 * verifier and the release gate in .github/workflows/release.yml.
 *
 * A sentinel-string check alone is not that definition: a key that is not the
 * placeholder can still be un-parseable, truncated, or an RSA key pasted by
 * mistake. Any of those passes a placeholder-only gate, ships, and then makes
 * every licensed server reject every license — so the gate asks this function,
 * which asks node:crypto, exactly like the verifier does at runtime.
 *
 * Asking node:crypto is not enough either, and this is the dangerous direction:
 * `createPublicKey()` accepts a PRIVATE key PEM and silently derives the public
 * key from it. An operator who pastes coredoc-license-private.pem instead of
 * coredoc-license-public.pem would therefore pass the release gate AND verify
 * licenses correctly — while the signing key sits in the repository, the image
 * and every release artifact. So the envelope is checked first: exactly one
 * SPKI `-----BEGIN PUBLIC KEY-----` block, nothing but whitespace around it.
 *
 * @param {string} pem
 * @returns {import('node:crypto').KeyObject} the parsed key (throws LicenseFormatError otherwise)
 */
export function assertValidLicensePublicKey(pem) {
  if (typeof pem !== 'string' || pem.trim() === '') {
    throw new LicenseFormatError('license public key is empty');
  }
  if (isPlaceholderPublicKey(pem)) {
    throw new LicenseFormatError(
      'this build has no production license public key baked in (LICENSE_PUBLIC_KEY_PEM is still the placeholder)',
    );
  }
  const trimmed = pem.trim();
  const labels = pemBlockLabels(trimmed);
  if (labels.length === 0) {
    throw new LicenseFormatError('license public key is not a usable PEM (no "-----BEGIN PUBLIC KEY-----" line found)');
  }
  if (labels.includes('ENCRYPTED PRIVATE KEY')) {
    throw new LicenseFormatError(
      'this is an ENCRYPTED PRIVATE key, not a public key — never publish it, not even encrypted; ' +
        'use the public key file (coredoc-license-public.pem)',
    );
  }
  const privateLabel = labels.find((label) => label.endsWith('PRIVATE KEY'));
  if (privateLabel) {
    throw new LicenseFormatError(
      `this is a PRIVATE key ("-----BEGIN ${privateLabel}-----") — never publish it; ` +
        'use the public key file (coredoc-license-public.pem)',
    );
  }
  if (labels.length > 1) {
    throw new LicenseFormatError(
      `license public key must be exactly one "-----BEGIN PUBLIC KEY-----" block, found ${labels.length} PEM blocks`,
    );
  }
  if (labels[0] !== 'PUBLIC KEY') {
    throw new LicenseFormatError(
      `license public key must be an SPKI "-----BEGIN PUBLIC KEY-----" block, got "-----BEGIN ${labels[0]}-----"`,
    );
  }
  if (!trimmed.startsWith('-----BEGIN PUBLIC KEY-----') || !trimmed.endsWith('-----END PUBLIC KEY-----')) {
    throw new LicenseFormatError(
      'license public key is not a usable PEM (the "-----BEGIN PUBLIC KEY-----" block is truncated, ' +
        'or something other than whitespace surrounds it)',
    );
  }
  let key;
  try {
    key = createPublicKey(trimmed);
  } catch (error) {
    throw new LicenseFormatError(
      `license public key is not a usable PEM (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new LicenseFormatError(`license public key must be ed25519, got ${key.asymmetricKeyType ?? 'unknown'}`);
  }
  return key;
}

/**
 * Canonical JSON of a license payload: object keys sorted, values serialized by
 * `JSON.stringify`. These exact bytes are what gets signed and verified.
 *
 * Payloads are deliberately restricted to flat scalar fields — nested objects
 * and arrays would need their own ordering rules and no claim requires them, so
 * they are rejected rather than silently serialized in insertion order.
 *
 * @param {unknown} payload
 * @returns {string}
 */
export function canonicalizeLicensePayload(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new LicenseFormatError('license payload must be a JSON object');
  }
  const parts = [];
  for (const key of Object.keys(payload).sort()) {
    const value = /** @type {Record<string, unknown>} */ (payload)[key];
    if (value === undefined) continue;
    const type = typeof value;
    if (value !== null && type !== 'string' && type !== 'number' && type !== 'boolean') {
      throw new LicenseFormatError(`license payload field "${key}" must be a string, number, boolean, or null`);
    }
    if (type === 'number' && !Number.isFinite(value)) {
      throw new LicenseFormatError(`license payload field "${key}" must be a finite number`);
    }
    parts.push(`${JSON.stringify(key)}:${JSON.stringify(value)}`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * Parse + validate the JSON document without checking the signature.
 *
 * @param {string} contents
 * @returns {LicenseDocument}
 */
export function parseLicenseDocument(contents) {
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new LicenseFormatError(`not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LicenseFormatError('expected a JSON object with "payload" and "signature"');
  }
  const { payload, signature } = /** @type {Record<string, unknown>} */ (parsed);
  if (typeof signature !== 'string' || signature.length === 0) {
    throw new LicenseFormatError('missing or empty "signature"');
  }
  return { payload: validateLicensePayload(payload), signature };
}

/**
 * @param {unknown} payload
 * @returns {LicensePayload}
 */
export function validateLicensePayload(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new LicenseFormatError('"payload" must be a JSON object');
  }
  const record = /** @type {Record<string, unknown>} */ (payload);
  if (typeof record.customer !== 'string' || record.customer.trim().length === 0) {
    throw new LicenseFormatError('"payload.customer" must be a non-empty string');
  }
  requireDate(record.issuedAt, 'payload.issuedAt');
  requireDate(record.expiresAt, 'payload.expiresAt');
  const graceDays = record.graceDays;
  // graceDays is optional in the file: absent means no grace window. Validation
  // never rewrites the payload (no defaults are injected) — the signature is
  // checked against the payload bytes exactly as written, so any normalization
  // here would break verification of a perfectly good license.
  if (graceDays !== undefined && (typeof graceDays !== 'number' || !Number.isInteger(graceDays) || graceDays < 0)) {
    throw new LicenseFormatError('"payload.graceDays" must be a non-negative integer');
  }
  return /** @type {LicensePayload} */ (record);
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {void}
 */
function requireDate(value, field) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new LicenseFormatError(`"${field}" must be an ISO date string (e.g. 2027-08-27)`);
  }
}

/**
 * Verify a license document's detached signature against a public key.
 *
 * @param {LicenseDocument} document
 * @param {string} publicKeyPem
 * @returns {void} throws LicenseFormatError when the signature does not match.
 */
export function verifyLicenseSignature(document, publicKeyPem) {
  const key = assertValidLicensePublicKey(publicKeyPem);
  const message = Buffer.from(canonicalizeLicensePayload(document.payload), 'utf8');
  let signatureBytes;
  try {
    signatureBytes = Buffer.from(document.signature, 'base64');
  } catch {
    throw new LicenseFormatError('"signature" is not valid base64');
  }
  // Ed25519 takes `null` as the digest algorithm: it hashes internally.
  if (!cryptoVerify(null, message, key, signatureBytes)) {
    throw new LicenseFormatError('signature does not match the payload (wrong key, or the payload was modified)');
  }
}

/**
 * Parse + verify in one step.
 *
 * @param {string} contents
 * @param {string} publicKeyPem
 * @returns {LicensePayload}
 */
export function parseAndVerifyLicense(contents, publicKeyPem) {
  const document = parseLicenseDocument(contents);
  verifyLicenseSignature(document, publicKeyPem);
  return document.payload;
}
