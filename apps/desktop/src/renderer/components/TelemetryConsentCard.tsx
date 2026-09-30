import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Button } from './ui/button';
import { applyTelemetryConsent, type TelemetryConsentChoice } from '../telemetry-consent';
import { initTelemetry } from '../telemetry';

/**
 * First-run telemetry consent card (P0.10).
 *
 * Shown once, at first launch, iff a consent surface has never been shown
 * (`!status.consentPrompted`). It ASKS — it never auto-enables. On Enable the
 * user opts in and the renderer PostHog client inits; on Not-now (or dismiss)
 * telemetry stays OFF. Either resolution stamps the once-only gate so the card
 * never reappears. All IPC routes through window.electronAPI — the renderer
 * never imports @coredoc/core/telemetry.
 */
export function TelemetryConsentCard() {
  const [open, setOpen] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [busy, setBusy] = useState(false);
  // Resolve the consent exactly once even if Enable, Not-now, and an Esc/overlay
  // close all fire (the button handler flips `open`, which re-enters onOpenChange).
  const resolvedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const status = await window.electronAPI.getTelemetryStatus();
        if (!cancelled && !status.consentPrompted) {
          setOpen(true);
        }
      } catch {
        // Best-effort — never block startup on a telemetry status read.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const resolve = useCallback(async (choice: TelemetryConsentChoice) => {
    if (resolvedRef.current) return;
    resolvedRef.current = true;
    setBusy(true);
    try {
      const enabled = await applyTelemetryConsent(choice);
      if (enabled) {
        // Spin up the renderer PostHog client now that the user opted in.
        await initTelemetry();
      }
    } catch {
      // Best-effort — a failed consent write must never break the app.
    } finally {
      setBusy(false);
      setOpen(false);
    }
  }, []);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Closing without picking Enable (Esc / overlay) counts as Not-now, so
        // the card is dismissed for good rather than re-prompting every launch.
        if (!next) void resolve('dismiss');
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Help improve CoreDoc?</DialogTitle>
          <DialogDescription>
            Share anonymous usage and parse-health data so we can find and fix problems faster. No source code, file
            paths, or personal information is ever collected. Telemetry is off unless you enable it, and you can change
            it any time in Settings.
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <button
            type="button"
            className="self-start px-0.5 text-sm text-content-action-secondary underline cursor-pointer"
            onClick={() => setShowDetails((v) => !v)}
          >
            {showDetails ? 'Hide details' : 'What is collected?'}
          </button>

          {showDetails && (
            <div className="px-0.5 text-sm font-medium text-content-tertiary leading-5">
              <p className="text-content-secondary">Collected (anonymous):</p>
              <ul className="list-disc pl-5">
                <li>Which commands run and whether they succeed</li>
                <li>Parse health (counts and coverage anomalies — never names)</li>
                <li>A random install id, app version, and OS platform</li>
              </ul>
              <p className="mt-2 text-content-secondary">Never collected:</p>
              <ul className="list-disc pl-5">
                <li>Source code, file contents, or diffs</li>
                <li>File paths, function names, or repo names</li>
                <li>Any personally identifiable information</li>
              </ul>
            </div>
          )}
        </DialogBody>

        <DialogFooter>
          <Button variant="secondary" onClick={() => void resolve('dismiss')} disabled={busy}>
            Not now
          </Button>
          <Button variant="brand" onClick={() => void resolve('enable')} disabled={busy}>
            {busy ? <Loader2 className="size-3.5 animate-spin mr-1.5" /> : null}
            Enable telemetry
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
