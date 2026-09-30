import { describe, it, expect } from 'vitest';
import { formatReport, guessMissingRepo } from './cross-service-report.js';
import type { CrossServiceReport } from './cross-service-report.js';

describe('formatReport', () => {
  it('produces a readable text report with all sections', () => {
    const report: CrossServiceReport = {
      project: 'acme',
      totals: { externalCalls: 1102, resolved: 270, resolutionRate: 0.245 },
      perSourceRepo: [
        { name: 'gateway', total: 169, resolved: 75, rate: 0.444 },
        { name: 'orders', total: 48, resolved: 17, rate: 0.354 },
      ],
      unresolvedByService: [
        { serviceName: 'billing-api-client', count: 47, targetRepoLikelyMissing: 'billing' },
        { serviceName: 'redis', count: 45, targetRepoLikelyMissing: null },
      ],
      suspectedParserBugs: [
        {
          repo: 'gateway',
          pattern: 'stub-domain-path',
          count: 79,
          sample: { service: 'acme-orders', method: 'list', pathTemplate: '/orders' },
        },
      ],
    };
    const text = formatReport(report);
    expect(text).toContain('Cross-Service Resolution Report');
    expect(text).toContain('Project: acme');
    expect(text).toContain('270/1102');
    expect(text).toContain('gateway');
    expect(text).toContain('add repo "billing"');
    expect(text).toContain('stub-domain-path');
  });

  it('omits parser-bugs section when there are none', () => {
    const report: CrossServiceReport = {
      project: 'demo',
      totals: { externalCalls: 10, resolved: 10, resolutionRate: 1.0 },
      perSourceRepo: [{ name: 'demo', total: 10, resolved: 10, rate: 1.0 }],
      unresolvedByService: [],
      suspectedParserBugs: [],
    };
    expect(formatReport(report)).not.toContain('Suspected parser bugs');
  });
});

describe('guessMissingRepo', () => {
  it('strips a "-service" suffix and suggests the stripped form', () => {
    expect(guessMissingRepo('billing-service', new Set(['users']))).toBe('billing');
  });

  it('strips an npm scope and suggests the bare package name', () => {
    expect(guessMissingRepo('@acme/billing', new Set(['users']))).toBe('billing');
  });

  it('strips the "-api-client" SDK suffix', () => {
    expect(guessMissingRepo('billing-api-client', new Set(['users']))).toBe('billing');
  });

  it('returns null when the name has no recognizable decoration', () => {
    expect(guessMissingRepo('redis', new Set(['users']))).toBeNull();
  });

  it('returns null when the stripped form is already a parsed repo', () => {
    expect(guessMissingRepo('billing-service', new Set(['billing']))).toBeNull();
  });

  it('returns null when the original name is already a parsed repo', () => {
    expect(guessMissingRepo('billing', new Set(['billing']))).toBeNull();
  });
});
