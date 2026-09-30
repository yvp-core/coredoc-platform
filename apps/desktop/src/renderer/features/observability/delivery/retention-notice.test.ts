import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CanonicalRetentionNotice } from './RetentionNotice';

// Relocated with the component from the deleted CanonicalDeliveryTimeline.tsx.
describe('CanonicalRetentionNotice', () => {
  it('states the retained gap without claiming that no event arrived', () => {
    const html = renderToStaticMarkup(
      createElement(CanonicalRetentionNotice, {
        retention: { policyDays: 90, purgedThroughReceivedAt: '2026-05-01T00:00:00.000Z' },
      }),
    );

    expect(html).toContain('Fine-event details received through');
    expect(html).toContain('are unavailable under the 90-day retention policy.');
    expect(html).toContain('Durable delivery facts remain available.');
    expect(html).not.toMatch(/no events? (?:were )?received/i);
  });

  it('renders nothing when no purge cutoff is recorded', () => {
    const html = renderToStaticMarkup(
      createElement(CanonicalRetentionNotice, {
        retention: { policyDays: 90, purgedThroughReceivedAt: null },
      }),
    );

    expect(html).toBe('');
  });
});
