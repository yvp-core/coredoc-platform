/**
 * Android XML readers: `AndroidManifest.xml` and `res/navigation/*.xml`.
 *
 * A malformed file is SKIPPED with a warning and never throws — one broken resource must not
 * take the parse down, and fabricating a component from a half-read document would be worse
 * than emitting nothing.
 */
import { XMLParser, XMLValidator } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  // Namespaces are part of the attribute name here (`android:name` vs `app:destination`).
  removeNSPrefix: false,
  parseAttributeValue: false,
  trimValues: true,
});

// biome-ignore lint/suspicious/noExplicitAny: parsed XML is an untyped bag by construction
type XmlNode = any;

/** Every child under `key`, whether the parser produced one object or an array. */
function childList(node: XmlNode, key: string): XmlNode[] {
  const value = node?.[key];
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function attr(node: XmlNode, name: string): string | undefined {
  const value = node?.[`@${name}`];
  return typeof value === 'string' ? value : undefined;
}

/** `@+id/home` / `@id/home` → `home`; anything else is returned unchanged. */
export function stripResourceId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const m = /^@\+?(?:[\w.]+:)?id\/(.+)$/.exec(value);
  return m ? m[1] : value;
}

function parseXml(relPath: string, xml: string, onWarn?: (msg: string) => void): XmlNode | undefined {
  const valid = XMLValidator.validate(xml);
  if (valid !== true) {
    onWarn?.(`kotlin: skipping malformed XML ${relPath}: ${valid.err?.msg ?? 'invalid'}`);
    return undefined;
  }
  try {
    return parser.parse(xml);
  } catch (err) {
    onWarn?.(`kotlin: skipping unreadable XML ${relPath}: ${(err as Error).message}`);
    return undefined;
  }
}

export type ManifestComponentKind = 'activity' | 'service' | 'receiver' | 'provider';

export interface ManifestIntentFilter {
  actions: string[];
  categories: string[];
  /** `<data android:scheme=… android:host=… android:path*=…>` rendered as a URI pattern. */
  uriPatterns: string[];
}

export interface ManifestComponent {
  kind: ManifestComponentKind;
  /** `android:name` as written — absolute FQCN or a `.Relative` name. */
  name: string;
  exported?: boolean;
  intentFilters: ManifestIntentFilter[];
  /** `android:authorities` of a provider, split on `;`. */
  authorities?: string[];
}

export interface AndroidManifestFacts {
  filePath: string;
  /** The legacy `package` attribute, when present (the namespace usually lives in Gradle now). */
  packageName?: string;
  /** Whether the manifest declares an `<application>` — the marker of an app module. */
  hasApplication: boolean;
  components: ManifestComponent[];
}

const COMPONENT_TAGS: Record<string, ManifestComponentKind> = {
  activity: 'activity',
  'activity-alias': 'activity',
  service: 'service',
  receiver: 'receiver',
  provider: 'provider',
};

function readIntentFilters(node: XmlNode): ManifestIntentFilter[] {
  return childList(node, 'intent-filter').map((filter) => {
    const uriPatterns: string[] = [];
    for (const data of childList(filter, 'data')) {
      const scheme = attr(data, 'android:scheme');
      const host = attr(data, 'android:host');
      const path = attr(data, 'android:path') ?? attr(data, 'android:pathPrefix') ?? attr(data, 'android:pathPattern');
      if (!scheme && !host && !path) continue;
      uriPatterns.push(`${scheme ? `${scheme}://` : ''}${host ?? ''}${path ?? ''}`);
    }
    return {
      actions: childList(filter, 'action')
        .map((a) => attr(a, 'android:name'))
        .filter((a): a is string => !!a),
      categories: childList(filter, 'category')
        .map((c) => attr(c, 'android:name'))
        .filter((c): c is string => !!c),
      uriPatterns,
    };
  });
}

/** Read one `AndroidManifest.xml`. Returns undefined for a malformed or non-manifest file. */
export function readManifest(
  relPath: string,
  xml: string,
  onWarn?: (msg: string) => void,
): AndroidManifestFacts | undefined {
  const doc = parseXml(relPath, xml, onWarn);
  const manifest = doc?.manifest;
  if (!manifest) return undefined;
  const application = childList(manifest, 'application')[0];
  const components: ManifestComponent[] = [];
  for (const [tag, kind] of Object.entries(COMPONENT_TAGS)) {
    for (const node of childList(application, tag)) {
      const name = attr(node, 'android:targetActivity') ?? attr(node, 'android:name');
      if (!name) continue;
      const exported = attr(node, 'android:exported');
      const authorities = attr(node, 'android:authorities');
      components.push({
        kind,
        name,
        exported: exported === undefined ? undefined : exported === 'true',
        intentFilters: readIntentFilters(node),
        authorities: authorities ? authorities.split(';').filter(Boolean) : undefined,
      });
    }
  }
  return {
    filePath: relPath,
    packageName: attr(manifest, 'package'),
    hasApplication: application !== undefined,
    components,
  };
}

export interface NavAction {
  id: string;
  /** Destination id, `@id/` stripped. */
  destination: string;
}

export interface NavDestination {
  /** `android:id` with `@+id/` stripped — the route path. */
  id: string;
  /** The XML tag: `fragment`, `activity`, `dialog` or `navigation`. */
  kind: string;
  /** `android:name`, the destination class, as written. */
  componentName?: string;
  /** The enclosing `<navigation>` id for a nested graph. */
  parentId?: string;
  startDestination?: string;
  actions: NavAction[];
}

export interface NavGraphFacts {
  filePath: string;
  /** The root graph's `app:startDestination`, `@id/` stripped. */
  startDestination?: string;
  /** Every destination, including nested `<navigation>` graphs, in document order. */
  destinations: NavDestination[];
}

const DESTINATION_TAGS = ['fragment', 'activity', 'dialog', 'navigation'];

/**
 * Nesting budget for `<navigation>` subgraphs. Kept local rather than shared with the CST
 * traversal budgets: this walks a parsed XML document, not a tree-sitter tree.
 */
const MAX_NAV_NESTING = 32;

/** Read one `res/navigation/*.xml`. Returns undefined for a malformed or non-navigation file. */
export function readNavigationGraph(
  relPath: string,
  xml: string,
  onWarn?: (msg: string) => void,
): NavGraphFacts | undefined {
  const doc = parseXml(relPath, xml, onWarn);
  const root = doc?.navigation;
  if (!root) return undefined;
  const destinations: NavDestination[] = [];

  const readActions = (node: XmlNode): NavAction[] =>
    childList(node, 'action')
      .map((a) => ({
        id: stripResourceId(attr(a, 'android:id')) ?? '',
        destination: stripResourceId(attr(a, 'app:destination')) ?? '',
      }))
      .filter((a) => a.id !== '' || a.destination !== '');

  const visit = (node: XmlNode, parentId: string | undefined, depth: number) => {
    if (depth > MAX_NAV_NESTING) return;
    for (const tag of DESTINATION_TAGS) {
      for (const child of childList(node, tag)) {
        const id = stripResourceId(attr(child, 'android:id'));
        if (!id) continue;
        destinations.push({
          id,
          kind: tag,
          componentName: attr(child, 'android:name'),
          parentId,
          startDestination: stripResourceId(attr(child, 'app:startDestination')),
          actions: readActions(child),
        });
        if (tag === 'navigation') visit(child, id, depth + 1);
      }
    }
  };
  visit(root, undefined, 0);

  return {
    filePath: relPath,
    startDestination: stripResourceId(attr(root, 'app:startDestination')),
    destinations,
  };
}
