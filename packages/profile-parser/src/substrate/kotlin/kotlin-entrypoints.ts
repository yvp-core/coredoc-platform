/**
 * Android entrypoints (§Entrypoints).
 *
 * An entrypoint is a way INTO the app from the system: a launcher or deep-link activity, a
 * broadcast receiver, a WorkManager worker, a push or plain service, a content provider. A
 * plain Activity and every Fragment are internal screens, not entrypoints (D-4), and a class
 * with no lifecycle method emits NOTHING and is counted instead — a fabricated `handlerId`
 * would point the graph at a method that does not exist.
 *
 * Ids are keyed on the DECLARING file, never on the manifest, so the several manifests a
 * module carries (main + flavours) declaring the same component still yield ONE entrypoint per
 * (class, trigger).
 */
import type { StableIdGenerator } from '@coredoc/core';
import type { Entrypoint, MobileEntrypointDetails } from '@coredoc/core/types';
import type { KotlinFileFacts, KotlinTypeDecl } from './kotlin-declarations.js';
import type { KotlinTypeIndex } from './kotlin-resolve.js';
import type { AndroidManifestFacts, ManifestComponent, ManifestIntentFilter } from './kotlin-xml.js';

/** The action that marks an entry activity. Paired with a launcher category, see `isLauncher`. */
export const MAIN_ACTION = 'android.intent.action.MAIN';

/**
 * Categories that put a MAIN activity on a launcher surface. `LEANBACK_LAUNCHER` is the TV
 * home screen and `CAR_LAUNCHER` the automotive one — an app shipping only those still has a
 * launcher, so keying on the phone category alone would report it as having none.
 */
export const LAUNCHER_CATEGORIES: ReadonlySet<string> = new Set([
  'android.intent.category.LAUNCHER',
  'android.intent.category.LEANBACK_LAUNCHER',
  'android.intent.category.CAR_LAUNCHER',
]);

export type AndroidComponentKind = 'activity' | 'fragment' | 'receiver' | 'worker' | 'service' | 'push' | 'provider';

/** Framework base classes per component kind. A profile EXTENDS these; it never replaces them. */
export const DEFAULT_ANDROID_BASES: Record<AndroidComponentKind, readonly string[]> = {
  activity: ['Activity', 'AppCompatActivity', 'ComponentActivity', 'FragmentActivity'],
  fragment: ['Fragment', 'DialogFragment', 'BottomSheetDialogFragment'],
  receiver: ['BroadcastReceiver'],
  worker: ['Worker', 'CoroutineWorker', 'ListenableWorker', 'RxWorker'],
  service: ['Service', 'IntentService', 'JobIntentService', 'JobService'],
  push: ['FirebaseMessagingService'],
  provider: ['ContentProvider'],
};

/** The `android` block of a `KotlinProfile`, structurally (no import cycle into types/). */
export interface AndroidBaseConfig {
  activityBases?: string[];
  fragmentBases?: string[];
  receiverBases?: string[];
  workerBases?: string[];
  serviceBases?: string[];
  pushServiceBases?: string[];
  providerBases?: string[];
}

export type AndroidBases = Record<AndroidComponentKind, ReadonlySet<string>>;

/** Defaults plus the profile's extra bases. */
export function resolveAndroidBases(cfg: AndroidBaseConfig | undefined): AndroidBases {
  const merge = (kind: AndroidComponentKind, extra: string[] | undefined): ReadonlySet<string> =>
    new Set([...DEFAULT_ANDROID_BASES[kind], ...(extra ?? [])]);
  return {
    activity: merge('activity', cfg?.activityBases),
    fragment: merge('fragment', cfg?.fragmentBases),
    receiver: merge('receiver', cfg?.receiverBases),
    worker: merge('worker', cfg?.workerBases),
    service: merge('service', cfg?.serviceBases),
    push: merge('push', cfg?.pushServiceBases),
    provider: merge('provider', cfg?.providerBases),
  };
}

/**
 * A push service extends a plain Service, so it must be tested first; everything else is
 * disjoint. `fragment` is last because a repo base class may name both (it never should).
 */
const KIND_PRIORITY: readonly AndroidComponentKind[] = [
  'provider',
  'push',
  'receiver',
  'worker',
  'service',
  'activity',
  'fragment',
];

/** The lifecycle method that owns an entrypoint, in the order the spec fixes. */
const LIFECYCLE: Record<AndroidComponentKind, readonly string[]> = {
  activity: ['onCreate'],
  fragment: [],
  receiver: ['onReceive'],
  worker: ['doWork'],
  push: ['onMessageReceived'],
  service: ['onStartCommand', 'onBind', 'onCreate'],
  provider: ['onCreate', 'query'],
};

const TRIGGER: Record<Exclude<AndroidComponentKind, 'activity' | 'fragment'>, MobileEntrypointDetails['trigger']> = {
  receiver: 'broadcast',
  worker: 'background-work',
  push: 'push',
  service: 'service',
  provider: 'content-provider',
};

/**
 * Every FRAMEWORK supertype name of `decl` — a supertype that resolves to an in-repo class
 * contributes nothing itself, only the walk through it. That is the shadowing rule: a repo
 * declaring its own `Fragment` is not AndroidX's.
 */
function frameworkSupertypeNames(
  decl: KotlinTypeDecl,
  index: KotlinTypeIndex,
  byPath: ReadonlyMap<string, KotlinFileFacts>,
): string[] {
  const out: string[] = [];
  for (const node of index.supertypeChain(decl)) {
    const file = byPath.get(node.filePath);
    if (!file) continue;
    for (const spec of node.supertypes) {
      if (index.resolve(spec.name, file).status === 'resolved') continue;
      const simple = spec.name.includes('.') ? (spec.name.split('.').pop() as string) : spec.name;
      out.push(simple);
    }
  }
  return out;
}

/** The Android component kind of a class, or undefined when it is not one. */
export function classifyAndroidClass(
  decl: KotlinTypeDecl,
  index: KotlinTypeIndex,
  byPath: ReadonlyMap<string, KotlinFileFacts>,
  bases: AndroidBases,
): AndroidComponentKind | undefined {
  const names = frameworkSupertypeNames(decl, index, byPath);
  if (names.length === 0) return undefined;
  for (const kind of KIND_PRIORITY) {
    if (names.some((n) => bases[kind].has(n))) return kind;
  }
  return undefined;
}

/**
 * Resolve an `android:name` (manifest or navigation XML) to a declaration.
 *
 * An absolute FQCN resolves directly; a `.Relative` or bare name resolves by UNIQUE FQCN
 * suffix. Ambiguity and absence both yield undefined — a manifest entry naming a class this
 * parse cannot see is not evidence of anything.
 */
export function resolveDeclaredName(name: string, index: KotlinTypeIndex): KotlinTypeDecl | undefined {
  if (name.includes('.') && !name.startsWith('.')) {
    const direct = index.byFullyQualifiedName(name);
    if (direct) return direct;
  }
  const simple = name.startsWith('.') ? name.slice(1) : name;
  const suffix = `.${simple}`;
  const hits = index
    .fqcnsForSimpleName(simple.includes('.') ? (simple.split('.').pop() as string) : simple)
    .filter((fqcn) => fqcn === simple || fqcn.endsWith(suffix));
  if (hits.length !== 1) return undefined;
  return index.byFullyQualifiedName(hits[0]);
}

export interface KotlinEntrypointsInput {
  facts: readonly KotlinFileFacts[];
  index: KotlinTypeIndex;
  bases: AndroidBases;
  manifests: readonly AndroidManifestFacts[];
  idGen: StableIdGenerator;
}

export interface KotlinEntrypointsResult {
  entrypoints: Entrypoint[];
  /** Base-list classes that would have emitted but declare no lifecycle method anywhere. */
  entrypointsWithoutHandler: number;
}

/**
 * A launcher filter is `action.MAIN` paired with a launcher CATEGORY.
 *
 * The action alone is not enough: `action.MAIN` says "this is an entry activity", and the
 * category says which launcher surface shows it. An activity declaring MAIN with no launcher
 * category is reachable but not something the user taps on a home screen, so calling it
 * `launcher` would overstate it. Everything else with a filter is a deep link.
 */
function isLauncher(filter: ManifestIntentFilter): boolean {
  return filter.actions.includes(MAIN_ACTION) && filter.categories.some((c) => LAUNCHER_CATEGORIES.has(c));
}

/** Manifest entries, across every manifest, naming `decl`. */
function entriesFor(
  decl: KotlinTypeDecl,
  manifests: readonly AndroidManifestFacts[],
  index: KotlinTypeIndex,
): ManifestComponent[] {
  const out: ManifestComponent[] = [];
  for (const manifest of manifests) {
    for (const component of manifest.components) {
      if (resolveDeclaredName(component.name, index)?.fqcn === decl.fqcn) out.push(component);
    }
  }
  return out;
}

function unique(values: readonly string[]): string[] | undefined {
  const out = [...new Set(values)];
  return out.length > 0 ? out : undefined;
}

/** Android entrypoints for the whole repo. */
export function extractKotlinEntrypoints(input: KotlinEntrypointsInput): KotlinEntrypointsResult {
  const { facts, index, bases, manifests, idGen } = input;
  const byPath = new Map(facts.map((f) => [f.relPath, f]));
  const entrypoints: Entrypoint[] = [];
  const seen = new Set<string>();
  let entrypointsWithoutHandler = 0;

  for (const file of facts) {
    for (const decl of file.declarations.values()) {
      const kind = classifyAndroidClass(decl, index, byPath, bases);
      if (!kind || kind === 'fragment') continue;
      const entries = entriesFor(decl, manifests, index);
      const exported = entries.find((e) => e.exported !== undefined)?.exported;

      // Which (trigger, actions, uriPatterns) this class contributes.
      const emissions: { trigger: MobileEntrypointDetails['trigger']; actions?: string[]; uris?: string[] }[] = [];
      if (kind === 'activity') {
        const filters = entries.flatMap((e) => e.intentFilters);
        // A plain Activity — no intent filter anywhere — is an internal screen (D-4).
        for (const trigger of ['launcher', 'deep-link'] as const) {
          const group = filters.filter((f) => (trigger === 'launcher' ? isLauncher(f) : !isLauncher(f)));
          if (group.length === 0) continue;
          emissions.push({
            trigger,
            actions: unique(group.flatMap((f) => f.actions)),
            uris: unique(group.flatMap((f) => f.uriPatterns)),
          });
        }
      } else {
        emissions.push({
          trigger: TRIGGER[kind],
          actions:
            kind === 'service' ? unique(entries.flatMap((e) => e.intentFilters.flatMap((f) => f.actions))) : undefined,
          uris: kind === 'provider' ? unique(entries.flatMap((e) => e.authorities ?? [])) : undefined,
        });
      }
      if (emissions.length === 0) continue;

      const handlerId = LIFECYCLE[kind].map((name) => index.findMethod(decl, name)).find((id): id is string => !!id);
      if (!handlerId) {
        // One class, one count: a handler is never fabricated (§Entrypoints).
        entrypointsWithoutHandler++;
        continue;
      }

      for (const emission of emissions) {
        const className = decl.simpleName;
        const id = idGen.entrypointId('mobile', `${emission.trigger}:${className}`, decl.filePath);
        if (seen.has(id)) continue;
        seen.add(id);
        const details: MobileEntrypointDetails = {
          type: 'mobile',
          platform: 'android',
          trigger: emission.trigger,
          className,
          ...(emission.actions ? { actions: emission.actions } : {}),
          ...(emission.uris ? { uriPatterns: emission.uris } : {}),
          ...(exported === undefined ? {} : { exported }),
        };
        entrypoints.push({
          id,
          versionedId: idGen.versionedId(id, `${emission.trigger}:${decl.fqcn}`),
          type: 'mobile',
          handlerId,
          location: decl.location,
          details,
        });
      }
    }
  }

  return { entrypoints, entrypointsWithoutHandler };
}
