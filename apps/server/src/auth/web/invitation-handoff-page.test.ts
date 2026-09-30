import { describe, expect, it } from 'vitest';
import { invitationHandoffPage } from './invitation-handoff-page.js';

describe('invitationHandoffPage', () => {
  it('offers the Desktop deep link and download without depending on the web SPA', () => {
    const html = invitationHandoffPage();

    expect(html).toContain('Invitation accepted');
    expect(html).toContain('href="coredoc://login"');
    expect(html).toContain('href="/api/v1/auth/web/desktop-download?arch=arm64"');
    expect(html).toContain('href="/api/v1/auth/web/desktop-download?arch=x64"');
    expect(html.indexOf('desktop-download?arch=arm64')).toBeLessThan(html.indexOf('coredoc://login'));
    expect(html).toContain('Already updated?');
    expect(html).not.toContain('github.com');
    expect(html).not.toContain('/w/');
    expect(html).not.toContain('<script');
  });
});
