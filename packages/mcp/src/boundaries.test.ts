/**
 * Tests for the dynamic-boundary assembly shared surface (boundaries.ts).
 */

import { describe, it, expect } from 'vitest';
import { formatBoundarySection, appendBoundarySection, BOUNDARY_SITE_CAP } from './boundaries.js';
import { DETAIL_ESCALATION_HINT } from './detail-level.js';
import type { McpResponse, McpResponseMetadata } from './types.js';
import type { UnresolvedCallRecord } from '@coredoc/db/types';

const record = (i: number): UnresolvedCallRecord => ({
  callerId: `abc:function:src/producer.ts:publish${i}`,
  calleeExpression: `dispatch(handlers[${i}])`,
  calleeNameTail: null,
  filePath: 'src/producer.ts',
  line: 10 + i,
});

const baseMetadata: McpResponseMetadata = {
  scope: { currentPath: '/repo', resolvedRepos: ['r'], repoHashes: ['abc'], crossRepoEnabled: false },
  staleness: { warning: 'stale', parsedAt: 'unknown' },
  format: 'summary',
  detailLevel: 'full',
  detailConfig: { includeBasic: true, includeSummaries: true, includeRefs: true, includeFullDetails: true },
};

describe('formatBoundarySection', () => {
  it('renders an exact omitted count below the fetch limit', () => {
    const records = Array.from({ length: 7 }, (_, i) => record(i));
    const lines = formatBoundarySection('Boundaries', records);
    expect(lines).toContain(`- …and ${7 - BOUNDARY_SITE_CAP} more omitted`);
  });

  it('renders a lower-bound `+` suffix when the fetch hit BOUNDARY_FETCH_LIMIT', () => {
    // BOUNDARY_FETCH_LIMIT is 1000 and private — 1000 records is the boundary case.
    const records = Array.from({ length: 1000 }, (_, i) => record(i));
    const lines = formatBoundarySection('Boundaries', records);
    const omittedLine = lines.find((line) => line.includes('more omitted'));
    expect(omittedLine).toBe(`- …and ${1000 - BOUNDARY_SITE_CAP}+ more omitted`);
  });

  it('does not add a `+` when the count is exact even close to five digits', () => {
    const records = Array.from({ length: 999 }, (_, i) => record(i));
    const lines = formatBoundarySection('Boundaries', records);
    const omittedLine = lines.find((line) => line.includes('more omitted'));
    expect(omittedLine).toBe(`- …and ${999 - BOUNDARY_SITE_CAP} more omitted`);
  });

  it('returns [] when there are no records and no note', () => {
    expect(formatBoundarySection('Boundaries', [])).toEqual([]);
  });

  it('renders just the header and note when records are empty but a note is given', () => {
    const lines = formatBoundarySection('Boundaries', [], 'boundary scan covered the first 200 of 350 impacted files');
    expect(lines).toEqual(['', '### Boundaries', '> boundary scan covered the first 200 of 350 impacted files']);
  });

  it('appends the note after the site list when both are present', () => {
    const lines = formatBoundarySection('Boundaries', [record(0)], 'a trailing note');
    expect(lines[lines.length - 1]).toBe('> a trailing note');
  });
});

describe('appendBoundarySection', () => {
  function freshResponse(format: 'summary' | 'raw' = 'summary'): McpResponse<unknown> {
    return {
      data: format === 'raw' ? { items: [] } : 'body text',
      metadata: { ...baseMetadata, format },
    };
  }

  it('is a no-op when records are empty and no note is given', () => {
    const response = freshResponse();
    appendBoundarySection(response, [], 'Title');
    expect(response.data).toBe('body text');
  });

  it('still renders the section (with just the note) when records are empty but a note is given', () => {
    const response = freshResponse();
    appendBoundarySection(response, [], 'Title', 'boundary scan covered the first 200 of 350 impacted files');
    expect(response.data).toContain('### Title');
    expect(response.data).toContain('boundary scan covered the first 200 of 350 impacted files');
  });

  it('raw output stays a plain unmodified shape when records are empty, even with a note', () => {
    const response = freshResponse('raw');
    const before = response.data;
    appendBoundarySection(response, [], 'Title', 'boundary scan covered the first 200 of 350 impacted files');
    expect(response.data).toBe(before);
  });

  it('sets omittedIsLowerBound on the raw payload only when the fetch hit the limit', () => {
    const exact = freshResponse('raw');
    appendBoundarySection(
      exact,
      Array.from({ length: 999 }, (_, i) => record(i)),
      'Title',
    );
    expect(
      (exact.data as { boundaries: { omittedIsLowerBound?: boolean } }).boundaries.omittedIsLowerBound,
    ).toBeUndefined();

    const atLimit = freshResponse('raw');
    appendBoundarySection(
      atLimit,
      Array.from({ length: 1000 }, (_, i) => record(i)),
      'Title',
    );
    expect((atLimit.data as { boundaries: { omittedIsLowerBound?: boolean } }).boundaries.omittedIsLowerBound).toBe(
      true,
    );
  });

  it('keeps the basic-detail escalation footer last even when the section is note-only', () => {
    const response = freshResponse();
    response.data = `body text\n\n${DETAIL_ESCALATION_HINT}`;
    appendBoundarySection(response, [], 'Title', 'a truncation note');
    const lines = (response.data as string).split('\n').filter((l) => l.length > 0);
    expect(lines[lines.length - 1]).toBe(DETAIL_ESCALATION_HINT);
    expect(response.data).toContain('a truncation note');
  });
});
