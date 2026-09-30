import { describe, it, expect } from 'vitest';
import {
  entrypointAddressMatches,
  entrypointAddressTokens,
  normalizeRoutePath,
  routePathMatches,
  staticRouteAnchor,
} from './route-path.js';

describe('normalizeRoutePath', () => {
  it('canonicalizes every parameter syntax to the same token', () => {
    const forms = [
      'v3/companies/{companyUuid}/planning_spaces',
      'v3/companies/:companyUuid/planning_spaces',
      'v3/companies/{uuid}/planning_spaces',
      'v3/companies/{_}/planning_spaces',
      'v3/companies/<id>/planning_spaces',
      'v3/companies/[id]/planning_spaces',
      '/v3/Companies/*/planning_spaces/',
    ];
    const normalized = forms.map(normalizeRoutePath);
    for (const n of normalized) expect(n).toBe('v3/companies/:p/planning_spaces');
  });

  it('trims slashes, lowercases, and drops empty segments', () => {
    expect(normalizeRoutePath('//A//B//')).toBe('a/b');
  });
});

describe('routePathMatches', () => {
  const stored = 'v3/public/api-gateway/shifts/companies/{companyUuid}/planning_spaces';

  it('matches regardless of the parameter placeholder the agent typed', () => {
    for (const q of [
      'v3/public/api-gateway/shifts/companies/{companyUuid}/planning_spaces',
      'v3/public/api-gateway/shifts/companies/:companyUuid/planning_spaces',
      'companies/{uuid}/planning_spaces',
      'companies/{_}/planning_spaces',
      'companies/<id>/planning_spaces',
    ]) {
      expect(routePathMatches(q, stored)).toBe(true);
    }
  });

  it('still honors the literal segments (no false match across routes)', () => {
    expect(routePathMatches('companies/{id}/locations', stored)).toBe(false);
    expect(routePathMatches('teams/{id}/planning_spaces', stored)).toBe(false);
  });

  it('an empty query matches anything', () => {
    expect(routePathMatches('', stored)).toBe(true);
  });
});

describe('staticRouteAnchor', () => {
  it('returns the longest literal segment for the DB pre-filter', () => {
    expect(staticRouteAnchor('v3/companies/{companyUuid}/planning_spaces')).toBe('planning_spaces');
  });

  it('returns undefined when the path is entirely parameters', () => {
    expect(staticRouteAnchor('/{a}/:b/<c>')).toBeUndefined();
  });
});

describe('entrypointAddressMatches', () => {
  // Shape taken from a pilot workspace graph: a Kafka-backed queue
  // entrypoint carries a destination/topic and NO path at all.
  const queueEntrypoint = {
    topic: 'Topics.DailySummaryRecalculateV2',
    destination: 'Topics.DailySummaryRecalculateV2',
  };

  it('matches a queue entrypoint by its destination token', () => {
    expect(entrypointAddressMatches('Topics.DailySummaryRecalculateV2', queueEntrypoint)).toBe(true);
  });

  it('matches a queue entrypoint by a substring of its destination', () => {
    expect(entrypointAddressMatches('DailySummaryRecalculateV2', queueEntrypoint)).toBe(true);
  });

  it('does not match an unrelated pattern', () => {
    expect(entrypointAddressMatches('ShiftsUpdatedV2', queueEntrypoint)).toBe(false);
  });

  it('still matches HTTP entrypoints by path, placeholder-agnostically', () => {
    const http = { fullPath: '/v3/companies/{companyUuid}/spaces', path: '/companies/:companyUuid/spaces' };
    expect(entrypointAddressMatches('companies/:id/spaces', http)).toBe(true);
    expect(entrypointAddressMatches('companies/{id}/locations', http)).toBe(false);
  });

  it('matches cron schedules and CLI commands', () => {
    expect(entrypointAddressMatches('0 3 * * *', { schedule: '0 3 * * *' })).toBe(true);
    expect(entrypointAddressMatches('migrate', { command: 'db:migrate' })).toBe(true);
  });

  it('matches a mobile entrypoint by its component class name', () => {
    expect(entrypointAddressMatches('MainActivity', { className: 'MainActivity' })).toBe(true);
    expect(entrypointAddressMatches('SettingsActivity', { className: 'MainActivity' })).toBe(false);
  });

  it('an entrypoint with no address token cannot match a non-empty pattern', () => {
    expect(entrypointAddressMatches('anything', {})).toBe(false);
    expect(entrypointAddressMatches('', {})).toBe(true);
  });
});

describe('entrypointAddressTokens', () => {
  it('lists every non-empty address token and drops blanks', () => {
    expect(entrypointAddressTokens({ fullPath: '/a', path: '   ', topic: 'T' })).toEqual(['/a', 'T']);
  });
});
