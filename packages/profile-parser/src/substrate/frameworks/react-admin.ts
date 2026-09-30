/**
 * Framework-specific route extractors live here, kept OUT of the generic substrate so a rare,
 * client-library-specific convention never leaks into the core engine (DoD §2.2). The substrate
 * applies route-rule scoping and dispatches to these when a profile opts in via a `RouteRule`
 * flag; each module is a self-contained `(cstRoot, file) → RouteSite[]` function.
 *
 * react-admin generates CRUD routes from `<Resource name="x" list/show/edit/create={Component}/>`
 * rather than declaring react-router `<Route>` elements, so its routes are invisible to the
 * generic `<Route>`/config-array detectors.
 */
import type { Node as TsNode } from 'web-tree-sitter';
import type { RouteSite } from '../interface.js';
import { text, unquote } from '../scip/ts-text.js';

type CrudVerb = 'list' | 'create' | 'edit' | 'show';

const CRUD_VERBS: CrudVerb[] = ['list', 'create', 'edit', 'show'];

/** The route react-admin generates for a `<Resource name>` CRUD prop. */
function routePath(name: string, verb: CrudVerb): string {
  switch (verb) {
    case 'list':
      return `/${name}`;
    case 'create':
      return `/${name}/create`;
    case 'edit':
      return `/${name}/:id`;
    case 'show':
      return `/${name}/:id/show`;
  }
}

/** Read a JSX attribute whose value is a string literal (`name="x"` or `name={'x'}`). */
function readStringAttr(attr: TsNode): string | undefined {
  const str = attr.namedChildren.find((c) => c.type === 'string');
  if (str) return unquote(text(str));
  const expr = attr.namedChildren.find((c) => c.type === 'jsx_expression');
  const inner = expr?.namedChildren.find((c) => c.type === 'string');
  return inner ? unquote(text(inner)) : undefined;
}

/**
 * One `RouteSite` per present CRUD prop of each `<Resource>` in `root`. The component prop's
 * identifier line is captured so the engine resolves its componentId via the same SCIP/import
 * path `<Route>` props use. Reads the CST (not regex): the `name` string attr and the CRUD
 * props appear in any order on a single element, which a single regex can't reliably capture.
 */
export function reactAdminRouteSites(root: TsNode, file: string): RouteSite[] {
  const out: RouteSite[] = [];
  const seen = new Set<string>();
  const visit = (n: TsNode): void => {
    if (n.type === 'jsx_self_closing_element' || n.type === 'jsx_opening_element') {
      const tagName = text(
        n.childForFieldName('name') ??
          n.namedChildren.find((c) => c.type === 'identifier' || c.type === 'member_expression'),
      );
      if (tagName === 'Resource') {
        let name: string | undefined;
        const propIdents = new Map<CrudVerb, TsNode>();
        for (const attr of n.namedChildren.filter((c) => c.type === 'jsx_attribute')) {
          const attrName = text(attr.namedChildren[0]);
          if (attrName === 'name') {
            name ??= readStringAttr(attr);
          } else if ((CRUD_VERBS as string[]).includes(attrName)) {
            const expr = attr.namedChildren.find((c) => c.type === 'jsx_expression');
            const ident = expr?.namedChildren.find((c) => c.type === 'identifier');
            if (ident && /^[A-Z]/.test(text(ident))) propIdents.set(attrName as CrudVerb, ident);
          }
        }
        if (name) {
          for (const verb of CRUD_VERBS) {
            const ident = propIdents.get(verb);
            if (!ident) continue;
            const path = routePath(name, verb);
            const componentName = text(ident);
            const key = `${path}::${componentName}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ path, componentName, componentLine: ident.startPosition.row + 1, file });
          }
        }
      }
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(root);
  return out;
}
