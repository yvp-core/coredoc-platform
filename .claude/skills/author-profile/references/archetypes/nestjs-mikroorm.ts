import type { ExtractionProfile } from '@coredoc/profile-parser';

/**
 * ARCHETYPE — NestJS + MikroORM backend service (optionally Kafka).
 *
 * Copy-ready base profile distilled from the fleet's NestJS services. Copy it to
 * `coredoc-parsers/<projectId>/<repoName>/profile.ts` (the import above resolves from
 * there), set `parserId` + `substrate.include`, then have scouts CONFIRM the deltas
 * (base paths, queue topics, egress receivers) instead of rediscovering conventions.
 */
const profile: ExtractionProfile = {
  parserId: '<projectId>-<repoName>-nestjs-mikroorm-v1', // placeholder
  repoType: 'backend',
  // Uncomment when the entity set is generated schema-mirror output (@mikro-orm/entity-generator)
  // and only a subset is operated on: switches the scorer's dbOperations denominator to the
  // operated entities. Without it a schema-mirror repo FAILs dbOperations even at full op recall.
  // schemaMirror: true,
  substrate: {
    language: 'ts',
    include: ['src/**/*.ts'], // placeholder — the target package's source roots
    exclude: ['**/*.spec.ts', '**/*.test.ts', '**/dist/**', '**/*.d.ts', '**/migrations/**'],
  },
  di: { style: 'constructor-type', stripGenerics: true },
  entrypoints: [
    {
      kind: 'http',
      detect: { via: 'class-decorator', name: 'Controller' },
      basePath: { arg: 0, as: 'string-literal' },
      method: { Get: 'GET', Post: 'POST', Put: 'PUT', Patch: 'PATCH', Delete: 'DELETE', Options: 'OPTIONS', Head: 'HEAD', All: 'GET' },
      methodPath: { arg: 0, as: 'string-literal' },
      paramSyntax: 'colon',
    },
    {
      // KEEP this rule even when the service has no queues: a declared queue rule pins the
      // scorer's queue denominator to the precise decorator count (0 matches → not_applicable).
      // Without it a backend falls back to the coarse pre-scan grep, which over-counts RxJS
      // `subscribe`/`Consumer` hits and falsely marks queue required.
      kind: 'queue',
      detect: { via: 'method-decorator', names: { EventPattern: 'event', MessagePattern: 'request-response' } },
      system: 'kafka',
      // Topics passed through a wrapper call (`getTopicInNamespace(Topics.X)`) need
      // `as: 'wrapped-enum-member'` + `unwrapCalls` instead of `string-literal`.
      topic: { arg: 0, as: 'string-literal' },
    },
  ],
  entities: [
    {
      orm: 'mikro-orm',
      detect: { via: 'class-decorator', name: 'Entity' },
      tableName: { option: 'tableName', fallback: 'snake_case' },
      fields: {
        decorators: ['Property', 'PrimaryKey', 'Enum'],
        pk: 'PrimaryKey',
        columnNameOption: 'fieldName',
        flags: { nullable: 'nullable:\\s*true', unique: 'unique:\\s*true', generated: 'autoincrement|defaultRaw|onCreate' },
      },
      relations: {
        decorators: { OneToOne: 'one-to-one', ManyToOne: 'many-to-one', OneToMany: 'one-to-many', ManyToMany: 'many-to-many' },
        // Known gap: option-object targets (`@ManyToOne({ entity: () => X })`) are not readable
        // by arg-0 arrow-target — relations still detect, targets stay unresolved. Report, don't hack.
        target: { arg: 0, as: 'arrow-target' },
      },
    },
  ],
  dbOperations: {
    opMap: {
      find: 'read', findAll: 'read', findOne: 'read', findOneOrFail: 'read', findAndCount: 'read', count: 'read', createQueryBuilder: 'query',
      // `this.em.getRepository(Entity).<verb>()`: the entity resolves from arg 0, but the engine
      // drops the chained `.<verb>()` (call-expression receiver), so these ops are entity-accurate
      // with verb≈read. Without this entry the sites are missed entirely — approximate verb beats zero recall.
      getRepository: 'read',
      persist: 'create', persistAndFlush: 'create', create: 'create', insert: 'create', upsert: 'create',
      nativeUpdate: 'update', assign: 'update', flush: 'update',
      remove: 'delete', removeAndFlush: 'delete', nativeDelete: 'delete',
    },
    emReceivers: ['em', '*.em', '*.orm.em'],
    repoReceiverPattern: '/repository$|repo$/i',
    entityFrom: { arg: 0, as: 'identifier' },
    // Custom repos (`class FooRepository extends EntityRepository<Foo>`) bind `this.<op>()`
    // inside the class — and DI props typed as that class — to the captured entity.
    repoBaseClasses: ['EntityRepository', 'BaseRepository'],
  },
  externalCalls: [
    // Clients CONSTRUCTED as fields (`this.hcmApi = new HcmApi(url)`) never appear as
    // constructor-injected types, so `diTypeSuffix` misses them — a receiver pattern on the
    // field name is what captures `new XApi(...)` egress sites.
    { kind: 'sdk', receiverPattern: '/(Api|ApiClient)$/i', serviceName: 'internal-api' },
    { kind: 'http', receiverPattern: '/(^|\\.)axios$/i', verbs: ['get', 'post', 'put', 'patch', 'delete', 'request'], url: { arg: 0, as: 'string-literal' }, serviceName: 'axios' },
    // Kafka producers (`this.client.emit/send(topic, …)`) — drop when there is no queue dep.
    { kind: 'queue', receiverPattern: '/client$/i', methods: ['emit', 'send'], topic: { arg: 0, as: 'string-literal' }, system: 'kafka' },
  ],
};

export default profile;
