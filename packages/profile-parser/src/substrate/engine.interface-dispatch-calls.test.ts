/**
 * Acceptance for interface-dispatch call binding (`iface-impl`):
 *
 *   async function workflow(activities: ActivityInterfaceFor<IActivities>) {
 *     await activities.recalculateStuckShiftSummaries(scopeId);   // ← must be a CALLS edge
 *   }
 *
 * Field evidence: the activity-proxy shape produced NO edge at all — the compiler binds the call
 * to the interface MEMBER, which is not a function node, so the SCIP pass fell into its external
 * branch and (before this change) deleted the structural call while minting a self-referential
 * "external service" the engine discards. Everything the workflow reached past that call became
 * unreachable, and a caller lookup on the activity method answered a confident zero.
 *
 * The binding is an inference, not a proof: it fires only when the parameter's type names exactly
 * one in-repo interface and exactly one class in scope implements it. Every ambiguity abstains and
 * leaves the unresolved call plus the IMPLEMENTS_INTERFACE edge as the honest two-hop path. The
 * fixtures below are the real fleet shape (a Temporal-style activity proxy), and the engine reads
 * only the type structure — it knows no framework.
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

const PROXY = `export type ActivityInterfaceFor<T> = { [K in keyof T]: T[K] };
export type Wrap<T> = ActivityInterfaceFor<T>;

export function proxyActivities<T>(): ActivityInterfaceFor<T> {
  return {} as ActivityInterfaceFor<T>;
}
`;

const INTERFACES = `export interface IRecalculateStuckShiftSummariesActivitiesService {
  recalculateStuckShiftSummaries(scopeId: string): Promise<boolean>;
}

export interface IReportActivities {
  buildReport(scopeId: string): Promise<string>;
}

export interface IPartialActivities {
  implementedStep(): void;
  unimplementedStep(): void;
}
`;

const SERVICES = `import type {
  IPartialActivities,
  IRecalculateStuckShiftSummariesActivitiesService,
  IReportActivities,
} from './activities-interface';

export class RecalculateStuckActivitiesService implements IRecalculateStuckShiftSummariesActivitiesService {
  async recalculateStuckShiftSummaries(scopeId: string): Promise<boolean> {
    return scopeId.length > 0;
  }
}

export class ReportActivitiesService implements IReportActivities {
  async buildReport(scopeId: string): Promise<string> {
    return scopeId;
  }
}

export class PartialActivitiesService implements IPartialActivities {
  implementedStep(): void {}
}
`;

/**
 * A module declaring an interface — and an implementing class — of the SAME NAMES as
 * `activities-interface.ts` / `activities-service.ts`, each with its own sole implementation.
 * Identity must come from the import and the id from the implementing class's own LOCATION: a
 * repo-wide bare-name method index holds one entry per class name, so it would answer with
 * whichever file was indexed last for both workflows.
 */
const UNRELATED = `export interface IRecalculateStuckShiftSummariesActivitiesService {
  recalculateStuckShiftSummaries(scopeId: string): Promise<boolean>;
}

export class RecalculateStuckActivitiesService implements IRecalculateStuckShiftSummariesActivitiesService {
  async recalculateStuckShiftSummaries(scopeId: string): Promise<boolean> {
    return scopeId.length === 0;
  }
}
`;

const WORKFLOW = `import { proxyActivities } from './proxy';
import type { ActivityInterfaceFor, Wrap } from './proxy';
import type {
  IPartialActivities,
  IRecalculateStuckShiftSummariesActivitiesService,
  IReportActivities,
} from './activities-interface';
import type { IRecalculateStuckShiftSummariesActivitiesService as IUnrelatedActivities } from './unrelated';
import { RecalculateStuckActivitiesService } from './activities-service';

const proxied = proxyActivities<IRecalculateStuckShiftSummariesActivitiesService>();

export async function recalculateStuckWorkflow(
  scopeId: string,
  activities: ActivityInterfaceFor<IRecalculateStuckShiftSummariesActivitiesService> = proxied,
): Promise<boolean> {
  return activities.recalculateStuckShiftSummaries(scopeId);
}

export async function unrelatedWorkflow(
  scopeId: string,
  activities: ActivityInterfaceFor<IUnrelatedActivities>,
): Promise<boolean> {
  return activities.recalculateStuckShiftSummaries(scopeId);
}

export async function nestedGenericWorkflow(
  scopeId: string,
  activities: Wrap<Pick<IReportActivities, 'buildReport'>>,
): Promise<string> {
  return activities.buildReport(scopeId);
}

export async function intersectionWorkflow(
  scopeId: string,
  activities: IRecalculateStuckShiftSummariesActivitiesService & IReportActivities,
): Promise<boolean> {
  return activities.recalculateStuckShiftSummaries(scopeId);
}

const boundInstance = new RecalculateStuckActivitiesService();

export async function typeofWorkflow(scopeId: string, activities: typeof boundInstance): Promise<boolean> {
  return activities.recalculateStuckShiftSummaries(scopeId);
}

export async function partialWorkflow(activities: ActivityInterfaceFor<IPartialActivities>): Promise<void> {
  activities.unimplementedStep();
}

export async function partialControlWorkflow(activities: ActivityInterfaceFor<IPartialActivities>): Promise<void> {
  activities.implementedStep();
}

export async function localReceiverWorkflow(scopeId: string): Promise<boolean> {
  const activities: ActivityInterfaceFor<IRecalculateStuckShiftSummariesActivitiesService> = proxied;
  return activities.recalculateStuckShiftSummaries(scopeId);
}
`;

/** Two classes implementing ONE interface: ambiguous, so the call must stay unresolved. */
const TWO_IMPL_INTERFACE = `export interface IRecalculateStuckShiftSummariesActivitiesService {
  recalculateStuckShiftSummaries(scopeId: string): Promise<boolean>;
}
`;
const TWO_IMPL_SERVICES = `import type { IRecalculateStuckShiftSummariesActivitiesService } from './activities-interface';

export class PrimaryActivitiesService implements IRecalculateStuckShiftSummariesActivitiesService {
  async recalculateStuckShiftSummaries(scopeId: string): Promise<boolean> {
    return scopeId.length > 0;
  }
}

export class SecondaryActivitiesService implements IRecalculateStuckShiftSummariesActivitiesService {
  async recalculateStuckShiftSummaries(scopeId: string): Promise<boolean> {
    return false;
  }
}
`;
const TWO_IMPL_WORKFLOW = `import type { ActivityInterfaceFor } from './proxy';
import type { IRecalculateStuckShiftSummariesActivitiesService } from './activities-interface';

export async function recalculateStuckWorkflow(
  scopeId: string,
  activities: ActivityInterfaceFor<IRecalculateStuckShiftSummariesActivitiesService>,
): Promise<boolean> {
  return activities.recalculateStuckShiftSummaries(scopeId);
}
`;

/**
 * One BOUND sole implementor plus a second implementor whose heritage clause the binder cannot
 * resolve (a dotted base). The unbound clause is a potential second implementor of the same
 * interface, so the sole-implementation binding must abstain rather than bind to the one it could
 * resolve. NOTE: the abstention keys on the interface NAME across the whole baseline — a fleet-wide
 * over-abstention risk (one unbound `implements Foo` anywhere silences every `Foo` binding), so the
 * bind-rate must be re-measured on the fleet to tell a precision win from a silently-off tier.
 */
const UNBOUND_INTERFACE = `export interface IWidgetActivities {
  renderWidget(id: string): Promise<string>;
}
`;
const CONTRACTS = `export interface IWidgetActivities {
  renderWidget(id: string): Promise<string>;
}
`;
const UNBOUND_SERVICES = `import type { IWidgetActivities } from './activities-interface';
import type * as Contracts from './contracts';

export class RealWidgetService implements IWidgetActivities {
  async renderWidget(id: string): Promise<string> {
    return id;
  }
}

// The binder refuses a dotted heritage base, so this implementor stays UNBOUND — its identity is
// unknown, which is exactly why it must count as a possible second implementor.
export class VendorWidgetService implements Contracts.IWidgetActivities {
  async renderWidget(id: string): Promise<string> {
    return id.toUpperCase();
  }
}
`;
const UNBOUND_WORKFLOW = `import { proxyActivities } from './proxy';
import type { ActivityInterfaceFor } from './proxy';
import type { IWidgetActivities } from './activities-interface';

const widgets = proxyActivities<IWidgetActivities>();

export async function widgetWorkflow(
  id: string,
  activities: ActivityInterfaceFor<IWidgetActivities> = widgets,
): Promise<string> {
  return activities.renderWidget(id);
}
`;

// A second implementor whose heritage is PROVEN external (named import, aliased, from a
// dependency declared in package.json): the 07a resolver stamps `external: true` on the
// clause, so it must NOT count as a possible second implementor — the base lives outside
// the repo and can never be the dispatch target of an in-repo interface.
const EXTERNAL_SERVICES = `import type { IWidgetActivities } from './activities-interface';
import type { IWidgetActivities as VendorWidgets } from 'vendor-widgets';

export class RealWidgetService implements IWidgetActivities {
  async renderWidget(id: string): Promise<string> {
    return id;
  }
}

export class VendorWidgetService implements VendorWidgets {
  async renderWidget(id: string): Promise<string> {
    return id.toUpperCase();
  }
}
`;

const writeExternalSecondImplFixture = (): string =>
  writeFixture(
    {
      'proxy.ts': PROXY,
      'activities-interface.ts': UNBOUND_INTERFACE,
      'activities-service.ts': EXTERNAL_SERVICES,
      'workflow.ts': UNBOUND_WORKFLOW,
    },
    'pp-iface-dispatch-ext-',
    { 'vendor-widgets': '1.0.0' },
  );

/** SCIP runs only when node_modules exists; the package NAME is what its monikers carry. */
const PACKAGE_NAME = 'iface-dispatch-fixture';

function writeFixture(files: Record<string, string>, prefix: string, deps?: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: PACKAGE_NAME, version: '1.0.0', type: 'module', ...(deps && { dependencies: deps }) }),
  );
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: false },
      include: ['src'],
    }),
  );
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, 'src', name), body);
  return root;
}

const writeSoleImplFixture = (): string =>
  writeFixture(
    {
      'proxy.ts': PROXY,
      'activities-interface.ts': INTERFACES,
      'activities-service.ts': SERVICES,
      'unrelated.ts': UNRELATED,
      'workflow.ts': WORKFLOW,
    },
    'pp-iface-dispatch-',
  );

const writeTwoImplFixture = (): string =>
  writeFixture(
    {
      'proxy.ts': PROXY,
      'activities-interface.ts': TWO_IMPL_INTERFACE,
      'activities-service.ts': TWO_IMPL_SERVICES,
      'workflow.ts': TWO_IMPL_WORKFLOW,
    },
    'pp-iface-dispatch-two-',
  );

const writeUnboundSecondImplFixture = (): string =>
  writeFixture(
    {
      'proxy.ts': PROXY,
      'activities-interface.ts': UNBOUND_INTERFACE,
      'contracts.ts': CONTRACTS,
      'activities-service.ts': UNBOUND_SERVICES,
      'workflow.ts': UNBOUND_WORKFLOW,
    },
    'pp-iface-dispatch-unbound-',
  );

const PROFILE: ExtractionProfile = {
  parserId: 'test-interface-dispatch-calls',
  substrate: { language: 'ts', include: ['src/**/*.ts'], exclude: ['**/node_modules/**'] },
};

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

/** Unresolved call sites whose expression mentions `name`, as `caller->expression`. */
function unresolvedSites(repo: ParsedRepo, name: string): string[] {
  const byId = new Map(repo.functions.map((f) => [f.id, f]));
  return repo.calls
    .filter((c) => !c.calleeId && c.calleeExpression.includes(name))
    .map((c) => `${byId.get(c.callerId)?.name}->${c.calleeExpression}`);
}

describe('call graph — interface-dispatch binding', () => {
  it('binds a parameter-typed interface call to its sole in-scope implementation', async () => {
    const { repo } = await runProfile(PROFILE, writeSoleImplFixture(), 'iface-dispatch');
    const edges = resolvedEdges(repo);
    expect(edges).toContain(
      'recalculateStuckWorkflow->activities-service.ts:recalculateStuckShiftSummaries:iface-impl',
    );
  });

  it('binds through a nested mapped generic, reading the interface out of the type arguments', async () => {
    const { repo } = await runProfile(PROFILE, writeSoleImplFixture(), 'iface-dispatch');
    // `Wrap<Pick<IReportActivities, 'buildReport'>>` — `Wrap` and `Pick` name no in-repo interface,
    // so the single interface the type names is the one nested two levels down.
    expect(resolvedEdges(repo)).toContain('nestedGenericWorkflow->activities-service.ts:buildReport:iface-impl');
  });

  it('resolves the interface through the IMPORT, so a same-named interface elsewhere cannot capture it', async () => {
    const { repo } = await runProfile(PROFILE, writeSoleImplFixture(), 'iface-dispatch');
    const edges = resolvedEdges(repo);
    // Two modules declare `IRecalculateStuckShiftSummariesActivitiesService`, each with its own sole
    // implementation. Each workflow must land in the module it imported from — never the other.
    expect(edges).toContain('unrelatedWorkflow->unrelated.ts:recalculateStuckShiftSummaries:iface-impl');
    expect(edges).not.toContain('unrelatedWorkflow->activities-service.ts:recalculateStuckShiftSummaries:iface-impl');
    expect(edges).not.toContain('recalculateStuckWorkflow->unrelated.ts:recalculateStuckShiftSummaries:iface-impl');
  });

  it('abstains on an intersection type, a `typeof` query, and a receiver that is a local, not a parameter', async () => {
    const { repo } = await runProfile(PROFILE, writeSoleImplFixture(), 'iface-dispatch');
    const inferred = resolvedEdges(repo).filter((e) => e.endsWith(':iface-impl'));
    // `A & B` names two in-repo interfaces — which one the value implements is not decidable here.
    expect(inferred.some((e) => e.startsWith('intersectionWorkflow->'))).toBe(false);
    // `typeof x` is a type QUERY: the type parser models no structure for it, so no name is read.
    expect(inferred.some((e) => e.startsWith('typeofWorkflow->'))).toBe(false);
    // v1 scope: only a parameter's declared type is read; a local binding is not a signature.
    expect(inferred.some((e) => e.startsWith('localReceiverWorkflow->'))).toBe(false);
  });

  it('abstains when the sole implementor does not implement the called member', async () => {
    const { repo } = await runProfile(PROFILE, writeSoleImplFixture(), 'iface-dispatch');
    const edges = resolvedEdges(repo);
    // The class implements the interface but declares no `unimplementedStep` — no method node.
    expect(edges.some((e) => e.startsWith('partialWorkflow->') && e.includes(':unimplementedStep:'))).toBe(false);
    // Control on the same interface and the same class: the implemented member DOES bind.
    expect(edges).toContain('partialControlWorkflow->activities-service.ts:implementedStep:iface-impl');
  });

  it('abstains with two implementors, leaving the unresolved call and the IMPLEMENTS edges', async () => {
    const { repo } = await runProfile(PROFILE, writeTwoImplFixture(), 'iface-dispatch-two');
    expect(resolvedEdges(repo).some((e) => e.endsWith(':iface-impl'))).toBe(false);
    // The honest two-hop fallback: the call site survives as an unresolved edge…
    expect(unresolvedSites(repo, 'recalculateStuckShiftSummaries')).toContain(
      'recalculateStuckWorkflow->activities.recalculateStuckShiftSummaries',
    );
    // …and both implementations are reachable from the interface through bound heritage clauses.
    const iface = repo.interfaces.find((i) => i.name === 'IRecalculateStuckShiftSummariesActivitiesService')!;
    const implementors = repo.classes
      .filter((c) => c.implements?.some((i) => i.resolvedId === iface.id))
      .map((c) => c.name)
      .sort();
    expect(implementors).toEqual(['PrimaryActivitiesService', 'SecondaryActivitiesService']);
  });

  it('abstains when a second implementor exists behind an UNBOUND (dotted) heritage clause', async () => {
    const { repo } = await runProfile(PROFILE, writeUnboundSecondImplFixture(), 'iface-dispatch-unbound');
    // The bound sole implementor alone would bind; the dotted `implements Contracts.IWidgetActivities`
    // is a potential second implementor the binder could not resolve, so the dispatch abstains.
    expect(resolvedEdges(repo).some((e) => e.includes(':renderWidget:iface-impl'))).toBe(false);
    // The call survives as an honest unresolved site.
    expect(unresolvedSites(repo, 'renderWidget')).toContain('widgetWorkflow->activities.renderWidget');
    // Sanity: exactly one implementor was BOUND (the resolvable one) — the abstention is driven by
    // the unbound clause, not by two bound implementors.
    const iface = repo.interfaces.find((i) => i.name === 'IWidgetActivities')!;
    const bound = repo.classes.filter((c) => c.implements?.some((i) => i.resolvedId === iface.id)).map((c) => c.name);
    expect(bound).toEqual(['RealWidgetService']);
  });

  it('does NOT abstain for a second implementor whose heritage is PROVEN external', async () => {
    // Inverse pin of the unbound-suppression rule: VendorWidgetService implements an
    // interface imported from a DECLARED dependency, so the 07a resolver stamps the
    // clause `external: true` — a proven-outside base can never be the dispatch target
    // of the in-repo interface, and must not defeat the sole-implementation test.
    const { repo } = await runProfile(PROFILE, writeExternalSecondImplFixture(), 'iface-dispatch-ext');
    const iface = repo.interfaces.find((i) => i.name === 'IWidgetActivities')!;
    const external = repo.classes.find((c) => c.name === 'VendorWidgetService')!;
    expect(external.implements?.[0]?.external).toBe(true);
    expect(external.implements?.[0]?.resolvedId).toBeUndefined();
    const bound = repo.classes.filter((c) => c.implements?.some((i) => i.resolvedId === iface.id)).map((c) => c.name);
    expect(bound).toEqual(['RealWidgetService']);
    expect(resolvedEdges(repo)).toContain('widgetWorkflow->activities-service.ts:renderWidget:iface-impl');
  });

  it('keeps the call site alive instead of reclassifying an own-package symbol as external egress', async () => {
    // Regression pin for the SCIP own-package guard: the interface MEMBER symbol names this repo's
    // own package, so the external branch must not fire. Before the guard it deleted the structural
    // call AND minted an external edge naming the repo's own package as the service — the site was
    // lost twice over, which is what made the binding above impossible in the first place.
    const { repo } = await runProfile(PROFILE, writeTwoImplFixture(), 'iface-dispatch-two');
    expect(unresolvedSites(repo, 'recalculateStuckShiftSummaries')).toHaveLength(1);
    expect(repo.externalCalls.some((e) => e.serviceName === PACKAGE_NAME)).toBe(false);
  });
});
