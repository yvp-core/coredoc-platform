#!/usr/bin/env node
// Compatibility entrypoint only. Telemetry ownership moved to Coredoc Desktop
// and coredoc-workflows so this legacy plugin must not touch cloud credentials
// or Claude's generic environment.
import { provisionTelemetry } from './lib/provision.mjs';

async function main() {
  const result = await provisionTelemetry();
  console.error(`coredoc setup: ${result.message}`);
  process.exitCode = 2;
}

main().catch(() => {
  console.error('coredoc setup: Telemetry provisioning is unavailable in the legacy coredoc plugin.');
  process.exitCode = 1;
});
