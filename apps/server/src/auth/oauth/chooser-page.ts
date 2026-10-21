/**
 * The "Sign in with ..." page chooser.provider.ts renders on a bare /authorize.
 * Served by the API, not apps/web: every OAuth client (web, desktop, MCP
 * plugins) lands here, so login must not depend on the SPA being deployed.
 */

import type { Request } from 'express';
import type { OAuthProviderConfig } from '@rekog/mcp-nest';

export function chooserPage(req: Request, providers: OAuthProviderConfig[]): string {
  const links = providers
    .map((p) => {
      const query = new URLSearchParams(req.originalUrl.split('?')[1] ?? '');
      query.set('idp', p.name);
      // URLSearchParams percent-encodes everything but `&`/`=` separators.
      return `<a href="?${query.toString().replaceAll('&', '&amp;')}">Sign in with ${p.displayName ?? p.name}</a>`;
    })
    .join('\n        ');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Sign in · Coredoc</title>
    <style>
      :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif; }
      * { box-sizing: border-box; }
      body { min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 24px; color: #f4f4f5; background: #09090b; }
      main { width: min(100%, 440px); padding: 32px; border: 1px solid #27272a; border-radius: 14px; background: #111113; box-shadow: 0 24px 80px rgb(0 0 0 / 35%); }
      .brand { margin: 0 0 28px; color: #a1a1aa; font: 600 14px ui-monospace, SFMono-Regular, Menlo, monospace; }
      h1 { margin: 0; font-size: 24px; line-height: 1.25; }
      .actions { display: grid; gap: 10px; margin-top: 28px; }
      a { display: block; padding: 11px 16px; border-radius: 8px; color: #18181b; background: #fafafa; font-size: 14px; font-weight: 600; text-align: center; text-decoration: none; }
    </style>
  </head>
  <body>
    <main>
      <div class="brand">coredoc</div>
      <h1>Sign in</h1>
      <div class="actions">
        ${links}
      </div>
    </main>
  </body>
</html>`;
}
