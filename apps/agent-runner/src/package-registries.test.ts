import { describe, expect, it } from 'vitest';
import { packageRegistries } from './package-registries.js';

const BOT = 'ghp_bot-token-0123456789';

describe('package registry setting', () => {
  it('maps scopes to registries with the bot token, a Secret variable or no credential', () => {
    const env = {
      COREDOC_PACKAGE_REGISTRIES: JSON.stringify({
        '@acme': { url: 'https://npm.pkg.github.com', credential: 'github' },
        '@vendor': { url: 'https://npm.vendor.example/repo', credential: 'env:VENDOR_NPM_TOKEN' },
        default: { url: 'https://npm-mirror.internal.example/' },
      }),
      VENDOR_NPM_TOKEN: 'vendor-token-abcdef',
    };

    expect(packageRegistries(env, BOT)).toEqual([
      { scope: '@acme', url: 'https://npm.pkg.github.com/', token: BOT },
      { scope: '@vendor', url: 'https://npm.vendor.example/repo/', token: 'vendor-token-abcdef' },
      { scope: null, url: 'https://npm-mirror.internal.example/', token: null },
    ]);
  });

  it('is empty when unset', () => {
    expect(packageRegistries({}, BOT)).toEqual([]);
  });

  it.each([
    ['not JSON', 'nope', /not valid JSON/],
    ['a key that is neither a scope nor default', JSON.stringify({ acme: { url: 'https://r.example' } }), /acme/],
    ['a URL that is not http(s)', JSON.stringify({ '@a': { url: 'file:///etc' } }), /@a/],
    [
      'a credential sent over plain http',
      JSON.stringify({ '@a': { url: 'http://r.example', credential: 'github' } }),
      /https/,
    ],
    [
      'an unknown credential kind',
      JSON.stringify({ '@a': { url: 'https://r.example', credential: 'vault:x' } }),
      /credential/,
    ],
    [
      'a Secret variable that is not set',
      JSON.stringify({ '@a': { url: 'https://r.example', credential: 'env:MISSING_TOKEN' } }),
      /MISSING_TOKEN/,
    ],
  ])('refuses %s', (_name, raw, message) => {
    expect(() => packageRegistries({ COREDOC_PACKAGE_REGISTRIES: raw }, BOT)).toThrow(message);
  });

  it('never repeats a credential value in its errors', () => {
    const raw = JSON.stringify({ '@a': { url: 'http://r.example', credential: 'env:A_TOKEN' } });
    expect(() => packageRegistries({ COREDOC_PACKAGE_REGISTRIES: raw, A_TOKEN: 'secret-value-123' }, BOT)).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('secret-value-123') }),
    );
  });
});
