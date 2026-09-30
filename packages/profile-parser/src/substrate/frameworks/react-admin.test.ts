import { TreeSitterLoader } from '../../tree-sitter/tree-sitter-loader.js';
import { describe, expect, it } from 'vitest';
import { reactAdminRouteSites } from './react-admin.js';

async function parse(src: string) {
  const parser = await TreeSitterLoader.getInstance().getParser('tsx');
  return parser.parse(src).rootNode;
}

describe('reactAdminRouteSites', () => {
  it('emits a route per present CRUD prop, in list/create/edit/show order', async () => {
    const root = await parse(`
      const App = () => (
        <Admin>
          <Resource name="companies" icon={BusinessIcon} list={CompanyList} show={CompanyShow} edit={CompanyEdit} create={CompanyCreate} />
        </Admin>
      );
    `);
    const sites = reactAdminRouteSites(root, 'App.tsx');
    expect(sites.map((s) => [s.path, s.componentName])).toEqual([
      ['/companies', 'CompanyList'],
      ['/companies/create', 'CompanyCreate'],
      ['/companies/:id', 'CompanyEdit'],
      ['/companies/:id/show', 'CompanyShow'],
    ]);
    expect(sites.every((s) => s.file === 'App.tsx')).toBe(true);
  });

  it('emits only the present CRUD props for a partial resource', async () => {
    const root = await parse('<Resource name="vacation-templates" create={VacationCreate} edit={VacationEdit} />');
    const sites = reactAdminRouteSites(root, 'a.tsx');
    expect(sites.map((s) => s.path)).toEqual(['/vacation-templates/create', '/vacation-templates/:id']);
  });

  it('ignores a <Resource> with no CRUD component props (menu-only registration)', async () => {
    const root = await parse('<Resource name="intent-only" icon={X} />');
    expect(reactAdminRouteSites(root, 'a.tsx')).toEqual([]);
  });

  it('ignores non-Resource JSX elements', async () => {
    const root = await parse('<Route path="/x" element={<Y />} />');
    expect(reactAdminRouteSites(root, 'a.tsx')).toEqual([]);
  });
});
