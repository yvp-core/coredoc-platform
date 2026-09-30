import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { ServerCompatInfo } from '../../shared/ipc-types';
import { useAuthStore } from '../stores/auth-store';
import { Button } from './ui/button';
import { compatBannerMessage } from './server-compat-message';

/**
 * Honest, dismissible notice when this app and the Coredoc server it talks to
 * are on incompatible release lines — on-prem servers permanently lag the
 * hosted fleet, so an opaque 404 deep in a flow is the alternative.
 *
 * Advisory only: it never blocks the UI (reads usually still work). Nothing is
 * shown when the verdict is compatible or unknown (server unreachable).
 */
export function ServerCompatBanner() {
  const authChangeCount = useAuthStore((state) => state.authChangeCount);
  const [compat, setCompat] = useState<ServerCompatInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: authChangeCount is an intentional re-fetch trigger — a login callback can move the app onto the stored tokens' server, which is a different handshake.
  useEffect(() => {
    let cancelled = false;
    // Optional-chained like AppLayout's other electronAPI reads: a renderer
    // harness with a partial mock must not crash the shell over a banner.
    const pending = window.electronAPI?.workspaceGetServerCompat?.();
    if (!pending) return;
    pending
      .then((result) => {
        if (cancelled) return;
        setCompat(result);
        // A login (or a login against a different server) is a new verdict, so
        // it earns a fresh showing rather than inheriting an old dismissal.
        setDismissed(false);
      })
      .catch(() => {
        // Best-effort — a version check must never break the app shell.
      });
    return () => {
      cancelled = true;
    };
  }, [authChangeCount]);

  const message = compat ? compatBannerMessage(compat) : null;
  if (!message || dismissed) return null;

  return (
    <div className="shrink-0 flex items-center gap-2 px-4 py-2 bg-bg-tag-warning border-b border-border-input">
      <p className="flex-1 text-xs font-medium text-content-secondary">{message}</p>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Dismiss server version notice"
        onClick={() => setDismissed(true)}
      >
        <X />
      </Button>
    </div>
  );
}
