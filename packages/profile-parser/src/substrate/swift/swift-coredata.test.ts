import { describe, expect, it } from 'vitest';
import { StableIdGenerator } from '@coredoc/core';
import { type SwiftFile, indexSwiftDefs, resolveSwiftCalls } from './swift-callgraph.js';

import { extractSwiftDbOps } from './swift-dbops.js';
import { extractSwiftEgress } from './swift-egress.js';
import { extractSwiftEntities } from './swift-entities.js';
import { parseSource } from '../../tree-sitter/tree-sitter-loader.js';

async function mkFiles(entries: Array<[string, string]>): Promise<SwiftFile[]> {
  return Promise.all(
    entries.map(async ([relPath, source]) => ({ relPath, source, root: await parseSource('swift', source) })),
  );
}

const idGen = new StableIdGenerator('/repo', 'demo');

describe('swift Core Data entities', () => {
  it('reads @NSManaged fields and relations from the +CoreDataProperties extension', async () => {
    const files = await mkFiles([
      ['DB/PunchDB+CoreDataClass.swift', 'public class PunchDB: NSManagedObject {}'],
      [
        'DB/PunchDB+CoreDataProperties.swift',
        `extension PunchDB: Uploadable {
  @NSManaged public var uuid: UUID
  @NSManaged public var reason: String?
  @NSManaged public var attachment: AttachmentDB?
  static let idName = "uuid"
  var isLate: Bool { false }
}`,
      ],
      ['DB/AttachmentDB.swift', 'public class AttachmentDB: NSManagedObject {}'],
    ]);
    const { entities } = extractSwiftEntities(files, { idGen, baseClasses: ['NSManagedObject'], orm: 'coredata' });
    const punch = entities.find((e) => e.name === 'PunchDB');
    // A static or computed member of an extension is never a column.
    expect(punch?.fields.map((f) => f.name)).toEqual(['uuid', 'reason', 'attachment']);
    expect(punch?.fields.find((f) => f.name === 'reason')?.isNullable).toBe(true);
    expect(punch?.relations).toEqual([
      expect.objectContaining({ name: 'attachment', type: 'many-to-one', targetEntityName: 'AttachmentDB' }),
    ]);
  });
});

describe('swift db-op verb matching', () => {
  const MODEL = 'class TaskDB: NSManagedObject {}';

  it('keeps only verbs whose receiver matches receiverPattern', async () => {
    const files = await mkFiles([
      ['DB/TaskDB.swift', MODEL],
      [
        'Repo.swift',
        `class Repo {
  func load() {
    let all = try? context.fetch(request)
    try? container.context.save()
    try await TasksSync.fetch()
    image.save(to: url)
    names.filter { !$0.isEmpty }
  }
}`,
      ],
    ]);
    const { entityIdByName } = extractSwiftEntities(files, {
      idGen,
      baseClasses: ['NSManagedObject'],
      orm: 'coredata',
    });
    const { dbOperations } = extractSwiftDbOps(files, entityIdByName, idGen, {
      opMap: { fetch: 'read', save: 'update' },
      receiverPattern: '^(container\\.)?context$',
    });
    expect(dbOperations.map((o) => `${o.location.startLine}:${o.operation}`)).toEqual(['3:read', '4:update']);
  });

  it('never emits an op for a method named like an Object.prototype member', async () => {
    const files = await mkFiles([
      ['DB/TaskDB.swift', MODEL],
      ['Day.swift', 'class Day { func label() -> String { date.toString(.iso); return x.constructor() } }'],
    ]);
    const { entityIdByName } = extractSwiftEntities(files, {
      idGen,
      baseClasses: ['NSManagedObject'],
      orm: 'coredata',
    });
    const { dbOperations } = extractSwiftDbOps(files, entityIdByName, idGen);
    expect(dbOperations).toEqual([]);
  });
});

describe('swift egress — implicit members and concatenated paths', () => {
  const API = `protocol RequestTargetType: TargetType {}
enum Api: RequestTargetType {
  case authenticate(userProfileUuid: UUID), employees, updateTablet
  private var companyPath: String { return "companies/" + companyUuid + "/" }
  var path: String {
    switch self {
    case .authenticate(let userProfileUuid):
      return "structure/" + companyPath + "user_profiles/" + userProfileUuid.lowercased + "/authenticate"
    case .employees: return "structure/" + companyPath + "user_profiles"
    case .updateTablet: return "structure/tablets/" + (defaults.values?.tabletUuid.lowercased).orDefault
    }
  }
  var method: Moya.Method {
    switch self {
    case .authenticate: return .post
    case .employees: return .get
    case .updateTablet: return .put
    }
  }
}`;

  it('renders `+`-concatenated paths whose segments carry a member transform', async () => {
    const files = await mkFiles([
      ['Api.swift', API],
      [
        'Sync.swift',
        'class Sync { func run() { send(Api.authenticate(userProfileUuid: u)); send(Api.updateTablet) } }',
      ],
    ]);
    const edges = extractSwiftEgress(files, idGen, { targetTypeProtocols: ['RequestTargetType'] });
    expect(edges.map((e) => `${e.method} ${e.targetDescriptor.http?.pathTemplate}`)).toEqual([
      'POST /structure/companies/{companyUuid}/user_profiles/{userProfileUuid}/authenticate',
      'PUT /structure/tablets/{tabletUuid}',
    ]);
  });

  it('attributes an implicit `.case` argument to its API enum when the name is unambiguous', async () => {
    const files = await mkFiles([
      ['Api.swift', API],
      [
        'Sync.swift',
        `enum Tab { case employees }
class Sync {
  func login() { let p = Params<Api, H>(.authenticate(userProfileUuid: u)) }
  func list() { let p = Params<Api, H>(.employees) }
  func isAuth(_ a: Api) -> Bool { if case .authenticate = a { return true }; return false }
}`,
      ],
    ]);
    const edges = extractSwiftEgress(files, idGen, { targetTypeProtocols: ['RequestTargetType'] });
    // `.employees` is also a case of `Tab`, so it abstains; a `case .x` pattern is never a request.
    expect(
      edges.map((e) => `${e.callerId.split(':').pop()} ${e.method} ${e.targetDescriptor.http?.pathTemplate}`),
    ).toEqual(['Sync.login POST /structure/companies/{companyUuid}/user_profiles/{userProfileUuid}/authenticate']);
  });
});

describe('swift Tier-B call resolution', () => {
  const SRC = `protocol Repository { associatedtype DBObject }
extension Repository {
  func getModels(for factory: Int) -> [Int] { [] }
  func enqueueSet(_ status: Int, for ids: [Int]) {}
}
class PunchRepository: Repository { typealias DBObject = PunchDB }
class Container { func resolve<T>(_ t: T.Type) -> T? { nil } }
class Analytics {
  static let shared = Analytics()
  func handle(event: String) {}
}
protocol LoginRoutes { func loggedIn() }
class LoginCoordinator: LoginRoutes { func loggedIn() {} }
protocol Shared { func go() }
class A: Shared { func go() {} }
class B: Shared { func go() {} }
enum Sync { static func fetch() {} }
func notAwait(_ f: () -> Void) {}
extension UserDefaults { func set(_ v: Bool, for key: String) {} }
class Screen {
  let routes: LoginRoutes
  let shared: Shared
  let repo = PunchRepository()
  let container: Container
  let defaults: UserDefaults
  func run(other: PunchRepository) {
    refresh()
    self.refresh()
    Sync.fetch()
    Analytics.shared.handle(event: "x")
    repo.enqueueSet(1, for: [])
    other.getModels(for: 1)
    container.resolve(PunchRepository.self)!.getModels(for: 1)
    let found = container.resolve(PunchRepository.self)
    found?.getModels(for: 2)
    routes.loggedIn()
    shared.go()
    notAwait { }
    defaults.set(true, for: "k")
    defaults.set(true, forKey: "k")
  }
  func refresh() {}
}`;

  it('types receivers from declarations and walks protocol extensions; abstains when ambiguous', async () => {
    const files = await mkFiles([['app.swift', SRC]]);
    const index = indexSwiftDefs(files, idGen);
    const calls = resolveSwiftCalls(files, index, idGen);
    const got = calls.map((c) => `${c.location.startLine} ${c.provenance} ${c.calleeId?.split(':').pop()}`);
    expect(got).toEqual([
      '27 swift-member Screen.refresh',
      '28 swift-member Screen.refresh',
      '29 swift-static Sync.static.fetch',
      '30 swift-type Analytics.handle',
      '31 swift-type Repository.enqueueSet',
      '32 swift-type Repository.getModels',
      '33 swift-type Repository.getModels',
      '33 swift-type Container.resolve',
      '34 swift-type Container.resolve',
      '35 swift-type Repository.getModels',
      '36 iface-impl LoginCoordinator.loggedIn',
      '38 swift-local notAwait',
      '39 swift-type UserDefaults.set',
    ]);
    // Line 37: `Shared` has two implementations; line 40: `forKey:` fits no repo `set` overload.
  });
});
