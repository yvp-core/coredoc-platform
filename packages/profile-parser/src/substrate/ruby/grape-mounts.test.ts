import { describe, expect, it } from 'vitest';
import { type GrapeEntrypoint, resolveGrapeEntrypoints } from './grape-mounts.js';

/**
 * Cross-file Grape MOUNT/PREFIX resolver (P4.1b). Grape route paths assemble across
 * files: a root API mounts sub-APIs (pathless internal mounts) which hold the routes,
 * and a root mount (`mount RootClass => "/prefix"`) supplies the leading prefix. The
 * resolver produces each route's FULL path = root prefix + the class's in-file relative
 * route. All snippets below are GENERIC Grape DSL — no client-specific names/prefixes.
 */
describe('resolveGrapeEntrypoints', () => {
  const sig = (eps: GrapeEntrypoint[]) => eps.map((e) => `${e.method} ${e.path}`).sort();

  it('assembles a full path across root mount → internal mount → route class', async () => {
    const rootFile = {
      relPath: 'config/routes.rb',
      source: `
mount Mobile::API => "/api/mobile"
mount Foo::API => "/api/foo"
`,
    };
    const apiFile = {
      relPath: 'app/api/mobile/api.rb',
      source: `
module Mobile
  class API < Grape::API
    mount Companies
  end
end
`,
    };
    const companiesFile = {
      relPath: 'app/api/mobile/companies.rb',
      source: `
class Companies < Grape::API
  resource :companies do
    get '/:id' do
    end
  end
end
`,
    };
    const fooFile = {
      relPath: 'app/api/foo/api.rb',
      source: `
module Foo
  class API < Grape::API
    mount Widgets
  end
end
`,
    };
    const widgetsFile = {
      relPath: 'app/api/foo/widgets.rb',
      source: `
class Widgets < Grape::API
  resource :widgets do
    get do
    end
  end
end
`,
    };

    const eps = await resolveGrapeEntrypoints([rootFile, apiFile, companiesFile, fooFile, widgetsFile]);
    const s = sig(eps);
    // pathless internal mount adds no segment; root prefix + relative route compose.
    expect(s).toContain('GET /api/mobile/companies/:id');
    expect(s).toContain('GET /api/foo/widgets');
  });

  it('resolves module-nested FQNs and suffix-matched mount targets', async () => {
    const files = [
      {
        relPath: 'routes.rb',
        source: `mount Mobile::API => "/api/mobile"`,
      },
      {
        relPath: 'api.rb',
        source: `
module Mobile
  class API < Grape::API
    mount WithUser::Companies
  end
end
`,
      },
      {
        relPath: 'companies.rb',
        source: `
module Mobile
  module WithUser
    class Companies < Grape::API
      resource :companies do
        get '/:id' do
        end
      end
    end
  end
end
`,
      },
    ];
    const eps = await resolveGrapeEntrypoints(files);
    // 'WithUser::Companies' suffix-matches the FQN 'Mobile::WithUser::Companies'.
    expect(sig(eps)).toContain('GET /api/mobile/companies/:id');
  });

  it('carries the line + file of the route definition, not the mount', async () => {
    const files = [
      { relPath: 'routes.rb', source: `mount API => "/api"` },
      {
        relPath: 'sub.rb',
        source: `
class API < Grape::API
  mount Things
end
`,
      },
      {
        relPath: 'things.rb',
        source: `class Things < Grape::API
  resource :things do
    get do
    end
  end
end
`,
      },
    ];
    const eps = await resolveGrapeEntrypoints(files);
    const ep = eps.find((e) => e.path === '/api/things');
    expect(ep).toBeDefined();
    expect(ep?.file).toBe('things.rb');
    // `get do` is on line 3 of things.rb (1-based).
    expect(ep?.line).toBe(3);
  });

  it('falls back to the relative path for a class never reached by any mount', async () => {
    const files = [
      {
        relPath: 'orphan.rb',
        source: `
class Orphan < Grape::API
  resource :orphans do
    get '/:id' do
    end
  end
end
`,
      },
    ];
    const eps = await resolveGrapeEntrypoints(files);
    // No mount reaches Orphan → best-effort relative path, nothing lost.
    expect(sig(eps)).toContain('GET /orphans/:id');
  });

  it('emits an unmounted class once even when another class IS mounted', async () => {
    const files = [
      { relPath: 'routes.rb', source: `mount API => "/api"` },
      {
        relPath: 'api.rb',
        source: `
class API < Grape::API
  mount Mounted
end
`,
      },
      {
        relPath: 'mounted.rb',
        source: `class Mounted < Grape::API
  resource :mounted do
    get do
    end
  end
end
`,
      },
      {
        relPath: 'orphan.rb',
        source: `class Orphan < Grape::API
  resource :orphans do
    post do
    end
  end
end
`,
      },
    ];
    const eps = await resolveGrapeEntrypoints(files);
    const s = sig(eps);
    expect(s).toContain('GET /api/mounted');
    expect(s).toContain('POST /orphans'); // unmounted, no prefix
    // Each route emitted exactly once.
    expect(s.filter((x) => x === 'POST /orphans')).toHaveLength(1);
    expect(s.filter((x) => x === 'GET /api/mounted')).toHaveLength(1);
  });

  it('handles a chain of internal pathless mounts (root → mid → leaf)', async () => {
    const files = [
      { relPath: 'routes.rb', source: `mount Root => "/base"` },
      {
        relPath: 'root.rb',
        source: `class Root < Grape::API
  mount Mid
end`,
      },
      {
        relPath: 'mid.rb',
        source: `class Mid < Grape::API
  mount Leaf
end`,
      },
      {
        relPath: 'leaf.rb',
        source: `class Leaf < Grape::API
  resource :leaf do
    get '/:id' do
    end
  end
end`,
      },
    ];
    const eps = await resolveGrapeEntrypoints(files);
    expect(sig(eps)).toContain('GET /base/leaf/:id');
  });

  it('ignores a mount-with-string-path as an INTERNAL pathless mount (it is a prefix mount, not a chain edge)', async () => {
    // `mount X => "/p"` is a root/prefix mount, never a pathless internal mount.
    const files = [
      {
        relPath: 'api.rb',
        source: `class API < Grape::API
  mount Sub => "/extra"
end`,
      },
      {
        relPath: 'sub.rb',
        source: `class Sub < Grape::API
  resource :sub do
    get do
    end
  end
end`,
      },
    ];
    const eps = await resolveGrapeEntrypoints(files);
    // API is unmounted (no root mount points at it) → its own routes (none) ignored.
    // Sub IS root-mounted at "/extra" → GET /extra/sub.
    expect(sig(eps)).toContain('GET /extra/sub');
  });

  it('returns [] when there are no Grape classes', async () => {
    const eps = await resolveGrapeEntrypoints([{ relPath: 'plain.rb', source: 'class Foo\n  def bar; 1; end\nend\n' }]);
    expect(eps).toEqual([]);
  });
});
