import { describe, it, expect } from 'vitest';
import { buildGoogleProvider } from './google.provider.js';
import { loadAppConfig } from '../../config/app-config.js';

const auth = (env: Record<string, string> = {}) =>
  loadAppConfig({ ALLOWED_EMAIL_DOMAINS: 'example.com', ...env }, 'worker').auth;

const profile = (email: string, verified: unknown, hd: string | null = email.split('@')[1] ?? null) => ({
  id: 'g-123',
  _json: { hd: hd ?? undefined },
  displayName: 'Alice Doe',
  emails: [{ value: email, verified }],
  photos: [{ value: 'https://img.example.com/alice.png' }],
});

describe('buildGoogleProvider', () => {
  it('refuses to boot with an empty login gate', () => {
    expect(() => buildGoogleProvider(auth({ ALLOWED_EMAIL_DOMAINS: '' }))).toThrow(/Login gate is empty/);
  });

  it('maps a verified in-domain user, keyed on the Google id with the full email as username', () => {
    const mapped = buildGoogleProvider(auth()).profileMapper(profile('Alice@Example.com', true));
    expect(mapped).toMatchObject({ id: 'g-123', username: 'Alice@Example.com', email: 'Alice@Example.com' });
  });

  it('rejects an unverified email even in an allowed domain', () => {
    const mapper = buildGoogleProvider(auth()).profileMapper;
    expect(() => mapper(profile('alice@example.com', false))).toThrow(/no verified email/);
    expect(() => mapper(profile('alice@example.com', 'true'))).toThrow(/no verified email/);
  });

  it('rejects a personal Google account on an allowed address (no or foreign hd)', () => {
    const mapper = buildGoogleProvider(auth()).profileMapper;
    expect(() => mapper(profile('alice@example.com', true, null))).toThrow(/not managed/);
    expect(() => mapper(profile('alice@example.com', true, 'other.com'))).toThrow(/not managed/);
  });

  it('accepts an allowed Gmail address, which never carries hd', () => {
    const mapper = buildGoogleProvider(auth({ ALLOWED_EMAIL_DOMAINS: 'gmail.com' })).profileMapper;
    expect(mapper(profile('alice@gmail.com', true, null))).toMatchObject({ email: 'alice@gmail.com' });
  });

  it('rejects a verified email outside the allowed domains', () => {
    expect(() => buildGoogleProvider(auth()).profileMapper(profile('alice@gmail.com', true))).toThrow(
      /not in an allowed email domain/,
    );
  });
});
