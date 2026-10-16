/**
 * @coredoc/cli SDK — Programmatic API for CLI operations.
 *
 * Use this instead of spawning CLI subprocesses.
 * All functions throw on failure (never call process.exit).
 */

export { loadConfig } from '@coredoc/core/utils';
export { parse } from './parse.js';
export type { ParseOptions, ParseResult } from './parse.js';
export { getOpsTimestamps, readOpsTimestamps } from './ops.js';
export { redactNames } from '../operations-tracker.js';
export type { OpsTimestamps, OpsGitRevision } from './ops.js';
export { runResolveCore } from './resolve.js';
export type { ResolveOptions, ResolveResult } from './resolve.js';

// Re-export existing functions that are already proper programmatic APIs
export { runSummarize } from '../summarize/index.js';
export type { SummarizeOptions } from '../summarize/index.js';
export { runEmbed } from '../embed/index.js';
export type { EmbedOptions } from '../embed/index.js';
export { runUnifiedPush } from '../push/unified.js';
