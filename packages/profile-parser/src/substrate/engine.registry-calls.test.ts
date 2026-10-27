/**
 * Registry call binding for untyped JS (`ExtractionProfile.registries`). A Koa-style application
 * framework stores each `app/services/*-service.js` instance on `services` under its class name with
 * the `Service` suffix stripped and the first letter lowered, so `this.services.notification.m()`
 * calls `NotificationService.m`. Nothing types that object, so only the profile rule can bind it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExtractionProfile } from '../types.js';
import { runProfile } from './run.js';

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const FILES: Record<string, string> = {
  'app/services/notification-service.js': `class NotificationService {
  async dispatchEvent(event) {
    return event;
  }
}

module.exports = NotificationService;
`,
  'app/services/requests-service.js': `class RequestsService {
  async approve(request) {
    await this.services.notification.dispatchEvent(request);
    await this.services.notification.missingMethod(request);
    return this.repositories.core.getUser(request.userUuid);
  }
}

module.exports = RequestsService;
`,
  'app/repositories/api-repository-base.js': `class BaseRepository {
  async getUser(uuid) {
    return uuid;
  }
}

module.exports = BaseRepository;
`,
  'app/repositories/core-repository.js': `const BaseRepository = require("app/repositories/api-repository-base");

class CoreRepository extends BaseRepository {}

module.exports = CoreRepository;
`,
  'app/handlers/events.js': `module.exports = {
  onEvent: async (ctx) => {
    await ctx.services.notification.dispatchEvent(ctx.request.body);
  },
};
`,
};

const BASE: ExtractionProfile = {
  parserId: 'test-registry-calls',
  substrate: { language: 'js', untypedJsMode: true, include: ['app/**/*.js'], exclude: [] },
  synthesize: { objectLiteralExportMethods: true, inPaths: ['app/handlers/'] },
  di: { style: 'none' },
  callGraph: { resolveAnonCallbacks: true },
};

const WITH_RULES: ExtractionProfile = {
  ...BASE,
  registries: [
    { receivers: ['this.services', 'ctx.services'], classSuffix: 'Service', inPaths: ['app/services/'] },
    { receivers: ['this.repositories'], classSuffix: 'Repository', inPaths: ['app/repositories/'] },
  ],
};

function writeFixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'pp-registry-calls-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

async function calleesByExpression(profile: ExtractionProfile, files: Record<string, string>) {
  dir = writeFixture(files);
  const { repo } = await runProfile(profile, dir, 'registry-calls');
  const fnById = new Map(repo.functions.map((f) => [f.id, f]));
  const callee = (expr: string): string | undefined => {
    const id = repo.calls.find((c) => c.calleeExpression.replace(/\s/g, '') === expr)?.calleeId;
    const fn = id ? fnById.get(id) : undefined;
    return fn ? `${fn.location.filePath}:${fn.name}` : undefined;
  };
  return Object.assign(callee, { stats: repo.stats.callResolution });
}

describe('call graph — registry rules', () => {
  it('binds <receiver>.<name>.<method>() to the method on upperFirst(name) + classSuffix', async () => {
    const callee = await calleesByExpression(WITH_RULES, FILES);

    expect(callee('this.services.notification.dispatchEvent')).toBe(
      'app/services/notification-service.js:dispatchEvent',
    );
    expect(callee('ctx.services.notification.dispatchEvent')).toBe(
      'app/services/notification-service.js:dispatchEvent',
    );
    // Inherited from the in-repo base class.
    expect(callee('this.repositories.core.getUser')).toBe('app/repositories/api-repository-base.js:getUser');
    expect(callee('this.services.notification.missingMethod')).toBeUndefined();
    expect(callee.stats?.registryAmbiguousCalls).toBe(0);
  });

  it('tries the next rule when an earlier rule on the same receiver finds no class', async () => {
    const callee = await calleesByExpression(
      {
        ...BASE,
        registries: [
          { receivers: ['this.services'], classSuffix: 'Service', inPaths: ['app/services/'] },
          { receivers: ['this.services'], classSuffix: 'Client', inPaths: ['app/clients/'] },
        ],
      },
      {
        ...FILES,
        'app/clients/billing-client.js': `class BillingClient {
  async charge(amount) {
    return amount;
  }
}

module.exports = BillingClient;
`,
        'app/services/checkout-service.js': `class CheckoutService {
  async pay(amount) {
    return this.services.billing.charge(amount);
  }
}

module.exports = CheckoutService;
`,
      },
    );

    expect(callee('this.services.billing.charge')).toBe('app/clients/billing-client.js:charge');
    expect(callee('this.services.notification.dispatchEvent')).toBe(
      'app/services/notification-service.js:dispatchEvent',
    );
  });

  it('leaves the site unbound without the rule', async () => {
    const callee = await calleesByExpression(BASE, FILES);

    expect(callee('this.services.notification.dispatchEvent')).toBeUndefined();
  });

  it('leaves the site unbound when two classes under inPaths produce the name', async () => {
    const callee = await calleesByExpression(WITH_RULES, {
      ...FILES,
      'app/services/legacy/notification-service.js': `class NotificationService {
  async dispatchEvent(event) {
    return null;
  }
}

module.exports = NotificationService;
`,
    });

    expect(callee('this.services.notification.dispatchEvent')).toBeUndefined();
    // The two `this.services.notification.*` sites and the `ctx.services` one.
    expect(callee.stats?.registryAmbiguousCalls).toBe(3);
  });
});
