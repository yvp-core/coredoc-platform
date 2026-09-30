/**
 * Desktop Telemetry - PostHog integration for the renderer process
 *
 * Initializes PostHog JS SDK when telemetry is enabled and PostHog env vars
 * are configured. Provides trackEvent() for UI event tracking and
 * usePageView() hook for automatic page view tracking.
 */
import posthog from 'posthog-js/dist/module.full.no-external.js';
import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

let initialized = false;
// Singleton promise so concurrent callers (App mount + usePageView) share
// the same init attempt and can await completion. This matters for the
// first pageview: usePageView fires on mount before init resolves, so
// it must wait on this promise before capturing.
let initPromise: Promise<void> | null = null;

/**
 * Initialize PostHog in the renderer. Safe to call multiple times — all
 * callers share a single init attempt via the cached promise. Only
 * initializes if telemetry is enabled and PostHog is configured.
 */
export function initTelemetry(): Promise<void> {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      const status = await window.electronAPI.getTelemetryStatus();
      if (!status.enabled || !status.posthogConfigured) return;

      // PostHog key/host are owned by the main process (COREDOC_POSTHOG_*) and
      // forwarded to the renderer via the telemetry status IPC. This avoids a
      // split-brain config where the renderer would need its own VITE_* vars.
      const apiKey = status.posthogKey;
      const host = status.posthogHost;
      if (!apiKey || !host) return;

      posthog.init(apiKey, {
        api_host: host,
        autocapture: false,
        capture_pageview: false, // we track manually via usePageView
        persistence: 'memory', // no cookies/localStorage — privacy first
        disable_session_recording: true,
        // Electron CSP blocks eu-assets.i.posthog.com (remote config endpoint).
        // We don't use feature flags / surveys / toolbar — disable everything
        // that hits /decide or /array/*/config so PostHog only POSTs to /capture.
        advanced_disable_decide: true,
        advanced_disable_feature_flags: true,
        advanced_disable_feature_flags_on_first_load: true,
        disable_surveys: true,
        disable_external_dependency_loading: true,
      });

      posthog.identify(status.installId);
      initialized = true;
    } catch {
      // Silently ignore — telemetry should never break the app
    } finally {
      // If this attempt ended up as a no-op (disabled / not configured / failed),
      // allow a later caller to retry within the same app session.
      if (!initialized) {
        initPromise = null;
      }
    }
  })();

  return initPromise;
}

/**
 * Track a UI event. No-op if telemetry is not initialized.
 */
export function trackEvent(event: string, properties?: Record<string, unknown>): void {
  if (!initialized) return;
  try {
    posthog.capture(event, { ...properties, $lib: 'coredoc-desktop' });
  } catch {
    // Silently ignore
  }
}

/**
 * Hook to track page views on route changes. The first effect fires on
 * mount, at which point `initTelemetry` is usually still in flight — so
 * we await the init promise before capturing. On subsequent navigations
 * the promise is already resolved and the await is a microtask.
 */
export function usePageView(): void {
  const location = useLocation();

  useEffect(() => {
    let cancelled = false;
    const pathname = location.pathname;
    void initTelemetry().then(() => {
      if (cancelled || !initialized) return;
      try {
        posthog.capture('$pageview', { $current_url: pathname });
      } catch {
        // Silently ignore
      }
    });
    return () => {
      // Avoid capturing a pageview for a path we already navigated away from
      // (rapid route changes while init is still pending).
      cancelled = true;
    };
  }, [location.pathname]);
}

/**
 * Disable telemetry — clears identity and stops further capture.
 * posthog-js has no synchronous shutdown; reset() clears local state and
 * setting opt_out prevents subsequent capture() calls from sending events.
 */
export function shutdownTelemetry(): void {
  if (!initialized) return;
  try {
    posthog.opt_out_capturing();
    posthog.reset();
    initialized = false;
    // Drop the cached promise so a subsequent `Enable telemetry` toggle
    // can re-run initTelemetry() from scratch.
    initPromise = null;
  } catch {
    // Ignore
  }
}
