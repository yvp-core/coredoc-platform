import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { UseQueryResult } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { QueryBoundary } from './QueryBoundary';

describe('observability query boundary', () => {
  it('never renders a raw server response body', () => {
    const query = {
      isLoading: false,
      isError: true,
      error: new Error('Bearer fixture-secret /Users/private server body'),
      refetch: vi.fn(),
    } as unknown as UseQueryResult<unknown>;

    const html = renderToStaticMarkup(QueryBoundary({ query, children: () => createElement('span', null, 'loaded') }));

    expect(html).toContain('load this section.');
    expect(html).toContain('Retry');
    expect(html).not.toMatch(/Bearer|fixture-secret|Users\/private|server body/i);
  });
});
