import type { ExtractionProfile } from '@coredoc/profile-parser';

/**
 * ARCHETYPE — Koa + Sequelize + pub-sub jobs, plain (untyped) CommonJS.
 *
 * Copy-ready base profile distilled from the fleet's legacy Koa services: a Koa router
 * wrapper, `sequelize.define` factory models, require/alias `handlers` registries, and
 * pub-sub job registrations. Copy it to `coredoc-parsers/<projectId>/<repoName>/profile.ts`
 * (the import above resolves from there), set `parserId` + `substrate.include` + the
 * registry `inFile` paths, then have scouts confirm the deltas.
 */
const profile: ExtractionProfile = {
  parserId: '<projectId>-<repoName>-koa-sequelize-v1', // placeholder
  repoType: 'backend',
  substrate: {
    language: 'js',
    // Plain CommonJS: without untypedJsMode the type checker crashes on untyped JS.
    untypedJsMode: true,
    include: ['app/**/*.js', 'index.js'], // placeholder — the repo's source roots
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.test.js', '**/*.spec.js', 'test/**', 'spec/**'],
  },
  // `module.exports = { m: () => {} }` handler files need synthesized FunctionNodes,
  // or entrypoint handlers resolve to nothing citable.
  synthesize: { objectLiteralExportMethods: true, inPaths: ['app/handlers/'] },
  di: { style: 'none' },
  // Inline `router.get('/x', (ctx) => …)` callbacks must be promoted to function nodes,
  // or calls inside them are dropped at module scope.
  callGraph: { resolveAnonCallbacks: true },
  handlerTables: [
    // Handlers are referenced through require/alias registries (`handlers.api.x.create`),
    // not co-located — without these tables every entrypoint handler dangles.
    { name: 'koa-handlers', registryVar: 'handlers', inFile: 'app/initializers/create-koa-router.js', leaf: 'require', reference: 'member-chain', nested: true },
    // Pub-sub aliases carry no trailing method segment → defaultMethod names the handler.
    { name: 'pubsub-handlers', registryVar: 'handlers', inFile: 'app/initializers/create-pub-sub-jobs.js', leaf: 'require', reference: 'member-chain', defaultMethod: 'onMessage' },
  ],
  entrypoints: [
    {
      kind: 'http',
      // Routes live inside `router.extend(basePath, (router) => …)` — scopedBy reads the
      // base path from the parent call; without it every route loses its prefix.
      detect: { via: 'call-shape', callee: 'router.*', scopedBy: { callee: 'router.extend', basePathArg: 0 } },
      method: 'from-callee',
      methodPath: { arg: 0, as: 'string-literal' },
      paramSyntax: 'colon',
      handler: { via: 'handler-table', table: 'koa-handlers', arg: -1 },
    },
    {
      // A REAL queue surface (pub-sub job registrations) — declared precisely so the scorer's
      // queue denominator is the registration-call count, not the coarse pre-scan grep.
      kind: 'queue',
      detect: { via: 'call-shape', callee: 'initHandler' },
      system: 'gcp-pubsub',
      // Topic is a const (`initHandler(JOB_NAME, …)`) → const-string resolves its value.
      topic: { arg: 0, as: 'const-string' },
      handler: { via: 'handler-table', table: 'pubsub-handlers', arg: 1 },
    },
  ],
  entities: [
    {
      orm: 'sequelize',
      detect: { via: 'call-shape', callee: 'sequelize.define' },
      name: { arg: 0, as: 'string-literal' },
      tableName: { fallback: 'snake_case' },
      fields: {
        factoryFieldsArg: 1,
        dataTypeMap: {
          STRING: 'string', TEXT: 'string', CHAR: 'string', UUID: 'string', UUIDV4: 'string',
          INTEGER: 'number', BIGINT: 'number', FLOAT: 'number', DOUBLE: 'number', DECIMAL: 'number', REAL: 'number',
          BOOLEAN: 'boolean', DATE: 'Date', DATEONLY: 'Date', TIME: 'string',
          JSON: 'object', JSONB: 'object', ENUM: 'string', ARRAY: 'array', VIRTUAL: 'any', BLOB: 'string',
        },
      },
      relations: {
        assocMethods: { hasMany: 'one-to-many', belongsTo: 'many-to-one', hasOne: 'one-to-one', belongsToMany: 'many-to-many' },
        target: { arg: 0, as: 'identifier' },
      },
    },
  ],
  dbOperations: {
    opMap: {
      findAll: 'read', findOne: 'read', findByPk: 'read', findOrCreate: 'read', findAndCountAll: 'read', count: 'read', max: 'read', min: 'read', sum: 'read',
      create: 'create', bulkCreate: 'create', upsert: 'create',
      update: 'update', save: 'update', increment: 'update', decrement: 'update', set: 'update', restore: 'update',
      destroy: 'delete', truncate: 'delete',
    },
    // `models.User.<op>()` — the receiver names the entity inline.
    modelReceiverPattern: '(^|\\.)models\\.[A-Z]\\w+$',
  },
  externalCalls: [
    // Internal SDK egress (`apiClient.method()`) — set the real client receiver + package.
    { kind: 'sdk', receiverPattern: '/apiClient$/i', serviceName: '<internal-api>', sdkName: '<sdk-package>' },
    // Pub-sub producers.
    { kind: 'queue', receiverPattern: '/messageBus$/i', methods: ['publishEvent', 'publish'], topic: { arg: 0, as: 'string-literal' }, system: 'gcp-pubsub' },
  ],
};

export default profile;
