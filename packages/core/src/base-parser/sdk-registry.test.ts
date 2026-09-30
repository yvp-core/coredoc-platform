import { describe, expect, it } from 'vitest';
import { SDK_PACKAGES, lookupSdkByPackage } from './sdk-registry.js';

/**
 * A key written as a MODULE PATH rather than an npm package name — i.e. its first segment is a
 * DNS-ish host (`github.com`, `cloud.google.com`, `google.golang.org`, `gopkg.in`). npm names in
 * this registry are bare or `@scope/`-prefixed and never carry a dot before the first slash.
 *
 * Deliberately a shape test rather than a hand-maintained list: a new module-path key is picked up
 * by the identity invariant below automatically, which is the point of pinning it.
 */
function isModulePathKey(key: string): boolean {
  return key.split('/')[0].includes('.');
}

describe('cross-ecosystem service identity', () => {
  it('gives every module-path key the same service + protocol as its npm sibling', () => {
    // The whole reason a Go module path lives in this registry: a TypeScript repo importing
    // `@slack/web-api` and a Go repo importing `github.com/slack-go/slack` must resolve to ONE
    // "Slack" node, or the cross-repo dependency graph shows two unrelated services. Drift in
    // either field breaks that join silently, so it is pinned rather than reviewed by eye.
    const npmByService = new Map<string, string[]>();
    for (const [key, sdk] of Object.entries(SDK_PACKAGES)) {
      if (isModulePathKey(key)) continue;
      npmByService.set(sdk.service, [...(npmByService.get(sdk.service) ?? []), key]);
    }

    const orphans: string[] = [];
    const mismatches: string[] = [];
    for (const [key, sdk] of Object.entries(SDK_PACKAGES)) {
      if (!isModulePathKey(key)) continue;
      const siblings = npmByService.get(sdk.service);
      if (!siblings) {
        orphans.push(key);
        continue;
      }
      for (const sibling of siblings) {
        if (SDK_PACKAGES[sibling].protocol !== sdk.protocol) mismatches.push(`${key} vs ${sibling}`);
      }
    }
    expect(orphans).toEqual([]);
    expect(mismatches).toEqual([]);
  });

  it('agrees on the service across every ecosystem that names it', () => {
    expect(lookupSdkByPackage('@slack/web-api')).toEqual(lookupSdkByPackage('github.com/slack-go/slack'));
    expect(lookupSdkByPackage('@sentry/node')).toEqual(lookupSdkByPackage('github.com/getsentry/sentry-go'));
    expect(lookupSdkByPackage('@aws-sdk/client-secrets-manager')).toEqual(
      lookupSdkByPackage('github.com/aws/aws-sdk-go-v2/service/secretsmanager'),
    );
  });
});

describe('module-path lookup', () => {
  it('resolves a Go major-version suffix through the prefix walk', () => {
    // Go writes `/v2`+ into the import path itself, so keys are stored versionless and the
    // existing longest-prefix walk absorbs the suffix — one key covers every major version.
    expect(lookupSdkByPackage('github.com/getsentry/sentry-go/v2')?.service).toBe('Sentry');
    expect(lookupSdkByPackage('github.com/google/go-github/v57')?.service).toBe('GitHub');
  });

  it('resolves a Go subpackage import to its owning module', () => {
    // `slackevents` and `socketmode` are subpackages of one module, not separate services.
    expect(lookupSdkByPackage('github.com/slack-go/slack/slackevents')?.service).toBe('Slack');
    expect(lookupSdkByPackage('github.com/slack-go/slack/socketmode')?.service).toBe('Slack');
  });

  it('does not claim a module path that only shares a vendor prefix', () => {
    expect(lookupSdkByPackage('github.com/slack-go/slack-fake-double')).toBeUndefined();
    expect(lookupSdkByPackage('github.com/aws/aws-sdk-go-v2/config')).toBeUndefined();
  });

  it('leaves npm resolution untouched', () => {
    expect(lookupSdkByPackage('openai')?.service).toBe('OpenAI');
    expect(lookupSdkByPackage('@sentry/nextjs/server')?.service).toBe('Sentry');
    expect(lookupSdkByPackage('some-unknown-package')).toBeUndefined();
  });
});
