/**
 * Encryption utilities for sensitive data at rest.
 * Uses AES-256-GCM for authenticated encryption.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { configFromEnv } from '../config/app-config.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const HEX_KEY = /^[0-9a-fA-F]{64}$/;

const KEY_FORMAT_HINT =
  'SERVER_ENCRYPTION_KEY must be 32 bytes: 64 hex chars (openssl rand -hex 32) or base64 (openssl rand -base64 32)';

/**
 * Parse SERVER_ENCRYPTION_KEY into a 32-byte key, or null when unset/malformed.
 * Both encodings are accepted because the shipped docs have told operators to
 * generate it both ways (`-hex 32` in .env.example, `-base64 32` in the on-prem
 * install guides and Helm chart).
 */
function parseEncryptionKey(raw: string | undefined): Buffer | null {
  const key = raw?.trim();
  if (!key) return null;
  if (HEX_KEY.test(key)) return Buffer.from(key, 'hex');
  const decoded = Buffer.from(key, 'base64');
  // Node's base64 decoder silently drops invalid characters, so round-trip the
  // bytes to reject junk that merely happens to decode to 32 bytes.
  if (decoded.length !== 32 || decoded.toString('base64') !== key) return null;
  return decoded;
}

function getEncryptionKey(): Buffer {
  const raw = configFromEnv().auth.serverEncryptionKey;
  if (!raw?.trim()) {
    throw new Error('SERVER_ENCRYPTION_KEY environment variable is required for token encryption');
  }
  const key = parseEncryptionKey(raw);
  if (!key) throw new Error(KEY_FORMAT_HINT);
  return key;
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns a base64-encoded string: iv + ciphertext + authTag.
 */
export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Format: iv (12) + ciphertext (variable) + tag (16)
  const combined = Buffer.concat([iv, encrypted, tag]);
  return combined.toString('base64');
}

/**
 * Decrypt a base64-encoded AES-256-GCM ciphertext.
 * Expects format: iv (12) + ciphertext (variable) + tag (16).
 */
export function decrypt(ciphertext: string): string {
  const key = getEncryptionKey();
  const combined = Buffer.from(ciphertext, 'base64');

  const iv = combined.subarray(0, IV_LENGTH);
  const tag = combined.subarray(combined.length - TAG_LENGTH);
  const encrypted = combined.subarray(IV_LENGTH, combined.length - TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

/**
 * Check if encryption is available (key is configured and valid).
 */
export function isEncryptionAvailable(): boolean {
  return parseEncryptionKey(configFromEnv().auth.serverEncryptionKey) !== null;
}

/**
 * Fail bootstrap when a key is set but unusable. Without this a malformed key
 * degrades silently: isEncryptionAvailable() returns false, tokens are stored
 * with no encrypted copy, and the reveal path is dead for the life of the token.
 */
export function assertEncryptionKeyValid(): void {
  const raw = configFromEnv().auth.serverEncryptionKey;
  if (raw?.trim() && parseEncryptionKey(raw) === null) throw new Error(KEY_FORMAT_HINT);
}
