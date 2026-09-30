import type { ParsedRepo } from '@coredoc/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reportCallResolution, reportIntegrity } from './integrity-report.js';

function repoWith(integrity?: ParsedRepo['stats']['integrity']): ParsedRepo {
  return { stats: { integrity } } as ParsedRepo;
}

function repoWithDbOps(dbOpResolution?: ParsedRepo['stats']['dbOpResolution']): ParsedRepo {
  return { stats: { dbOpResolution } } as ParsedRepo;
}

function repoWithResolution(
  callResolution?: ParsedRepo['stats']['callResolution'],
  kotlin?: Partial<NonNullable<ParsedRepo['stats']['kotlin']>>,
): ParsedRepo {
  return { stats: { callResolution, kotlin } } as ParsedRepo;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('reportIntegrity', () => {
  it('prints a loud line naming every collection with dangling references', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    reportIntegrity(repoWith({ danglingRefs: 457, byCollection: { 'functions.classId': 435, 'entities.fileId': 22 } }));

    const printed = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('457 dangling reference(s)');
    expect(printed).toContain('functions.classId=435');
    expect(printed).toContain('entities.fileId=22');
  });

  it('says nothing on a clean graph', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    reportIntegrity(repoWith({ danglingRefs: 0, byCollection: {} }));

    expect(log).not.toHaveBeenCalled();
  });

  it('says nothing for an output produced before the integrity pass existed', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    reportIntegrity(repoWith(undefined));

    expect(log).not.toHaveBeenCalled();
  });
});

describe('reportCallResolution', () => {
  const printed = (log: { mock: { calls: unknown[][] } }) => log.mock.calls.map((c) => String(c[0])).join('\n');

  // The rate is against calls that could target this repo. Counting the 300 platform calls as
  // failures would report 25% for a graph that bound 130 of the 140 sites it could bind.
  it('reports the rate against in-repo sites and discloses the platform calls beside it', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    reportCallResolution(repoWithResolution({ callSites: 440, outOfScopeCalls: 300, resolvedCalls: 130 }));

    expect(printed(log)).toContain('130/140 counted in-repo call sites bound (93%)');
    expect(printed(log)).toContain('300 of 440 counted sites name nothing declared in this repository');
  });

  // The Kotlin record is absent on every repo without a Kotlin target (and on a multi-target
  // merge that drops it): the line must read as a plain rate rather than claim zero ambiguity.
  it('omits the Kotlin suffix when the repo carries no Kotlin record', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    reportCallResolution(repoWithResolution({ callSites: 10, outOfScopeCalls: 0, resolvedCalls: 4 }));

    expect(printed(log)).toContain('4/10 counted in-repo call sites bound (40%);');
    expect(printed(log)).not.toContain('Kotlin');
  });

  // A record whose counts cannot all be true used to be reported as a measured fact (clamped
  // into "all out of scope" / a 100% rate). It must name itself broken instead.
  it('names an impossible call record as inconsistent instead of printing a rate', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    reportCallResolution(repoWithResolution({ callSites: 10, outOfScopeCalls: 40, resolvedCalls: 0 }));

    expect(printed(log)).toContain(
      'call resolution: inconsistent call-resolution record — re-parse and re-push (0 bound, 40 out of scope over 10 counted sites)',
    );
    expect(printed(log)).not.toContain('%');
  });

  it('labels ambiguous sites as the Kotlin-only diagnostic they are', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    reportCallResolution(
      repoWithResolution({ callSites: 10, outOfScopeCalls: 0, resolvedCalls: 4 }, { ambiguousCalls: 3 }),
    );

    // Labelled: the denominator beside it is language-neutral and may span several targets.
    expect(printed(log)).toContain('(Kotlin: 3 ambiguous)');
  });

  // A repo whose every call goes outward has no rate to report, and dividing would throw a
  // NaN or an Infinity into the parse summary.
  it('says so plainly when no call site targets this repository', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    reportCallResolution(repoWithResolution({ callSites: 12, outOfScopeCalls: 12, resolvedCalls: 0 }));

    expect(printed(log)).toContain(
      'no counted call site names a declaration in this repository (12 counted sites, all out of scope)',
    );
    expect(printed(log)).not.toContain('NaN');
  });

  // Other languages record no rate, and a repo with no calls has nothing to divide by —
  // neither may print a line, and the second must not divide by zero.
  it('says nothing for a substrate that records no rate', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    reportCallResolution(repoWithResolution(undefined));

    expect(log).not.toHaveBeenCalled();
  });

  it('says nothing when there were no call sites at all', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    reportCallResolution(repoWithResolution({ callSites: 0, resolvedCalls: 0, outOfScopeCalls: 0 }));

    expect(log).not.toHaveBeenCalled();
  });
});

describe('db-op resolution line', () => {
  const printed = (log: { mock: { calls: unknown[][] } }) => log.mock.calls.map((c) => String(c[0])).join('\n');

  it('reports bound sites against the in-scope sites, disclosing the out-of-scope ones beside it', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    reportCallResolution(repoWithDbOps({ dbOpSites: 90, boundDbOps: 40, outOfScopeDbOps: 30 }));

    expect(printed(log)).toContain(
      '    db-op resolution: 40/60 counted db-operation sites bound (67%); 30 of 90 counted sites name no entity or table declared in this repository',
    );
  });

  it('names an impossible db-operation record as inconsistent instead of printing a rate', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    reportCallResolution(repoWithDbOps({ dbOpSites: 10, boundDbOps: 80, outOfScopeDbOps: 0 }));

    expect(printed(log)).toContain(
      'db-op resolution: inconsistent db-operation-resolution record — re-parse and re-push (80 bound, 0 out of scope over 10 counted sites)',
    );
    expect(printed(log)).not.toContain('%');
  });

  it('says so plainly when no counted site names anything declared here', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    reportCallResolution(repoWithDbOps({ dbOpSites: 9, boundDbOps: 0, outOfScopeDbOps: 9 }));

    expect(printed(log)).toContain(
      '    db-op resolution: no counted db-operation site names an entity or table declared in this repository (9 counted sites, all out of scope)',
    );
    expect(printed(log)).not.toContain('NaN');
  });

  it('says nothing for a substrate that records no db-op resolution', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    reportCallResolution(repoWithDbOps(undefined));
    reportCallResolution(repoWithDbOps({ dbOpSites: 0, boundDbOps: 0, outOfScopeDbOps: 0 }));

    expect(log).not.toHaveBeenCalled();
  });
});
