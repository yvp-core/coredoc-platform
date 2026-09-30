#!/usr/bin/env node
// Kept as an inert compatibility target for installations whose cached
// manifest still invokes it. Current manifests do not register this hook.
import { TELEMETRY_UNAVAILABLE_MESSAGE } from './lib/provision.mjs';

export function telemetryAutoConfigurationStatus() {
  return { outcome: 'unavailable', message: TELEMETRY_UNAVAILABLE_MESSAGE };
}

// Intentionally silent and successful if an older cached manifest invokes it
// during SessionStart. It must never read credentials or modify host settings.
