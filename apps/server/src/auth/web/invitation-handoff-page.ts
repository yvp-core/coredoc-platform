/**
 * This handoff deliberately belongs to the API server rather than apps/web:
 * production images are API-only and do not ship the POC SPA.
 */
export function invitationHandoffPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Invitation accepted · Coredoc</title>
    <style>
      :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif; }
      * { box-sizing: border-box; }
      body { min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 24px; color: #f4f4f5; background: #09090b; }
      main { width: min(100%, 440px); padding: 32px; border: 1px solid #27272a; border-radius: 14px; background: #111113; box-shadow: 0 24px 80px rgb(0 0 0 / 35%); }
      .brand { margin: 0 0 28px; color: #a1a1aa; font: 600 14px ui-monospace, SFMono-Regular, Menlo, monospace; }
      h1 { margin: 0; font-size: 24px; line-height: 1.25; }
      p { margin: 12px 0 0; color: #a1a1aa; font-size: 14px; line-height: 1.6; }
      .actions { display: grid; gap: 10px; margin-top: 28px; }
      a { display: block; padding: 11px 16px; border-radius: 8px; color: #18181b; background: #fafafa; font-size: 14px; font-weight: 600; text-align: center; text-decoration: none; }
      a.secondary { border: 1px solid #71717a; color: #e4e4e7; background: transparent; }
      .hint { margin-top: 14px; font-size: 12px; text-align: center; }
    </style>
  </head>
  <body>
    <main>
      <div class="brand">coredoc/cloud</div>
      <h1>Invitation accepted</h1>
      <p>Your workspace access is ready. Install the latest Coredoc Desktop first so the invitation login link is supported.</p>
      <div class="actions">
        <a href="/api/v1/auth/web/desktop-download?arch=arm64">Download latest for Apple Silicon</a>
        <a class="secondary" href="/api/v1/auth/web/desktop-download?arch=x64">Download for Intel Mac</a>
        <a class="secondary" href="coredoc://login">Already updated? Open Coredoc Desktop</a>
      </div>
      <p class="hint">After installing or updating, use the open button to sign in and finish setup.</p>
    </main>
  </body>
</html>`;
}
