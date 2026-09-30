/**
 * The manifest/artifact vocabulary lives in `libs/pipeline/` because the push
 * pipeline quartet (push, jobs, job-queue, graph-snapshot) all speak it and a
 * contract must not be owned by one of its speakers.
 * Re-exported here so the graph-snapshot module's own imports stay unchanged.
 */
export * from '../../libs/pipeline/graph-snapshot.types.js';
