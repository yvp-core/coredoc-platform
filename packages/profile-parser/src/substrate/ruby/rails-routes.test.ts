import { describe, expect, it } from 'vitest';
import { extractRailsRoutes } from './rails-routes.js';

/**
 * Rails routing-DSL extraction (config/routes.rb) — generic Rails, not Grape.
 * `resources` → 7 RESTful routes, `resource` → singular set (no :id), verb calls
 * (`get`/`post`/…) → that verb+path, `namespace`/`scope` → ancestor path prefixes.
 * `root`/`mount`/redirects are ignored.
 */
describe('extractRailsRoutes', () => {
  const sig = (rs: Array<{ method: string; path: string }>) => rs.map((r) => `${r.method} ${r.path}`).sort();

  it('expands `resources :photos` into the 7 RESTful routes', async () => {
    const src = `
Rails.application.routes.draw do
  resources :photos
end
`;
    const s = sig(await extractRailsRoutes(src));
    expect(s).toContain('GET /photos');
    expect(s).toContain('POST /photos');
    expect(s).toContain('GET /photos/new');
    expect(s).toContain('GET /photos/:id');
    expect(s).toContain('GET /photos/:id/edit');
    expect(s).toContain('PATCH /photos/:id');
    expect(s).toContain('PUT /photos/:id');
    expect(s).toContain('DELETE /photos/:id');
  });

  it('expands singular `resource :profile` into the no-:id set', async () => {
    const s = sig(await extractRailsRoutes('resource :profile\n'));
    expect(s).toContain('GET /profile');
    expect(s).toContain('POST /profile');
    expect(s).toContain('PATCH /profile');
    expect(s).toContain('PUT /profile');
    expect(s).toContain('DELETE /profile');
    expect(s).not.toContain('GET /profile/:id');
  });

  it('extracts plain verb calls with their path', async () => {
    const src = `
get 'health'
post 'foo/bar'
put 'widgets/:id'
patch 'widgets/:id'
delete 'widgets/:id'
`;
    const s = sig(await extractRailsRoutes(src));
    expect(s).toContain('GET /health');
    expect(s).toContain('POST /foo/bar');
    expect(s).toContain('PUT /widgets/:id');
    expect(s).toContain('PATCH /widgets/:id');
    expect(s).toContain('DELETE /widgets/:id');
  });

  it('prefixes nested routes under `namespace :admin`', async () => {
    const src = `
namespace :admin do
  resources :users
  get 'dashboard'
end
`;
    const s = sig(await extractRailsRoutes(src));
    expect(s).toContain('GET /admin/users');
    expect(s).toContain('POST /admin/users');
    expect(s).toContain('GET /admin/users/:id');
    expect(s).toContain('GET /admin/dashboard');
  });

  it('prefixes nested routes under `scope :v1` and `scope path:`', async () => {
    const sympath = `
scope :v1 do
  get 'ping'
end
`;
    const hashpath = `
scope path: 'v2' do
  get 'ping'
end
`;
    expect(sig(await extractRailsRoutes(sympath))).toContain('GET /v1/ping');
    expect(sig(await extractRailsRoutes(hashpath))).toContain('GET /v2/ping');
  });

  it('nests resources within resources', async () => {
    const src = `
resources :photos do
  resources :comments
end
`;
    const s = sig(await extractRailsRoutes(src));
    expect(s).toContain('GET /photos');
    expect(s).toContain('GET /photos/:photo_id/comments');
    expect(s).toContain('GET /photos/:photo_id/comments/:id');
    expect(s).toContain('DELETE /photos/:photo_id/comments/:id');
  });

  it('honors `only:` to restrict a resource set', async () => {
    const src = `
resources :photos, only: [:index, :show]
`;
    const s = sig(await extractRailsRoutes(src));
    expect(s).toContain('GET /photos');
    expect(s).toContain('GET /photos/:id');
    expect(s).not.toContain('POST /photos');
    expect(s).not.toContain('DELETE /photos/:id');
  });

  it('ignores root, mount, and redirects', async () => {
    const src = `
Rails.application.routes.draw do
  root 'home#index'
  mount GrapeApi => '/api'
  get 'old', to: redirect('/new')
  get 'keep'
end
`;
    const s = sig(await extractRailsRoutes(src));
    expect(s).toContain('GET /keep');
    expect(s.some((x) => x.includes('/api'))).toBe(false);
    expect(s.some((x) => x.includes('home'))).toBe(false);
  });

  it('handles the combined namespace + resources + verb case from the spec', async () => {
    const src = `
namespace :api do
  resources :users
  get 'health'
end
`;
    const s = sig(await extractRailsRoutes(src));
    expect(s).toContain('GET /api/users');
    expect(s).toContain('POST /api/users');
    expect(s).toContain('GET /api/users/:id');
    expect(s).toContain('DELETE /api/users/:id');
    expect(s).toContain('GET /api/health');
  });

  it('extracts a single POST from `resource :session`', async () => {
    const s = sig(await extractRailsRoutes('resource :session\n'));
    expect(s).toContain('POST /session');
  });

  it('returns [] for a routes file with no extractable routes', async () => {
    expect(await extractRailsRoutes('Rails.application.routes.draw do\n  root "home#index"\nend\n')).toEqual([]);
  });
});

describe('extractRailsRoutes — path: option overrides the namespace name (Rails URL prefix)', () => {
  it('uses the path: value, not the positional name, for the URL segment', async () => {
    const src = `
namespace 'api', module: 'management_api', as: 'management_api', path: 'api/management' do
  resources :user_profiles, only: [:index, :show]
  get 'company'
end
`;
    const routes = await extractRailsRoutes(src);
    const sig = routes.map((r) => `${r.method} ${r.path}`).sort();
    expect(sig).toContain('GET /api/management/user_profiles');
    expect(sig).toContain('GET /api/management/user_profiles/:id');
    expect(sig).toContain('GET /api/management/company');
    // The positional name 'api' must NOT be used when path: is present.
    expect(sig).not.toContain('GET /api/user_profiles');
  });
});

describe('extractRailsRoutes — member/collection routes', () => {
  const sig = (rs: Array<{ method: string; path: string }>) => rs.map((r) => `${r.method} ${r.path}`).sort();

  it('expands `member do` block routes under /:id (symbol and string actions)', async () => {
    const src = `
resources :photos do
  member do
    patch 'approve'
    get :preview
  end
end
`;
    const s = sig(await extractRailsRoutes(src));
    expect(s).toContain('PATCH /photos/:id/approve');
    expect(s).toContain('GET /photos/:id/preview');
  });

  it('expands `collection do` block routes with NO :id segment (symbol and string actions)', async () => {
    const src = `
resources :photos do
  collection do
    get 'search'
    post :sync
  end
end
`;
    const s = sig(await extractRailsRoutes(src));
    expect(s).toContain('GET /photos/search');
    expect(s).toContain('POST /photos/sync');
    // A collection route must NOT carry the nested :id segment.
    expect(s).not.toContain('GET /photos/:id/search');
    expect(s).not.toContain('GET /photos/:photo_id/search');
  });

  it('handles inline `on: :member` / `on: :collection` options', async () => {
    const src = `
resources :devices do
  get :autocomplete, on: :collection
  get :status, on: :member
end
`;
    const s = sig(await extractRailsRoutes(src));
    expect(s).toContain('GET /devices/autocomplete'); // collection: no :id
    expect(s).toContain('GET /devices/:id/status'); // member: with :id
  });

  it('handles `on: :collection` with a to: option (action arg is the symbol, not the to: string)', async () => {
    const src = `
resources :legal_conditions, only: [] do
  get :privacy_policy, to: 'legal_conditions#privacy_policy', on: :collection
end
`;
    const s = sig(await extractRailsRoutes(src));
    expect(s).toContain('GET /legal_conditions/privacy_policy');
  });

  it('does NOT apply the resources only:/except: filter to member/collection routes', async () => {
    const src = `
resources :bookings, only: [:show] do
  collection do
    get 'reasons'
  end
  member do
    patch :approve
  end
end
`;
    const s = sig(await extractRailsRoutes(src));
    expect(s).toContain('GET /bookings/reasons');
    expect(s).toContain('PATCH /bookings/:id/approve');
    // The only: filter still restricts the RESTful set.
    expect(s).toContain('GET /bookings/:id'); // show kept
    expect(s).not.toContain('POST /bookings'); // create excluded
  });

  it('composes nested-resource collection/member routes with the parent prefix', async () => {
    const src = `
resources :user_profiles do
  resources :shift_compilations do
    collection do
      post 'batch_update'
    end
    member do
      get :events_log
    end
  end
end
`;
    const s = sig(await extractRailsRoutes(src));
    expect(s).toContain('POST /user_profiles/:user_profile_id/shift_compilations/batch_update');
    expect(s).toContain('GET /user_profiles/:user_profile_id/shift_compilations/:id/events_log');
  });

  it('still ignores a bare symbol verb with no member/collection/on context', async () => {
    // `get :orphan` outside any resources is not a valid route target — keep dropping it.
    expect(sig(await extractRailsRoutes('get :orphan\n'))).toEqual([]);
  });
});

describe('extractRailsRoutes — concern/concerns expansion', () => {
  it('emits concern routes under each including namespace, not bare', async () => {
    const src = `
concern :management_api do
  resources :user_profiles, only: [:index, :show]
  get 'company'
end
namespace 'api', module: 'management_api', path: 'api/management' do
  concerns :management_api
end
namespace 'v1', module: 'management_api', path: 'v1/management/rails' do
  concerns :management_api
end
`;
    const sig = (await extractRailsRoutes(src)).map((r) => `${r.method} ${r.path}`).sort();
    expect(sig).toContain('GET /api/management/user_profiles');
    expect(sig).toContain('GET /api/management/user_profiles/:id');
    expect(sig).toContain('GET /api/management/company');
    expect(sig).toContain('GET /v1/management/rails/user_profiles');
    // Concern templates are NOT emitted bare (without the including namespace).
    expect(sig).not.toContain('GET /user_profiles');
    expect(sig).not.toContain('GET /company');
  });
});
