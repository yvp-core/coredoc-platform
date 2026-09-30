/**
 * Acceptance for type-usage extraction on DECLARED members: interface property /
 * method signatures, class properties and type-alias right-hand sides must carry
 * their annotated type, so the downstream USES_TYPE edge builder can link the
 * declaring interface/class to the types it references.
 *
 * Field evidence: `ExternalCallTarget` (packages/core/src/types/output.ts) had
 * USES_TYPE edges only from functions (parameters/returns); the interfaces
 * declaring `targetDescriptor: ExternalCallTarget` produced none, and the
 * `ExternalCallEdge` interface node had zero outgoing edges — the structural
 * pass dropped member type annotations entirely.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TypeInfo } from '@coredoc/core/types';
import type { ExtractionProfile } from '../types.js';
import { runProfile } from './run.js';

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const SOURCE = `export interface ExternalCallTarget {
  repoId: string;
}

export interface ExternalCallEdge {
  targetDescriptor: ExternalCallTarget;
  optionalTarget?: ExternalCallTarget;
  readonly targets: ExternalCallTarget[];
  boxed: Array<ExternalCallTarget>;
  eventual: Promise<ExternalCallTarget>;
  keyed: Record<string, ExternalCallTarget>;
  either: ExternalCallTarget | undefined;
  pair: [ExternalCallTarget, string];
  describe(): ExternalCallTarget;
  count: number;
}

export type ExternalCallLike = { targetDescriptor: ExternalCallTarget };

export class CallRegistry {
  private readonly latest: ExternalCallTarget | null = null;
  pending: ExternalCallTarget[] = [];

  register(target: ExternalCallTarget, boxed: Promise<ExternalCallTarget>, count: number): void {}
}

export function registerTarget(target: ExternalCallTarget, boxed: Array<ExternalCallTarget>): void {}
`;

/** Every type name referenced by a TypeInfo, walking the parsed structure. */
function refNames(t: TypeInfo | undefined): string[] {
  if (!t) return [];
  const out: string[] = [];
  const visit = (ti: TypeInfo | undefined): void => {
    const s = ti?.structure;
    if (!s) return;
    switch (s.kind) {
      case 'reference':
        out.push(s.name);
        s.typeArguments?.forEach(visit);
        return;
      case 'array':
        visit(s.elementType);
        return;
      case 'tuple':
        s.elements.forEach(visit);
        return;
      case 'union':
      case 'intersection':
        s.types.forEach(visit);
        return;
      default:
        return;
    }
  };
  visit(t);
  return out;
}

const PROFILE: ExtractionProfile = {
  parserId: 'test-type-usage',
  substrate: { language: 'ts', include: ['**/*.ts'], exclude: ['**/node_modules/**'] },
};

describe('type usage — declared member type annotations', () => {
  it('carries member/property/alias types with a parsed reference structure', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pp-type-usage-'));
    writeFileSync(join(dir, 'types.ts'), SOURCE);
    const { repo } = await runProfile(PROFILE, dir, 'type-usage');

    const edge = repo.interfaces.find((i) => i.name === 'ExternalCallEdge');
    expect(edge).toBeDefined();
    const memberRefs = new Map(
      (edge?.members ?? []).map((m) => [m.name, [...refNames(m.type), ...refNames(m.returnType)]]),
    );
    // direct, optional, array, Array<T>, generic one level deep, union, tuple, method return
    for (const member of [
      'targetDescriptor',
      'optionalTarget',
      'targets',
      'boxed',
      'eventual',
      'keyed',
      'either',
      'pair',
      'describe',
    ]) {
      expect(memberRefs.get(member), `member ${member}`).toContain('ExternalCallTarget');
    }
    // Primitives are not type references.
    expect(memberRefs.get('count')).toEqual([]);

    // Type alias RHS.
    const alias = repo.typeAliases.find((t) => t.name === 'ExternalCallLike');
    expect(alias?.aliasedType.text).toContain('ExternalCallTarget');

    // Class properties.
    const cls = repo.classes.find((c) => c.name === 'CallRegistry');
    const propRefs = new Map((cls?.properties ?? []).map((p) => [p.name, refNames(p.type)]));
    expect(propRefs.get('latest')).toContain('ExternalCallTarget');
    expect(propRefs.get('pending')).toContain('ExternalCallTarget');
  });

  it('carries the same parsed structure on function and method PARAMETERS', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pp-type-usage-params-'));
    writeFileSync(join(dir, 'types.ts'), SOURCE);
    const { repo } = await runProfile(PROFILE, dir, 'type-usage-params');

    // A parameter's annotation is a type reference like any other: without its structure a
    // consumer has only the raw text to re-parse, which is what the interface-dispatch binding
    // reads (it must see `ExternalCallTarget` inside `Promise<…>`).
    const paramRefs = (fnName: string): Map<string, string[]> =>
      new Map((repo.functions.find((f) => f.name === fnName)?.parameters ?? []).map((p) => [p.name, refNames(p.type)]));

    const fn = paramRefs('registerTarget');
    expect(fn.get('target')).toEqual(['ExternalCallTarget']);
    expect(fn.get('boxed')).toContain('ExternalCallTarget');

    const method = paramRefs('register');
    expect(method.get('target')).toEqual(['ExternalCallTarget']);
    // Nested inside a generic argument — the case the binding pass depends on.
    expect(method.get('boxed')).toContain('ExternalCallTarget');
    // Primitives stay primitives; the annotation text is unchanged either way.
    expect(method.get('count')).toEqual([]);
    expect(
      repo.functions.find((f) => f.name === 'register')?.parameters.find((p) => p.name === 'count')?.type?.text,
    ).toBe('number');
  });
});
