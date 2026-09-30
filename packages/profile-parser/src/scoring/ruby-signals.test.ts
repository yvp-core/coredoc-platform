import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RubyProfile } from '../types/ruby-profile.js';
import { rubySourceSignals } from './ruby-signals.js';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** Write a repo. `checkoutDir` nests it, to model where the repo actually lives on disk. */
function repo(files: Record<string, string>, checkoutDir = ''): string {
  const base = mkdtempSync(join(tmpdir(), 'rb-signals-'));
  roots.push(base);
  const root = checkoutDir ? join(base, checkoutDir) : base;
  mkdirSync(root, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

const profile: RubyProfile = {
  parserId: 'rb-v1',
  substrate: { language: 'ruby', include: ['**/*.rb'] },
};

const FILES = {
  'config/routes.rb': "resources :users\n  get 'health'\n",
  'app/api/v1/orders.rb': "  get '/orders' do\n  end\n",
  'app/api/v1/orders_spec.rb': "  get '/nope' do\n  end\n",
  'db/schema.rb': 'create_table "users" do |t|\nend\n',
};

describe('rubySourceSignals', () => {
  it('counts route-DSL lines from the exact Ruby files the parser includes', () => {
    expect(rubySourceSignals(repo(FILES), profile)).toEqual({ http: 4, entities: 1 });
  });

  it('does not let the CHECKOUT path zero the http denominator', () => {
    // `vendor` and `_test` are unanchored in the Ruby noise pattern, so a repo under
    // `/srv/vendor/app` matched on its own checkout path and dropped every route line —
    // a zero denominator scores `not_applicable`, which reads as PASS.
    for (const dir of ['vendor/app', 'test/app', 'my_test_checkout/app']) {
      expect(rubySourceSignals(repo(FILES, dir), profile).http, dir).toBe(4);
    }
  });

  it('does not count routes from profile-excluded Ruby sources', () => {
    const root = repo({
      'config/routes.rb': 'resources :users\n',
      'app/api/live.rb': "get '/live' do\nend\n",
      'app/api/generated/routes.rb': "get '/generated' do\nend\n",
    });
    const scoped: RubyProfile = {
      ...profile,
      substrate: { language: 'ruby', include: ['app/**/*.rb'], exclude: ['app/api/generated/**'] },
    };

    expect(rubySourceSignals(root, scoped).http).toBe(2);
  });
});
