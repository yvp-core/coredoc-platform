/**
 * A member-chain handler-table reference that a formatter wrapped across lines
 * (`handlers.api.periods\n  .listRegular`) resolves exactly like the one-line form.
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
  'app/handlers/periods.js': `module.exports = {
  list: async (ctx) => { ctx.body = [] },
  listRegular: async (ctx) => { ctx.body = [] },
}
`,
  'app/initializers/router.js': `const handlers = {
  api: {
    periods: require("app/handlers/periods"),
  },
}

module.exports = async (application) => {
  const router = application.koaRouter
  router.extend("/v2/management/payroll_lock", (router) => {
    router.get("/companies/:companyUuid/periods", handlers.api.periods.list)
    router.get(
      "/companies/:companyUuid/periods_regular",
      handlers.api.periods
        .listRegular
    )
  })
}
`,
};

describe('handler-table member-chain reference', () => {
  it('resolves a handler reference wrapped across lines', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pp-handler-multiline-'));
    for (const [rel, body] of Object.entries(FILES)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), body);
    }
    const profile: ExtractionProfile = {
      parserId: 'test-handler-multiline',
      substrate: { language: 'js', untypedJsMode: true, include: ['app/**/*.js'], exclude: [] },
      entrypoints: [
        {
          kind: 'http',
          detect: { via: 'call-shape', callee: 'router.*', scopedBy: { callee: 'router.extend', basePathArg: 0 } },
          method: 'from-callee',
          methodPath: { arg: 0, as: 'string-literal' },
          paramSyntax: 'colon',
          handler: { via: 'handler-table', table: 'koa-handlers', arg: -1 },
        },
      ],
      handlerTables: [
        {
          name: 'koa-handlers',
          registryVar: 'handlers',
          inFile: 'app/initializers/router.js',
          leaf: 'require',
          reference: 'member-chain',
          nested: true,
        },
      ],
    } as ExtractionProfile;
    const { repo } = await runProfile(profile, dir, 'handler-multiline-test');
    const routes = repo.entrypoints
      .filter((e) => e.type === 'http')
      .map((e) => `${e.details.method} ${e.details.path}`)
      .sort();
    expect(routes).toEqual(['GET /companies/{companyUuid}/periods', 'GET /companies/{companyUuid}/periods_regular']);
  });
});
