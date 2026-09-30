import { describe, it, expect, afterEach } from 'vitest';
import { encrypt, decrypt, isEncryptionAvailable, assertEncryptionKeyValid } from './encryption.js';

const HEX_KEY = 'a'.repeat(64);
const BASE64_KEY = Buffer.alloc(32, 7).toString('base64'); // 44 chars, as `openssl rand -base64 32`

afterEach(() => {
  delete process.env.SERVER_ENCRYPTION_KEY;
});

describe('encryption key formats', () => {
  it.each([HEX_KEY, BASE64_KEY])('accepts %s-style keys and round-trips', (key) => {
    process.env.SERVER_ENCRYPTION_KEY = key;
    expect(isEncryptionAvailable()).toBe(true);
    expect(decrypt(encrypt('cdt_secret'))).toBe('cdt_secret');
    expect(() => assertEncryptionKeyValid()).not.toThrow();
  });

  it.each([
    '',
    '   ',
    'short',
    'z'.repeat(64),
    'not base64 but long enough to decode!!!!!!!!',
  ])('rejects malformed key %j', (key) => {
    process.env.SERVER_ENCRYPTION_KEY = key;
    expect(isEncryptionAvailable()).toBe(false);
  });

  it('fails bootstrap when a key is set but unusable', () => {
    process.env.SERVER_ENCRYPTION_KEY = 'z'.repeat(64);
    expect(() => assertEncryptionKeyValid()).toThrow(/32 bytes/);
  });

  it('allows bootstrap with no key configured', () => {
    expect(isEncryptionAvailable()).toBe(false);
    expect(() => assertEncryptionKeyValid()).not.toThrow();
  });
});
