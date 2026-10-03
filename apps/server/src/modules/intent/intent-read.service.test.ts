import { describe, expect, it } from 'vitest';
import { stripRefs } from './intent-read.service.js';

describe('stripRefs', () => {
  it('drops an italic group of source refs with its leading space', () => {
    expect(stripRefs('A refund is refused after 30 days. *(jira:PROD-1 AC2; code:shop/refunds.ts#refund)*')).toBe(
      'A refund is refused after 30 days.',
    );
  });

  it('drops refs inside a status marker and keeps the marker', () => {
    expect(stripRefs('Kiosks upload first. *Status: planned (jira:ACME-303).*')).toBe(
      'Kiosks upload first. *Status: planned.*',
    );
  });

  it('keeps a parenthesis that is not only source refs', () => {
    const line = 'Retries the check (Android up to 5 times; iOS with growing waits) (br-session-mobile-logout).';
    expect(stripRefs(line)).toBe(line);
  });

  it('drops a ref group in the middle of a sentence', () => {
    expect(
      stripRefs('Banked hours can be spent. (confluence:1000001 §1 Epic Summary) Before this, only two ways.'),
    ).toBe('Banked hours can be spent. Before this, only two ways.');
  });

  it('drops a group of refs with their dates, across a line break', () => {
    expect(stripRefs('Payment happens three ways. *(jira:ACME-304,\njira:ACME-305, 2025-05-07)*')).toBe(
      'Payment happens three ways.',
    );
  });

  it('keeps a parenthesis holding only a date', () => {
    expect(stripRefs('Shipped (2025-05-07).')).toBe('Shipped (2025-05-07).');
  });

  it('drops a ref with locators written after it', () => {
    expect(stripRefs('Sections appear above pay rates. *(jira:ACME-306 Step 7, Visibility gate)* Next.')).toBe(
      'Sections appear above pay rates. Next.',
    );
  });

  it('keeps URLs, link targets and code fences', () => {
    expect(stripRefs('See [the docs](https://wiki.example/x) and (https://wiki.example/y).')).toBe(
      'See [the docs](https://wiki.example/x) and (https://wiki.example/y).',
    );
    const fenced = '```mermaid\nA --> B(db:read)\n```';
    expect(stripRefs(`Flow *(jira:PROD-1)*\n${fenced}`)).toBe(`Flow\n${fenced}`);
  });
});
