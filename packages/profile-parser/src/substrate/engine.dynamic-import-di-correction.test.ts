/**
 * Acceptance for the interaction of the two call-resolution corrections that share a
 * call SITE key (`callerId|file|line`):
 *
 *   const { doWork: work } = await import('./lib.js');
 *   return work(n) + this.calc.compute(n);        // ← same line, two calls
 *
 * The dynamic-import upgrade exempts its edge from the callee-name precision gate (an
 * aliased binding legitimately calls `work` while the node is named `doWork`). The DI
 * correction is keyed by line only, so it can REPLACE the callee of that same edge — the
 * exemption must not travel with the replacement, or a `work(...)` expression ends up
 * pointing at `compute`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExtractionProfile } from '../types.js';
import { runProfile } from './run.js';

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const LIB = `export function doWork(n: number): number {
  return n + 1;
}
`;

const SVC = `export class Calculator {
  compute(n: number): number {
    return n * 2;
  }
}
`;

const CONSUMER = `import type { Calculator } from './svc.js';

export class Runner {
  constructor(private readonly calc: Calculator) {}

  async run(n: number): Promise<number> {
    const { doWork: work } = await import('./lib.js');
    return work(n) + this.calc.compute(n);
  }
}
`;

function writeFixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'pp-dyn-import-di-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  // scip-typescript's prerequisite check is the presence of node_modules.
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'dyn-import-di-fixture', version: '1.0.0', type: 'module' }),
  );
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' },
      include: ['src'],
    }),
  );
  for (const [name, source] of Object.entries(files)) writeFileSync(join(root, 'src', name), source);
  return root;
}

const PROFILE: ExtractionProfile = {
  parserId: 'test-dynamic-import-di-correction',
  substrate: { language: 'ts', include: ['src/**/*.ts'], exclude: ['**/node_modules/**'] },
  // The DI correction only runs for a constructor-type profile — without it the call
  // site at issue never gets a second, competing resolution.
  di: { style: 'constructor-type' },
};

describe('call graph — DI correction on a dynamic-import call site', () => {
  it('never keeps the dynamic-import name exemption for a DI-corrected callee', async () => {
    dir = writeFixture({ 'lib.ts': LIB, 'svc.ts': SVC, 'consumer.ts': CONSUMER });
    const { repo } = await runProfile(PROFILE, dir, 'dyn-import-di');
    const nameById = new Map(repo.functions.map((f) => [f.id, f.name]));

    const fabricated = repo.calls.filter(
      (c) => c.calleeId && c.calleeExpression === 'work' && nameById.get(c.calleeId) !== 'doWork',
    );
    expect(fabricated.map((c) => `work->${nameById.get(c.calleeId as string)}`)).toEqual([]);
  });
});

// The `@app/*` specifiers resolve nowhere (no path mapping), so SCIP cannot type the chain —
// the shape a path-aliased Nest repo presents. Only the DI member-chain walk can bind it.
const REPO = `export class UserRepo {
  findOne(id: string): string {
    return id;
  }
}
`;

const FACADE = `import type { UserRepo } from '@app/repo';

export class Facade {
  readonly cache: UserRepo;
  constructor(readonly repo: UserRepo) {}
}
`;

const HANDLER = `import type { Facade } from '@app/facade';

export class Handler {
  constructor(private readonly facade: Facade) {}

  viaCtorProp(id: string): string {
    return this.facade.repo.findOne(id);
  }

  viaField(id: string): string {
    return this.facade.cache.findOne(id);
  }

  missingHop(id: string): string {
    return this.facade.ghost.findOne(id);
  }
}
`;

describe('call graph — DI member chains', () => {
  it('binds this.a.b.m() through ctor param → property type → method; a missing hop stays unbound', async () => {
    dir = writeFixture({ 'repo.ts': REPO, 'facade.ts': FACADE, 'handler.ts': HANDLER });
    const { repo } = await runProfile(PROFILE, dir, 'di-member-chain');
    const nameById = new Map(repo.functions.map((f) => [f.id, f.name]));
    const calleeOf = (caller: string): string | undefined =>
      repo.calls.find((c) => nameById.get(c.callerId) === caller && c.calleeExpression.endsWith('findOne'))?.calleeId;
    const findOne = repo.functions.find((f) => f.name === 'findOne')?.id;

    expect(findOne).toBeDefined();
    expect(calleeOf('viaCtorProp')).toBe(findOne);
    expect(calleeOf('viaField')).toBe(findOne);
    expect(calleeOf('missingHop')).toBeUndefined();
  });

  it('leaves the other call on a member-chain line with its own callee', async () => {
    // Typed through relative imports, so SCIP binds both calls on the line itself.
    const response = `export class Response {
  getBody(): string {
    return '';
  }
}
`;
    const store = `import type { Response } from './response.js';

export class Store {
  load(id: string): Response {
    throw new Error(id);
  }
}
`;
    const holder = `import type { Store } from './store.js';

export class Holder {
  constructor(readonly store: Store) {}
}
`;
    const reader = `import type { Holder } from './holder.js';

export class Reader {
  constructor(private readonly holder: Holder) {}

  body(id: string): string {
    return this.holder.store.load(id).getBody();
  }
}
`;
    dir = writeFixture({ 'response.ts': response, 'store.ts': store, 'holder.ts': holder, 'reader.ts': reader });
    const { repo } = await runProfile(PROFILE, dir, 'di-shared-line');
    const nameById = new Map(repo.functions.map((f) => [f.id, f.name]));
    const callees = repo.calls
      .filter((c) => nameById.get(c.callerId) === 'body' && c.calleeId)
      .map((c) => nameById.get(c.calleeId as string))
      .sort();

    expect(callees).toEqual(['getBody', 'load']);
  });
});

// A typed API client whose sub-clients are untyped getters over backing fields, declared on a base
// class: `this.apiClient.users.findOne()` types `users` from the getter's `return this._users`.
const ORDERS = `export class OrderBook {
  list(): string[] {
    return [];
  }
}
`;

const CLIENT = `import type { UserRepo } from '@app/repo';
import type { OrderBook } from '@app/orders';

export class ApiClient {
  protected _users!: UserRepo;

  constructor(private readonly _orders: OrderBook) {}

  get users() {
    if (!this._users) {
      throw new Error('users not configured');
    }
    return this._users;
  }

  get orders() {
    return this._orders;
  }

  get either() {
    return this._users ?? this._orders;
  }
}
`;

const CLIENT_SERVICE = `import { ApiClient } from './client';

export class ApiClientService extends ApiClient {}
`;

const CLIENT_CONSUMER = `import type { ApiClientService } from '@app/client-service';

export class Consumer {
  constructor(private readonly apiClient: ApiClientService) {}

  oneUser(id: string): string {
    return this.apiClient.users.findOne(id);
  }

  allOrders(): string[] {
    return this.apiClient.orders.list();
  }

  mixed(id: string): string {
    return this.apiClient.either.findOne(id);
  }
}
`;

describe('call graph — DI member chains through a base-class getter', () => {
  it('types an unannotated `return this.<field>` getter on an in-repo base from the field or ctor param', async () => {
    dir = writeFixture({
      'repo.ts': REPO,
      'orders.ts': ORDERS,
      'client.ts': CLIENT,
      'client-service.ts': CLIENT_SERVICE,
      'api-consumer.ts': CLIENT_CONSUMER,
    });
    const { repo } = await runProfile(PROFILE, dir, 'di-getter-chain');
    const nameById = new Map(repo.functions.map((f) => [f.id, f.name]));
    const calleeOf = (caller: string): string | undefined => {
      const id = repo.calls.find(
        (c) => nameById.get(c.callerId) === caller && c.calleeExpression.startsWith('this.'),
      )?.calleeId;
      return id && nameById.get(id);
    };

    expect(calleeOf('oneUser')).toBe('findOne');
    expect(calleeOf('allOrders')).toBe('list');
    // Not a plain `return this.<field>`: no type, so no edge.
    expect(calleeOf('mixed')).toBeUndefined();
  });
});
