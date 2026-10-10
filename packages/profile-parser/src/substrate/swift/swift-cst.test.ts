import { describe, expect, it } from 'vitest';
import { StableIdGenerator } from '@coredoc/core';
import { FUNC_DECL, type TsNode, enclosingTypeName, inheritedTypes, swiftMethodId } from './swift-cst.js';
import { parseSource } from '../../tree-sitter/tree-sitter-loader.js';

function collectTypes(node: TsNode, set: Set<string>): void {
  if (node.isNamed) set.add(node.type);
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c) collectTypes(c, set);
  }
}
function countErrors(node: TsNode): number {
  let n = node.type === 'ERROR' || node.isMissing ? 1 : 0;
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c) n += countErrors(c);
  }
  return n;
}

/**
 * [S1 Grammar gate] tree-sitter-swift parses the constructs the substrate depends on with
 * ZERO errors, exposing the real node vocabulary. NOTE (drift vs the spec's S1 wording): the
 * grammar has NO `enum_declaration` node — an enum is a `class_declaration` whose
 * `declaration_kind` is `enum` (body `enum_class_body`, cases `enum_entry`). The test asserts
 * the real names.
 */
describe('[S1] swift grammar gate', () => {
  const src = `import Foundation
protocol DataService { associatedtype DBObject: Object }
class BookingService: BaseService, DataService {
  typealias DBObject = BookingDB
  func fetchAll() -> [BookingDB] { return Array(realm.objects(BookingDB.self)) }
  static func shared() -> BookingService { return BookingService() }
}
struct Booking: Codable { let id: Int }
enum RailsApi: TargetType {
  case getProfiles
  var path: String { switch self { case .getProfiles: return "/profiles" } }
}`;

  it('parses with zero errors and exposes the required node types', async () => {
    const root = await parseSource('swift', src);
    expect(countErrors(root)).toBe(0);
    const types = new Set<string>();
    collectTypes(root, types);
    for (const t of [
      'function_declaration',
      'class_declaration', // unified: class / struct / enum / actor
      'protocol_declaration',
      'enum_class_body', // enum body (there is no `enum_declaration` node)
      'enum_entry',
      'call_expression',
      'navigation_expression',
      'switch_statement',
      'property_declaration',
    ]) {
      expect(types, `missing node type ${t}`).toContain(t);
    }
  });
});

describe('swiftMethodId + CST helpers', () => {
  const idGen = new StableIdGenerator('/repo', 'demo');

  it('mints methodId for instance methods, static.-prefixed for static, functionId for free funcs', async () => {
    const src = `class Svc {
  func run() {}
  static func make() {}
}
func topLevel() {}`;
    const root = await parseSource('swift', src);
    const funcs = root.descendantsOfType(FUNC_DECL) as TsNode[];
    const byName = new Map(funcs.map((f) => [f.childForFieldName('name').text as string, f]));

    expect(swiftMethodId(idGen, 'a.swift', byName.get('run'))).toBe(idGen.methodId('a.swift', 'Svc', 'run'));
    expect(swiftMethodId(idGen, 'a.swift', byName.get('make'))).toBe(idGen.methodId('a.swift', 'Svc', 'static.make'));
    expect(swiftMethodId(idGen, 'a.swift', byName.get('topLevel'))).toBe(idGen.functionId('a.swift', 'topLevel'));
    // static and instance of the same name never collapse
    expect(swiftMethodId(idGen, 'a.swift', byName.get('run'))).not.toBe(
      swiftMethodId(idGen, 'a.swift', byName.get('make')),
    );
  });

  it('reads inheritance list and enclosing type name', async () => {
    const root = await parseSource('swift', `class FooDB: Object, Encodable { func m() {} }`);
    const cls = root.descendantsOfType('class_declaration')[0] as TsNode;
    expect(inheritedTypes(cls)).toEqual(['Object', 'Encodable']);
    const fn = root.descendantsOfType(FUNC_DECL)[0] as TsNode;
    expect(enclosingTypeName(fn)).toBe('FooDB');
  });

  it('resolves a MODULE-QUALIFIED base to the type name, not the namespace', async () => {
    const root = await parseSource('swift', `class FooDB: RealmSwift.Object {}\nenum Api: Moya.TargetType {}`);
    const [cls, en] = root.descendantsOfType('class_declaration') as TsNode[];
    expect(inheritedTypes(cls)).toEqual(['Object']); // not 'RealmSwift'
    expect(inheritedTypes(en)).toEqual(['TargetType']); // not 'Moya'
  });

  it('does not treat an instance method as static because an attribute string contains "static"', async () => {
    const root = await parseSource(
      'swift',
      `class Svc { @available(*, deprecated, message: "use the static factory") func legacy() {} }`,
    );
    const fn = root.descendantsOfType(FUNC_DECL)[0] as TsNode;
    // The word "static" is inside an @available message, not a modifier — must stay an instance method.
    expect(swiftMethodId(idGen, 'a.swift', fn)).toBe(idGen.methodId('a.swift', 'Svc', 'legacy'));
  });
});
