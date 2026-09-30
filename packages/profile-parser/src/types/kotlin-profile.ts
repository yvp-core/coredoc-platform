// =============================================================================
// KotlinProfile — declarative per-repo config for the Kotlin/Android substrate.
//
// A NEW type (not ExtractionProfile, whose primitives are TS-AST-shaped). The
// framework conventions (Room/Realm persistence, Retrofit egress, Koin DI, the
// AndroidX component base classes) live in generic code under substrate/kotlin/;
// this profile only TUNES them per repo (globs, ORM base classes, the Realm verb
// map, extra framework bases). Every default below names a framework identifier
// only — AndroidX/Jetpack, Room, Realm, Retrofit, Koin. No client-specific string
// belongs in shared code; it belongs in that repo's own profile.ts. The
// `'kotlin'` literal is the registry dispatch discriminant.
// =============================================================================
import type { RepoType } from '@coredoc/core/types';
import type { BaseProfile } from './profile-base.js';

export interface KotlinProfile extends BaseProfile {
  parserId: string;
  substrate: { language: 'kotlin'; include: string[]; exclude?: string[] };
  /** Surfaces as ParsedRepo.type. Default 'mobile'. */
  repoType?: RepoType;
  /** Omit → no entities and no db operations (the Swift rule). */
  entities?: {
    /** ORM label surfaced on EntityNode.ormType, e.g. 'room' or 'realm'. */
    orm: 'room' | 'realm' | string;
    /** Realm: base classes marking a persisted class. Default ['RealmObject', 'RealmModel']. */
    baseClasses?: string[];
    /** Room: annotation simple names marking an entity. Default ['Entity']. */
    annotations?: string[];
  };
  /**
   * Realm verb → DbOperationType overrides, EXTENDING the defaults (never replacing them:
   * a profile must not be able to switch a default off and silently shrink the lane). An
   * entry may name an extension function whose receiver is the entity
   * (`{ save: 'create', query: 'query' }`), which is how third-party Realm extension
   * libraries are supported. Room operations are fixed by their DAO annotation and ignore
   * this map.
   */
  dbOperations?: { opMap?: Record<string, string> };
  /**
   * Retrofit egress. `verbAnnotations` replaces the default verb set
   * ['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS','HTTP'] when given — the set is
   * the vocabulary of one HTTP client library, not a safety floor.
   */
  egress?: { verbAnnotations?: string[] };
  /**
   * Dependency injection. Koin accessors yield an instance of their type argument or of the
   * property's declared type, which is what makes `by inject()` / `get<T>()` receivers
   * resolvable. Default ['get', 'inject', 'viewModel', 'activityViewModel', 'sharedViewModel'].
   */
  di?: { koin?: { accessors?: string[] } };
  /**
   * Framework base-class names, EXTENDING the built-in defaults (never replacing them), for
   * repos that funnel their components through their own abstract bases. The defaults are
   * listed per field.
   */
  android?: {
    /** + Activity, AppCompatActivity, ComponentActivity, FragmentActivity */
    activityBases?: string[];
    /** + Fragment, DialogFragment, BottomSheetDialogFragment */
    fragmentBases?: string[];
    /** + BroadcastReceiver */
    receiverBases?: string[];
    /** + Worker, CoroutineWorker, ListenableWorker, RxWorker */
    workerBases?: string[];
    /** + Service, IntentService, JobIntentService, JobService */
    serviceBases?: string[];
    /** + FirebaseMessagingService */
    pushServiceBases?: string[];
    /** + ContentProvider */
    providerBases?: string[];
  };
}
