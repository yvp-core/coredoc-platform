import { describe, expect, it } from 'vitest';
import { LENSES, LENS_CATALOGUE, LENS_ORDER, LensId, normalizeRoute, routerSchema } from './lenses.js';

const chosen = (id: string, focusFiles: string[] = []) => ({ id, reason: `because ${id}`, focusFiles });
const paths = ['src/a.ts', 'src/b.ts'];

describe('lens catalogue', () => {
  it('describes every lens for the router and puts logic first', () => {
    expect(LENS_ORDER[0]).toBe(LensId.Logic);
    expect(LENS_CATALOGUE).toHaveLength(LENS_ORDER.length);
    for (const id of LENS_ORDER) {
      expect(LENSES[id].text.length).toBeGreaterThan(200);
      expect(LENS_CATALOGUE.some((line) => line.startsWith(`${id}: `))).toBe(true);
    }
  });
  it('accepts a routing answer and refuses an unknown field', () => {
    expect(routerSchema.safeParse({ lenses: [chosen('logic')] }).success).toBe(true);
    expect(routerSchema.safeParse({ lenses: [{ ...chosen('logic'), extra: 1 }] }).success).toBe(false);
    expect(routerSchema.safeParse({ findings: [] }).success).toBe(false);
  });
});

describe('normalizeRoute', () => {
  it('always runs logic, even when the router leaves it out', () => {
    expect(normalizeRoute([chosen('ui')], paths, 4)).toEqual([
      { id: LensId.Logic, reason: 'Always reviewed', focusFiles: [] },
      { id: LensId.Ui, reason: 'because ui', focusFiles: [] },
    ]);
    expect(normalizeRoute([], paths, 4)).toEqual([{ id: LensId.Logic, reason: 'Always reviewed', focusFiles: [] }]);
  });
  it('drops unknown ids and duplicates, keeping the first reason', () => {
    const routes = normalizeRoute(
      [chosen('logic'), chosen('not-a-lens'), chosen('concurrency'), { ...chosen('concurrency'), reason: 'again' }],
      paths,
      4,
    );
    expect(routes.map((r) => r.id)).toEqual([LensId.Logic, LensId.Concurrency]);
    expect(routes[1]!.reason).toBe('because concurrency');
  });
  it('returns the lenses in catalogue order and caps them at maxLenses, never dropping logic', () => {
    const routes = normalizeRoute([chosen('ui'), chosen('trust-boundary'), chosen('data-safety')], paths, 2);
    expect(routes.map((r) => r.id)).toEqual([LensId.Logic, LensId.DataSafety]);
  });
  it('keeps only focus files that are eligible changed paths in this run', () => {
    const routes = normalizeRoute(
      [chosen('data-safety', ['src/b.ts', 'src/never-changed.ts', '../../etc/passwd'])],
      paths,
      4,
    );
    expect(routes[1]!.focusFiles).toEqual(['src/b.ts']);
  });
});
