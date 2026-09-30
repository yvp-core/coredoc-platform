import { defineConfig } from 'vitest/config';

// The package's default vitest.config.ts includes only `src/**/*.test.ts`; this
// override lets the Phase-0 probe normalizer test (which lives next to the probe
// script, not under src/, because the probe is not production code) run via:
//   npx vitest run --config scripts/vitest.scripts.config.ts
export default defineConfig({ test: { include: ['scripts/**/*.test.ts'] } });
