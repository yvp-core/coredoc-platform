/**
 * The error type itself lives in `libs/pipeline/` because non-feature leaves
 * throw it too (`database/graph-backend.ts`, `libs/global-exception.filter.ts`)
 * and a leaf must not depend on a feature module.
 * Re-exported here so the graph-snapshot module's own imports stay unchanged.
 */
export * from '../../libs/pipeline/graph-snapshot.errors.js';
