import { describe, expect, it } from 'vitest';
import { extractGrapeRoutes } from './grape-routes.js';

/**
 * Grape route extraction (P4.1b). Assembles each endpoint's path from the CST block
 * nesting: `resource`/`resources`/`namespace`/`segment`/`group` (→ literal segment),
 * `route_param` (→ `:param`), then the verb's own string-literal path arg. Bare
 * `namespace do` / `get do` contribute no segment. Paths here are RELATIVE to the
 * Grape class (the cross-file root-mount prefix is applied separately).
 */
describe('extractGrapeRoutes', () => {
  it('assembles paths from resource + namespace + route_param + verb arg (real companies.rb shape)', async () => {
    const src = `
module Mobile
  module V1
    class Companies < ::Mobile::V1::Base
      resource :companies do
        namespace do
          get 'industry_types' do
          end
          route_param :id do
            get do
            end
            post 'household' do
            end
          end
        end
      end
    end
  end
end
`;
    const routes = await extractGrapeRoutes(src);
    const sig = routes.map((r) => `${r.method} ${r.path}`).sort();
    expect(sig).toContain('GET /companies/industry_types');
    expect(sig).toContain('GET /companies/:id');
    expect(sig).toContain('POST /companies/:id/household');
  });

  it('handles a leading-slash verb path and a bare resource get', async () => {
    const src = `
class Sessions < Base
  resource :sessions do
    get '/:id' do
    end
    post do
    end
  end
end
`;
    const routes = await extractGrapeRoutes(src);
    const sig = routes.map((r) => `${r.method} ${r.path}`).sort();
    expect(sig).toContain('GET /sessions/:id');
    expect(sig).toContain('POST /sessions');
  });

  it('uses only the positional path arg — ignores option-hash/array strings and desc text', async () => {
    // Real shape: `post http_codes: [...]` (no positional path) and
    // `post 'household', http_codes: [...]` (positional path 'household'). A string
    // buried in the options hash/array must NOT become the path.
    const src = `
class Companies < Base
  resource :companies do
    post http_codes: [{ code: 201, message: 'Company is created' }] do
    end
    post 'household', http_codes: [{ code: 200 }] do
    end
  end
end
`;
    const routes = await extractGrapeRoutes(src);
    const sig = routes.map((r) => `${r.method} ${r.path}`).sort();
    expect(sig).toContain('POST /companies'); // no positional path → resource path
    expect(sig).toContain('POST /companies/household');
    expect(sig).not.toContain('POST /companies/Company is created');
  });

  it('returns [] for a file with no Grape routes', async () => {
    expect(await extractGrapeRoutes('class Foo\n  def bar; 1; end\nend\n')).toEqual([]);
  });
});
