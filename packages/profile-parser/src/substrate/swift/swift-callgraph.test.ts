import { describe, expect, it } from 'vitest';
import { StableIdGenerator } from '@coredoc/core';
import { type SwiftFile, indexSwiftDefs, parseDiContainer, resolveSwiftCalls } from './swift-callgraph.js';
import { parseSwift } from './swift-cst.js';

async function mkFiles(entries: Array<[string, string]>): Promise<SwiftFile[]> {
  return Promise.all(entries.map(async ([relPath, source]) => ({ relPath, source, root: await parseSwift(source) })));
}

/** [S7 Tier-B call precision] direct construction + DI.shared two-hop resolve; unresolved dropped. */
describe('[S7] swift Tier-B call graph', () => {
  const idGen = new StableIdGenerator('/repo', 'demo');
  const di = parseDiContainer('DI.shared');

  const SRC = `class EmployeeService { func refresh() {} }
class UserService { func logout() {} }
class DI {
  static let shared = DI()
  var employeeService: EmployeeService { EmployeeService() }
}
class Caller {
  func directConstruction() { UserService().logout() }
  func viaDI() { DI.shared.employeeService.refresh() }
  func unresolvableBare() { doSomethingUnknown() }
  func selfRecursion() { selfRecursion() }
}`;

  it('resolves the two strong idioms and drops everything else (no fabrication, no self-edge)', async () => {
    const files = await mkFiles([['app.swift', SRC]]);
    const index = indexSwiftDefs(files, idGen, di?.root);

    // DI accessor pre-pass mapped employeeService → EmployeeService
    expect(index.diAccessorTypes.get('employeeService')).toBe('EmployeeService');

    const calls = resolveSwiftCalls(files, index, idGen, di);
    const resolved = calls.map((c) => `${c.callerId} -> ${c.calleeId}`);

    // direct construction: UserService().logout() → UserService.logout
    expect(resolved).toContain(
      `${idGen.methodId('app.swift', 'Caller', 'directConstruction')} -> ${idGen.methodId('app.swift', 'UserService', 'logout')}`,
    );
    // DI two-hop: DI.shared.employeeService.refresh() → EmployeeService.refresh
    expect(resolved).toContain(
      `${idGen.methodId('app.swift', 'Caller', 'viaDI')} -> ${idGen.methodId('app.swift', 'EmployeeService', 'refresh')}`,
    );

    // exactly the two resolved edges — bare-unknown + self-recursion are dropped
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.calleeId).toBeDefined();
      expect(c.provenance).toBe('di');
      expect(c.callerId).not.toBe(c.calleeId); // no self-edge
    }
  });

  it('must NOT count a top-level call site — it has no enclosing func (LIM-6)', async () => {
    // A call in a property getter or at file scope really runs, but this substrate attributes
    // it to no func node, so it can never resolve. Counting it would grow the denominator with
    // a site the extractor was never able to answer for. The in-func sibling still counts.
    const files = await mkFiles([
      [
        'top.swift',
        `class UserService { func logout() {} }
let seed = UserService().logout()
class Caller {
  func run() { UserService().logout() }
}`,
      ],
    ]);
    const index = indexSwiftDefs(files, idGen, di?.root);
    const measurement = { callSites: 0, resolvedCalls: 0, outOfScopeCalls: 0 };

    resolveSwiftCalls(files, index, idGen, di, measurement);

    expect(measurement.callSites).toBe(1);
  });

  it('emits a FunctionNode for every declaration (structural floor)', async () => {
    const files = await mkFiles([['app.swift', SRC]]);
    const index = indexSwiftDefs(files, idGen, di?.root);
    const names = [...index.byId.values()].map((f) => f.name).sort();
    expect(names).toEqual(['directConstruction', 'logout', 'refresh', 'selfRecursion', 'unresolvableBare', 'viaDI']);
  });
});
