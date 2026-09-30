/**
 * Acceptance for call resolution through a destructured ACCESSOR-HOOK binding:
 *
 *   const { launchItem } = useStoreActions(myStore);
 *   launchItem();                               // ← must be a CALLS edge
 *
 * Field evidence: a store/logic framework hands out its bound member functions through a
 * hook, and every call through such a binding produced an unresolved edge. The compiler
 * binds the destructured name to a GENERATED property of the hook's return type, which SCIP
 * cannot turn into a function — either it resolves to a property definition sitting in no
 * function span (the SCIP pass then drops the structural sibling and reclassifies the site
 * as external → the engine MINTS the edge), or, when the return type erases, the name stays
 * a document-`local` and the structural sibling survives (→ the engine CORRECTS it in place).
 * Both shapes are covered below. What resolves either is the hook argument (`myStore`), an
 * ordinary identifier whose SCIP symbol names its defining file.
 *
 * The hook names are profile config (`callGraph.accessorHooks`); the engine knows no
 * framework, only the shape.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ParsedRepo } from '@coredoc/core/types';
import type { ExtractionProfile } from '../types.js';
import { runProfile } from './run.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const HOOKS = `export type ActionMap = Record<string, (id: number) => number>;

export function useStoreActions(store: { actions: ActionMap }): ActionMap {
  return store.actions;
}
export function useOtherActions(store: { actions: ActionMap }): ActionMap {
  return store.actions;
}
export function makeStore(): { actions: ActionMap } {
  return { actions: {} };
}
`;

const STORE = `export function launchItem(id: number): number {
  return id + 1;
}
export function refreshItem(id: number): number {
  return id;
}
export const myStore = { actions: { launchItem, refreshItem } };
`;

/**
 * The trap for a `local N` fallback: `local N` is unique only WITHIN a document, so an index
 * keyed on the raw symbol answers with whichever document defined that `local N` first. This
 * file is that first document — it declares a long run of locals and a function whose name a
 * consumer's binding also uses, so a document-local hook argument would "resolve" here.
 */
const AAA_DECOY = `export function launchItem(id: number): number {
  const a1 = 1;
  const a2 = 2;
  const a3 = 3;
  const a4 = 4;
  const a5 = 5;
  const a6 = 6;
  const a7 = 7;
  const a8 = 8;
  const a9 = 9;
  const a10 = 10;
  const a11 = 11;
  const a12 = 12;
  const a13 = 13;
  const a14 = 14;
  const a15 = 15;
  return id + a1 + a2 + a3 + a4 + a5 + a6 + a7 + a8 + a9 + a10 + a11 + a12 + a13 + a14 + a15;
}
`;

const OTHER_STORE = `export function secondAction(id: number): number {
  return id;
}
export const otherStore = { actions: { secondAction } };
`;

// Two same-named methods in one file: the property name claims more than one function node,
// so the binding is ambiguous and must abstain.
const AMBIGUOUS_STORE = `class Alpha {
  duplicated(id: number): number {
    return id;
  }
}
class Beta {
  duplicated(id: number): number {
    return id;
  }
}
export const ambiguousStore = { actions: { duplicated: new Alpha().duplicated } };
`;

// Two stores in different files exporting the SAME action name — the shadowing cases below
// are only meaningful because the two targets are distinguishable by file.
const STORE_A = `export function run(id: number): number {
  return id + 1;
}
export const storeA = { actions: { run } };
`;
const STORE_B = `export function run(id: number): number {
  return id + 2;
}
export const storeB = { actions: { run } };
`;

const CONSUMER = `import { makeStore, useOtherActions, useStoreActions } from './hooks.js';
import { myStore } from './store.js';
import { otherStore } from './other-store.js';
import { ambiguousStore } from './ambiguous-store.js';
import { storeA } from './store-a.js';
import { storeB } from './store-b.js';

export function bindsAndCalls(id: number): number {
  const { launchItem } = useStoreActions(myStore);
  return launchItem(id);
}

export function bindsAliased(id: number): number {
  const { refreshItem: refresh } = useStoreActions(myStore);
  return refresh(id);
}

export function bindsSecondHook(id: number): number {
  const { secondAction } = useOtherActions(otherStore);
  return secondAction(id);
}

export function bindsAmbiguous(id: number): number {
  const { duplicated } = useStoreActions(ambiguousStore);
  return duplicated(id);
}

export function bindsUnknownRef(id: number): number {
  const { launchItem } = useStoreActions(unknownStore);
  return launchItem(id);
}

export function bindsRestAndDefault(id: number): number {
  const { launchItem = refreshLater, ...rest } = useStoreActions(myStore);
  return launchItem(id) + Object.keys(rest).length;
}

export function callsOutsideBindingScope(id: number): number {
  return refreshItem(id);
}

export function shadowedBinding(id: number): number {
  const { run } = useStoreActions(storeA);
  const inner = (n: number): number => {
    const { run } = useStoreActions(storeB);
    return run(n);
  };
  return run(id) + inner(id);
}

export function tiedBindings(id: number): number {
  var { run } = useStoreActions(storeA);
  var { run } = useStoreActions(storeB);
  return run(id);
}
`;

/**
 * The other SCIP shape: a hook whose return type erases (`any`), so the destructured name is
 * only a document-`local`. The SCIP pass leaves the structural sibling in place, and the
 * FIRST-PASS correction in `internalCalls` — including its exemption from the callee-name
 * gate for the aliased form — is what must resolve it.
 *
 * The call arguments are LITERALS on purpose: any other in-repo reference on the call line
 * (a parameter, say) is itself an unresolvable non-local symbol, and the SCIP pass would drop
 * the structural sibling for the whole line — putting the site back on the mint path.
 */
const ANY_HOOKS = `export function useLooseActions(store: unknown): any {
  return store;
}
`;
const ANY_CONSUMER = `import { useLooseActions } from './hooks.js';
import { myStore } from './store.js';

export function looseCall(): number {
  const { launchItem } = useLooseActions(myStore);
  return launchItem(1);
}

export function looseAliasedCall(): number {
  const { refreshItem: refresh } = useLooseActions(myStore);
  return refresh(2);
}
`;

const LOCAL_REF_CONSUMER = `import { makeStore, useStoreActions } from './hooks.js';

export function bindsLocalRef(id: number): number {
  const store = makeStore();
  const { launchItem } = useStoreActions(store);
  return launchItem(id);
}
`;

function writeFixture(files: Record<string, string>, prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  // scip-typescript's prerequisite check is the presence of node_modules.
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'ah-fixture', version: '1.0.0', type: 'module' }));
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' },
      include: ['src'],
    }),
  );
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, 'src', name), body);
  return root;
}

const writeMintFixture = (): string =>
  writeFixture(
    {
      'hooks.ts': HOOKS,
      'store.ts': STORE,
      'other-store.ts': OTHER_STORE,
      'ambiguous-store.ts': AMBIGUOUS_STORE,
      'store-a.ts': STORE_A,
      'store-b.ts': STORE_B,
      'consumer.ts': CONSUMER,
    },
    'pp-accessor-hook-',
  );

const writeLocalRefFixture = (): string =>
  writeFixture(
    { 'aaa-decoy.ts': AAA_DECOY, 'hooks.ts': HOOKS, 'consumer.ts': LOCAL_REF_CONSUMER },
    'pp-accessor-hook-localref-',
  );

const writeLocalSymbolFixture = (): string =>
  writeFixture({ 'hooks.ts': ANY_HOOKS, 'store.ts': STORE, 'consumer.ts': ANY_CONSUMER }, 'pp-accessor-hook-local-');

const BASE: ExtractionProfile = {
  parserId: 'test-accessor-hook-calls',
  substrate: { language: 'ts', include: ['src/**/*.ts'], exclude: ['**/node_modules/**'] },
};
const withHooks = (hooks: string[]): ExtractionProfile => ({ ...BASE, callGraph: { accessorHooks: hooks } });

/** `caller->calleeFile:calleeName:provenance` for every RESOLVED call edge. */
function resolvedEdges(repo: ParsedRepo): string[] {
  const byId = new Map(repo.functions.map((f) => [f.id, f]));
  return repo.calls
    .filter((c) => c.calleeId)
    .map((c) => {
      const callee = byId.get(c.calleeId as string);
      return `${byId.get(c.callerId)?.name}->${callee?.location.filePath.replace('src/', '')}:${callee?.name}:${c.provenance}`;
    });
}

describe('call graph — destructured accessor-hook bindings', () => {
  it('resolves shorthand, aliased and second-hook bindings, and abstains on every ambiguity', async () => {
    const { repo } = await runProfile(withHooks(['useStoreActions']), writeMintFixture(), 'accessor-hook');
    const edges = resolvedEdges(repo);

    // Happy path: the bound name resolves to the function in the hook argument's file.
    expect(edges).toContain('bindsAndCalls->store.ts:launchItem:accessor-hook');
    // Aliased destructure: the PROPERTY name is what resolves; the name gate must not veto it.
    expect(edges).toContain('bindsAliased->store.ts:refreshItem:accessor-hook');
    // Two same-named functions in the target file — no guess.
    expect(edges.some((e) => e.startsWith('bindsAmbiguous->') && e.includes(':duplicated:'))).toBe(false);
    // The hook argument names nothing SCIP can place in a scoped file — no guess.
    expect(edges.some((e) => e.includes('bindsUnknownRef->') && e.includes('launchItem'))).toBe(false);
    // Default value + rest element: neither names a plain destructured property — no guess.
    expect(edges.some((e) => e.startsWith('bindsRestAndDefault->') && e.includes(':launchItem:'))).toBe(false);
    // A call to a bound name from OUTSIDE the binding's scope span — no guess.
    expect(edges.some((e) => e.startsWith('callsOutsideBindingScope->'))).toBe(false);
  });

  it('resolves through a second configured hook name in the same profile', async () => {
    const { repo } = await runProfile(
      withHooks(['useStoreActions', 'useOtherActions']),
      writeMintFixture(),
      'accessor-hook',
    );
    const edges = resolvedEdges(repo);
    expect(edges).toContain('bindsAndCalls->store.ts:launchItem:accessor-hook');
    expect(edges).toContain('bindsSecondHook->other-store.ts:secondAction:accessor-hook');
  });

  it('a hook not listed in the profile resolves nothing through it', async () => {
    const { repo } = await runProfile(withHooks(['useStoreActions']), writeMintFixture(), 'accessor-hook');
    const edges = resolvedEdges(repo);
    // `useOtherActions` is unlisted in this profile.
    expect(edges.some((e) => e.startsWith('bindsSecondHook->other-store.ts:secondAction'))).toBe(false);
  });

  it('leaves the same calls unresolved when the profile lists no accessor hooks', async () => {
    const { repo } = await runProfile(BASE, writeMintFixture(), 'accessor-hook');
    const edges = resolvedEdges(repo);
    expect(edges.some((e) => e.includes('accessor-hook'))).toBe(false);
    expect(edges.some((e) => e.startsWith('bindsAndCalls->store.ts:launchItem'))).toBe(false);
    expect(edges.some((e) => e.startsWith('bindsAliased->store.ts:refreshItem'))).toBe(false);
    // Control: the hook call itself resolves through the ordinary static-import path either way.
    expect(edges).toContain('bindsAndCalls->hooks.ts:useStoreActions:scip');
  });

  it("abstains when the hook argument is a document-local, instead of taking another document's same-numbered local", async () => {
    // `local N` is unique only within its document. Here the decoy file is indexed FIRST and
    // defines the very `local N` that the consumer's `const store = makeStore()` gets, and it
    // exports a same-named `launchItem` — so a raw-symbol lookup would confidently bind the
    // call into a file the consumer never imports.
    const { repo } = await runProfile(withHooks(['useStoreActions']), writeLocalRefFixture(), 'accessor-hook-localref');
    const edges = resolvedEdges(repo);
    expect(edges.some((e) => e.startsWith('bindsLocalRef->') && e.includes(':launchItem:'))).toBe(false);
  });

  it('a nested rebinding shadows the outer one (narrowest scope wins), and a same-scope tie abstains', async () => {
    const { repo } = await runProfile(withHooks(['useStoreActions']), writeMintFixture(), 'accessor-hook');
    const edges = resolvedEdges(repo);
    // Outer call sees the outer binding…
    expect(edges).toContain('shadowedBinding->store-a.ts:run:accessor-hook');
    // …and the call inside the nested arrow sees the arrow's own rebinding, not the outer one.
    expect(edges).toContain('inner->store-b.ts:run:accessor-hook');
    expect(edges).not.toContain('inner->store-a.ts:run:accessor-hook');
    // Two bindings of one name, same scope, different targets: genuinely ambiguous → no edge.
    expect(edges.some((e) => e.startsWith('tiedBindings->') && e.includes(':run:'))).toBe(false);
  });

  it('mints exactly one edge per call site (the site key dedups against the first pass)', async () => {
    const { repo } = await runProfile(withHooks(['useStoreActions']), writeMintFixture(), 'accessor-hook');
    const byId = new Map(repo.functions.map((f) => [f.id, f]));
    const atSite = repo.calls.filter(
      (c) => byId.get(c.callerId)?.name === 'bindsAndCalls' && c.calleeExpression === 'launchItem',
    );
    // Both passes key a site as `caller|file|line|calleeExpression`, and a SCIP-minted edge now
    // carries the readable moniker TAIL there (not the raw moniker) — so a site the first pass
    // already emitted is recognized and never minted twice.
    expect(atSite).toHaveLength(1);
  });

  it('corrects the surviving structural sibling in place when the binding stays a document-local', async () => {
    const root = writeLocalSymbolFixture();
    const { repo } = await runProfile(withHooks(['useLooseActions']), root, 'accessor-hook-local');
    const edges = resolvedEdges(repo);
    expect(edges).toContain('looseCall->store.ts:launchItem:accessor-hook');
    // Aliased binding on the CORRECTION path: the callee node is `refreshItem` while the call
    // names `refresh`, so this only survives because the pass is exempt from the name gate.
    expect(edges).toContain('looseAliasedCall->store.ts:refreshItem:accessor-hook');

    // Proof that this fixture exercises the correction path and not the mint loop: without the
    // hook configured, the structural sibling is still THERE (unresolved) rather than dropped —
    // which is exactly the precondition the first pass upgrades in place.
    const { repo: plain } = await runProfile(BASE, root, 'accessor-hook-local');
    const residue = plain.calls.filter((c) => !c.calleeId && c.calleeExpression === 'launchItem');
    expect(residue).toHaveLength(1);
  });
});
