import { describe, expect, it } from 'vitest';
import { StableIdGenerator } from '@coredoc/core';
import { type SwiftFile, parseDiContainer } from './swift-callgraph.js';

import { extractSwiftEgress } from './swift-egress.js';
import { parseSource } from '../../tree-sitter/tree-sitter-loader.js';

async function mkFiles(entries: Array<[string, string]>): Promise<SwiftFile[]> {
  return Promise.all(
    entries.map(async ([relPath, source]) => ({ relPath, source, root: await parseSource('swift', source) })),
  );
}

const API = `enum RailsApi: TargetType {
  case getProfiles
  case updateBooking(id: Int)
  case listCheckins
  var path: String {
    switch self {
    case .getProfiles: return "/profiles"
    case .updateBooking(let id): return "/bookings/\\(id)"
    case .listCheckins: return "/checkins"
    }
  }
  var method: Moya.Method {
    switch self {
    case .getProfiles: return .get
    case .updateBooking: return .put
    case .listCheckins: return .get
    }
  }
}`;

/** [S5 Egress — the cross-repo win] Moya TargetType enum → ExternalCallEdge per call site. */
describe('[S5] swift egress (Moya TargetType)', () => {
  const idGen = new StableIdGenerator('/repo', 'demo');

  it('emits one edge per call site with serviceName="" and a resolved method + path template', async () => {
    const files = await mkFiles([
      ['Network/API/RailsApi.swift', API],
      [
        'Synchers/ProfileSync.swift',
        `class ProfileSync {
          func run() {
            let op = NetworkOperation(target: RailsApi.getProfiles, handler: h)
            let op2 = NetworkOperation(target: RailsApi.updateBooking(id: 5), handler: h)
          }
          func again() { let op = NetworkOperation(target: RailsApi.getProfiles, handler: h) }
        }`,
      ],
    ]);
    const edges = extractSwiftEgress(files, idGen, { targetTypeProtocols: ['TargetType'] });

    // Call-site granularity: 3 reference sites (getProfiles ×2 + updateBooking ×1), NOT 3 distinct endpoints.
    expect(edges).toHaveLength(3);
    for (const e of edges) {
      expect(e.serviceName).toBe(''); // load-bearing: linker recovers target from route prefix
      expect(e.targetDescriptor?.protocol).toBe('http');
    }

    const getProfiles = edges.filter((e) => e.targetDescriptor?.http?.pathTemplate === '/profiles');
    expect(getProfiles).toHaveLength(2); // two call sites of the same endpoint
    expect(getProfiles[0].method).toBe('GET');

    const update = edges.find((e) => e.method === 'PUT');
    expect(update?.targetDescriptor?.http?.pathTemplate).toBe('/bookings/{id}'); // interpolation → {id}
  });

  it('ignores enums that do not conform to a configured TargetType protocol', async () => {
    const files = await mkFiles([['x.swift', `enum Color { case red; case blue }`]]);
    expect(extractSwiftEgress(files, idGen, { targetTypeProtocols: ['TargetType'] })).toHaveLength(0);
  });

  it('caller is the enclosing function of the reference site', async () => {
    const files = await mkFiles([
      ['api.swift', API],
      ['use.swift', `class S { func doFetch() { call(RailsApi.listCheckins) } }`],
    ]);
    const edges = extractSwiftEgress(files, idGen, { targetTypeProtocols: ['TargetType'] });
    expect(edges).toHaveLength(1);
    expect(edges[0].callerId).toBe(idGen.methodId('use.swift', 'S', 'doFetch'));
  });
});

/**
 * Real-world shape: cases in `enum X { }`, conformance + `return switch` expression with bare
 * arms and `+`-concatenated path-prefix getters in a separate `extension X: RequestTargetType`.
 */
describe('[S5] split enum + extension, switch-expression, prefix concatenation', () => {
  const idGen = new StableIdGenerator('/repo', 'demo');

  it('aggregates enum+extension and resolves concatenated path-prefix getters', async () => {
    const files = await mkFiles([
      [
        'StandardPathed.swift',
        `extension StandardPathed {
          var companyPath: String { "companies/\\(NetworkConsts.companyUUID)/" }
          var profilePath: String { "user_profiles/\\(NetworkConsts.profileUUID)/" }
          var profileInCompanyPath: String { "\\(companyPath)\\(profilePath)" }
        }`,
      ],
      [
        'ClientAdminApi.swift',
        `enum ClientAdminApi {
          case getLocations
          case postSessions
          case getShifts
        }
        extension ClientAdminApi: RequestTargetType {
          var path: String {
            return switch self {
            case .getLocations: companyPath + "locations"
            case .postSessions: "sessions"
            case .getShifts: profileInCompanyPath + "shifts"
            }
          }
          var method: Moya.Method {
            switch self {
            case .getLocations: return .get
            case .postSessions: return .post
            }
          }
        }`,
      ],
      [
        'use.swift',
        `class Sync { func go() { call(ClientAdminApi.getLocations); call(ClientAdminApi.postSessions); call(ClientAdminApi.getShifts) } }`,
      ],
    ]);
    const edges = extractSwiftEgress(files, idGen, { targetTypeProtocols: ['TargetType', 'RequestTargetType'] });

    const byPath = new Map(edges.map((e) => [e.targetDescriptor?.http?.pathTemplate, e]));
    // companyPath prefix resolved and concatenated; static structure preserved
    expect(byPath.get('/companies/{NetworkConsts}/locations')?.method).toBe('GET');
    expect(byPath.get('/sessions')?.method).toBe('POST');
    // A prefix composed only of other prefixes expands too.
    expect(byPath.has('/companies/{NetworkConsts}/user_profiles/{NetworkConsts}/shifts')).toBe(true);
    expect(edges).toHaveLength(3);
    for (const e of edges) expect(e.serviceName).toBe('');
  });
});

/** A switch arm with a guard/early-return must resolve to the arm's TRAILING return, not the guard's. */
describe('[S5] switch arm with an early return in a guard', () => {
  const idGen = new StableIdGenerator('/repo', 'demo');

  it('picks the last top-level return of the arm, not the return nested in a guard', async () => {
    const files = await mkFiles([
      [
        'Api.swift',
        `enum Api: TargetType {
          case user(id: String?)
          var path: String {
            switch self {
            case .user(let id):
              guard let id else { return "/users" }
              return "/users/\\(id)"
            }
          }
          var method: Moya.Method {
            switch self {
            case .user:
              if Flag.on { return .get }
              return .post
            }
          }
        }`,
      ],
      ['use.swift', `class S { func go() { call(Api.user(id: "1")) } }`],
    ]);
    const edges = extractSwiftEgress(files, idGen, { targetTypeProtocols: ['TargetType'] });
    expect(edges).toHaveLength(1);
    expect(edges[0].targetDescriptor?.http?.pathTemplate).toBe('/users/{id}'); // NOT the guard's '/users'
    expect(edges[0].method).toBe('POST'); // NOT the if-branch's GET
  });

  it("prefixes each endpoint path with the route part of the API's baseURL", async () => {
    const files = await mkFiles([
      [
        'Network/Consts.swift',
        `enum NetworkConsts {
          static let railsApiUrl = URL(string: NetworkConsts.railsAddress + "/api/mobile")!
          static let universalApiUrl = URL(string: NetworkConsts.universalApiAddress)!
          static let publicUniversalApiUrl = universalApiUrl.appendingPathComponent("/v2/public")
          static func gatewayApiUrl(version v: Int = 3) -> URL {
            universalApiUrl.appendingPathComponent("/v\\(v)/public/api-gateway")
          }
        }
        protocol RailsTarget {}
        extension RailsTarget where Self: TargetType {
          var baseURL: URL { return NetworkConsts.railsApiUrl }
        }`,
      ],
      [
        'Network/Apis.swift',
        `enum RailsApi: TargetType, RailsTarget {
          case sessions
          var path: String { switch self { case .sessions: return "sessions" } }
          var method: Moya.Method { .post }
        }
        enum ClientAdminApi: TargetType {
          case requests
          var baseURL: URL { NetworkConsts.publicUniversalApiUrl.appendingPathComponent("client_admin_api") }
          var path: String { switch self { case .requests: return "/requests" } }
        }
        enum GatewayApi: TargetType {
          case sync
          var baseURL: URL { NetworkConsts.gatewayApiUrl() }
          var path: String { switch self { case .sync: return "/kiosk/sync" } }
        }
        enum KioskApi: TargetType {
          case register
          var baseURL: URL {
            let host: String
            switch ServerEnv.current { case .production: host = "admin-api" }
            return URL(string: "https://\\(host).\\(domainAddress)/v1/public")!
          }
          var path: String { switch self { case .register: return "/structure/tablets/register" } }
        }`,
      ],
      [
        'Sync.swift',
        `class Sync {
          func run() {
            a(RailsApi.sessions); b(ClientAdminApi.requests); c(GatewayApi.sync); d(KioskApi.register)
          }
        }`,
      ],
    ]);
    const edges = extractSwiftEgress(files, idGen, { targetTypeProtocols: ['TargetType'] });
    expect(edges.map((e) => e.targetDescriptor?.http?.pathTemplate).sort()).toEqual([
      '/api/mobile/sessions',
      '/v1/public/structure/tablets/register',
      '/v2/public/client_admin_api/requests',
      '/v3/public/api-gateway/kiosk/sync',
    ]);
  });
});

describe('parseDiContainer', () => {
  it('splits DI.shared into root/field, rejects non 2-part chains', () => {
    expect(parseDiContainer('DI.shared')).toEqual({ root: 'DI', field: 'shared' });
    expect(parseDiContainer('DI')).toBeUndefined();
    expect(parseDiContainer(undefined)).toBeUndefined();
  });
});
