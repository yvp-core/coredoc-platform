import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { INTENT_TASKS, IntentPromptShape, IntentTaskStage, intentTaskById } from './tasks.js';

const FIXTURE_INTENT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixture-repo',
  '.coredoc',
  'intent.json',
);

/** Every item id the fixture overlay actually declares. */
function fixtureIntentIds(): Set<string> {
  const file = JSON.parse(fs.readFileSync(FIXTURE_INTENT_PATH, 'utf-8')) as { items: { id: string }[] };
  return new Set(file.items.map((item) => item.id));
}

/** Ids of the shape a `CITE_ACCEPTED` requirement string embeds, e.g. `br-charged-money-rounded-half-up`. */
const INTENT_ID_PATTERN = /\b(?:cap|uc|flow|br|lim|dec)-[a-z0-9]+(?:-[a-z0-9]+)*\b/g;

describe('INTENT_TASKS corpus', () => {
  it('carries unique ids and a routed set exactly on the routed shapes', () => {
    expect(new Set(INTENT_TASKS.map((task) => task.id)).size).toBe(INTENT_TASKS.length);
    for (const task of INTENT_TASKS) {
      if (task.shape === IntentPromptShape.Routed) expect(task.routedIntentIds.length).toBeGreaterThan(0);
      else expect(task.routedIntentIds).toEqual([]);
    }
  });

  // Acceptance 3's passes-while-broken: without a fact the control arm is
  // EXPECTED to trip, an "everything is fine" judge is undetectable for that
  // task, and `judgeInsensitive` is measured against an empty expectation.
  it('gives every task at least one forbidden fact a control artifact should trip', () => {
    for (const task of INTENT_TASKS) {
      const expected = task.forbiddenFacts.filter((fact) => fact.baselineExpected);
      expect(expected.length, `${task.id} has no baselineExpected forbidden fact`).toBeGreaterThanOrEqual(1);
    }
  });

  it('keeps required and forbidden fact ids unique within a task', () => {
    for (const task of INTENT_TASKS) {
      const ids = [...task.requiredFacts.map((f) => f.id), ...task.forbiddenFacts.map((f) => f.id)];
      expect(new Set(ids).size, `${task.id} repeats a fact id`).toBe(ids.length);
    }
  });

  // Review P2-8: a prompt that names the module the artifact is supposed to
  // DISCOVER hands the touchpoint to both arms and the task stops discriminating.
  it('never names the money helper in a prompt whose required fact is finding it', () => {
    for (const task of INTENT_TASKS) {
      const requiresDiscovery = task.requiredFacts.some((fact) => fact.requirement.includes('src/formatting/money.ts'));
      if (!requiresDiscovery) continue;
      expect(task.prompt, `${task.id} leaks the module path`).not.toContain('src/formatting/money.ts');
      expect(task.prompt, `${task.id} leaks the helper name`).not.toContain('money.ts');
      // The review task's diff is the artifact under review, so the `roundCurrency`
      // call inside it stays; no other stage may name the symbol.
      if (task.stage !== IntentTaskStage.Review) {
        expect(task.prompt, `${task.id} leaks the helper symbol`).not.toContain('roundCurrency');
      }
    }
  });

  // A typo'd id in a fixed task must fail the (free) unit suite, not silently
  // resolve to nothing in a paid eval run and burn the budget on a task that
  // can never pass or a fact that can never be cited.
  it('references only intent ids the fixture overlay actually declares (routed ids and cited facts)', () => {
    const declared = fixtureIntentIds();
    for (const task of INTENT_TASKS) {
      for (const routedId of task.routedIntentIds) {
        expect(declared.has(routedId), `${task.id} routes an undeclared intent id: ${routedId}`).toBe(true);
      }
      for (const fact of task.requiredFacts) {
        const cited = fact.requirement.match(INTENT_ID_PATTERN) ?? [];
        for (const citedId of cited) {
          expect(
            declared.has(citedId),
            `${task.id}/${fact.id} cites an undeclared intent id: ${citedId}`,
          ).toBe(true);
        }
      }
    }
  });

  it('resolves a task by id and returns undefined for an unknown one', () => {
    expect(intentTaskById('plan-stock-shortfall')?.stage).toBe(IntentTaskStage.Plan);
    expect(intentTaskById('nope')).toBeUndefined();
  });
});
