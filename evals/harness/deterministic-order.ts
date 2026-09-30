/**
 * Locale-independent UTF-16 code-unit ordering for material hashes and cohort identity.
 *
 * Re-exported from `@coredoc/core/utils` rather than re-implemented: this is a determinism
 * primitive, and the run identity it feeds (cohortId, manifestHash) must be byte-identical to
 * what the rest of the codebase produces. The harness keeps its own module path so existing
 * imports are unchanged.
 */
export { compareCodeUnits } from '@coredoc/core/utils';
