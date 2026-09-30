import type { ExtractionProfile } from '@coredoc/profile-parser';

/**
 * Extraction profile for the intent-eval fixture repo (`evals/cases-intent/fixture-repo`).
 *
 * Deliberately bare: the fixture is plain TypeScript with no framework, so the
 * substrate defaults produce everything the eval anchors against — file, class
 * and function nodes with `properties.versionedId`. Adding entrypoint/entity
 * primitives here would describe conventions this repo does not have.
 */
const profile: ExtractionProfile = {
  parserId: 'intent-eval/fixture-repo',
  repoType: 'backend',
  substrate: {
    language: 'ts',
    include: ['src/**/*.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
  callGraph: {
    resolveThis: true,
    resolveDI: true,
  },
};

export default profile;
