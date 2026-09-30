import type { ExtractionProfile } from '@coredoc/profile-parser';

/**
 * ARCHETYPE — react-admin SPA (React + react-admin, CRA-style layout, TS).
 *
 * Copy-ready base profile distilled from the fleet's react-admin console. Copy it to
 * `coredoc-parsers/<projectId>/<repoName>/profile.ts` (the import above resolves from
 * there), set `parserId` + `substrate.include` + the egress wrapper/serviceName, then
 * have scouts confirm the deltas.
 *
 * NO queue rule here — deliberately. `repoType: 'frontend'` makes the scorer mark queue
 * not_applicable; the coarse pre-scan grep can still "hit" queue-ish strings in data files
 * (a mock once matched `Consumer` inside 'Omni Consumer Products'). Do not fabricate a
 * queue rule on a frontend just to silence pre-scan noise.
 */
const profile: ExtractionProfile = {
  parserId: '<projectId>-<repoName>-react-admin-v1', // placeholder
  repoType: 'frontend', // also the queue guard: frontend + no queue rule → queue not_applicable
  substrate: {
    language: 'ts',
    include: ['src/**/*.tsx', 'src/**/*.ts', 'src/**/*.jsx', 'src/**/*.js'], // placeholder
    exclude: ['**/*.test.tsx', '**/*.test.ts', '**/*.spec.tsx', '**/*.spec.ts', '**/*.d.ts', '**/node_modules/**', '**/build/**'],
  },
  components: {
    framework: 'react',
    functional: true,
    classComponents: true,
    functionalInExtensions: ['.tsx', '.jsx'], // JSX lives in tsx/jsx — skips false hits in plain .ts
    childComponents: 'jsx-walk',
    idResolution: 'import+tsconfig',
    // CRA default: relative imports only → confine resolution to src/. Add `aliases`/`baseUrl`
    // when the repo's tsconfig declares them.
    imports: { confineTo: 'src/' },
    hocWrappers: ['withTranslation', 'withRouter', 'connect', 'memo', 'forwardRef', 'observer'],
    childDedup: 'per-id',
  },
  routes: {
    // react-admin generates routes from `<Admin><Resource name=… list/show/edit/create={C}/>`
    // — the repo declares NO react-router `<Route>` elements, so componentProp/renderProp/
    // configArray all find nothing; without this flag the routes category emits 0.
    reactAdminResources: true,
  },
  externalCalls: [
    // The repo's fetch wrapper (the react-admin dataProvider overrides call it) — set the real
    // wrapper name; the verb auto-reads from the `{ method }` 2nd-arg option (GET default).
    { kind: 'http', bareCallee: '<fetchWrapperName>', url: { arg: 0, as: 'string-literal' }, serviceName: '<backend-service>' },
    // Direct axios egress (auth flows, JWKS fetches, …).
    { kind: 'http', receiverPattern: '/(^|\\.)axios$/i', verbs: ['get', 'post', 'put', 'patch', 'delete'], url: { arg: 0, as: 'string-literal' }, serviceName: '<backend-service>' },
  ],
};

export default profile;
