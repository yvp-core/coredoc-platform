/**
 * Acceptance for `stateStores[].builders` — the builder-ARRAY store shape, where the
 * factory's argument is an array of builder calls (`factory([actions({…}), …])`)
 * instead of a state object literal. Without the knob the array argument yields no
 * object at all, so such stores land with empty actions/selectors (noise, not signal).
 * The knob is data-shape-driven: which builder callees carry action keys and which
 * carry value keys is declared per profile, never inferred from a library identity.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExtractionProfile } from '../types.js';
import { runProfile } from './run.js';

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** The kea 3.x shape: `kea<T>([builder(…), …])`, incl. a `(deps) => ({…})` builder. */
const BUILDER_ARRAY = `import { kea, actions, reducers, selectors, loaders, listeners, path } from 'kea';
import type { fooLogicType } from './fooLogicType';

export const fooLogic = kea<fooLogicType>([
    path(['scenes', 'foo']),
    actions({
        setFoo: (foo: string) => ({ foo }),
        reset: true,
    }),
    reducers({
        foo: [null as string | null, { setFoo: (_, { foo }) => foo }],
        bar: [0, {}],
    }),
    selectors({
        foo: [(s) => [s.bar], (bar) => bar],
        fooUpper: [(s) => [s.foo], (foo) => foo?.toUpperCase()],
    }),
    loaders(({ values }) => ({
        items: [[] as string[], { loadItems: async () => values.foo ?? [] }],
    })),
    listeners(({ actions }) => ({
        setFoo: () => actions.loadItems(),
    })),
]);

export const emptyLogic = kea<emptyLogicType>([]);
`;

/** The legacy shape the knob must leave untouched: a state object literal. */
const OBJECT_FORM = `import { create } from 'zustand';

export const useCounter = create((set, get) => ({
    count: 0,
    label: 'hits',
    increment: () => set({ count: get().count + 1 }),
}));
`;

const builderProfile = (): ExtractionProfile => ({
  parserId: 'test-state-store-builders',
  substrate: { language: 'ts', include: ['**/*.ts'], exclude: ['**/node_modules/**'] },
  stateStores: [
    {
      library: 'other',
      factory: 'kea',
      fromModule: 'kea',
      builders: {
        actionBuilders: ['actions'],
        selectorBuilders: ['selectors', 'reducers', 'loaders'],
      },
    },
  ],
});

describe('stateStores[].builders — builder-array member extraction', () => {
  it('reads action/selector keys from the listed builders, dedups, and ignores the rest', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pp-store-builders-'));
    writeFileSync(join(dir, 'fooLogic.ts'), BUILDER_ARRAY);
    const { repo } = await runProfile(builderProfile(), dir, 'store-builders-test');

    const foo = (repo.stateStores ?? []).find((s) => s.storeName === 'fooLogic');
    expect(foo).toBeDefined();
    expect(foo?.library).toBe('other');
    // `actions({…})` keys are actions — value shape irrelevant (`reset: true` counts).
    expect((foo?.actions ?? []).map((a) => a.name).sort()).toEqual(['reset', 'setFoo']);
    // reducers + selectors + loaders keys are the value surface; `foo` appears in two
    // builders and is recorded once. `loaders(({ values }) => ({…}))` is unwrapped.
    expect((foo?.selectors ?? []).map((s) => s.name).sort()).toEqual(['bar', 'fooUpper', 'foo', 'items'].sort());
    // `listeners` is in neither list — its keys must not leak in as members.
    expect((foo?.actions ?? []).some((a) => a.name === 'loadItems')).toBe(false);
    // Locations point at the builder's own key, inside the declaring file.
    for (const m of [...(foo?.actions ?? []), ...(foo?.selectors ?? [])]) {
      expect(m.location.filePath).toBe('fooLogic.ts');
      expect(m.location.startLine).toBeGreaterThan(1);
    }
  });

  it('emits a memberless store for an empty builder array without crashing', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pp-store-builders-empty-'));
    writeFileSync(join(dir, 'fooLogic.ts'), BUILDER_ARRAY);
    const { repo } = await runProfile(builderProfile(), dir, 'store-builders-test');

    const empty = (repo.stateStores ?? []).find((s) => s.storeName === 'emptyLogic');
    expect(empty).toBeDefined();
    expect(empty?.actions ?? []).toEqual([]);
    expect(empty?.selectors ?? []).toEqual([]);
  });

  it('leaves the object-literal store form unchanged when `builders` is absent', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pp-store-object-'));
    writeFileSync(join(dir, 'counter.ts'), OBJECT_FORM);
    const profile: ExtractionProfile = {
      parserId: 'test-state-store-object',
      substrate: { language: 'ts', include: ['**/*.ts'], exclude: ['**/node_modules/**'] },
      stateStores: [{ library: 'zustand', factory: 'create', fromModule: 'zustand' }],
    };
    const { repo } = await runProfile(profile, dir, 'store-object-test');

    const counter = (repo.stateStores ?? []).find((s) => s.storeName === 'useCounter');
    expect(counter?.actions.map((a) => a.name)).toEqual(['increment']);
    expect(counter?.selectors.map((s) => s.name).sort()).toEqual(['count', 'label']);
  });
});
