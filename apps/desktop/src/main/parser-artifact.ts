/**
 * Parser-artifact resolution (main process).
 *
 * A repo's parser is now a declarative `profile.ts` (applied by the generic
 * @coredoc/profile-parser engine), with the legacy imperative `parser.ts` still
 * accepted as a fallback. This mirrors the CLI's `loadParser` resolution
 * (packages/cli/src/parser-loader.ts) — profile.ts is preferred, parser.ts is legacy.
 *
 * Every place that decides "does this repo have a parser?" or needs the parser
 * file to hash/upload MUST go through here, so the desktop and the CLI agree on
 * which artifact is canonical.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { parserDir } from '@coredoc/core/utils';

export const PROFILE_FILENAME = 'profile.ts';

/**
 * Absolute path to a repo's parser artifact — `profile.ts` if present, else a
 * legacy `parser.ts`, else `undefined` when neither exists.
 */
export function resolveParserArtifactPath(
  parserStorage: string,
  projectId: string,
  repoName: string,
): string | undefined {
  const dir = parserDir(parserStorage, projectId, repoName);
  const profilePath = join(dir, PROFILE_FILENAME);
  if (existsSync(profilePath)) return profilePath;
  return undefined;
}

/** The canonical location a profile should be written to (whether or not it exists yet). */
export function profileArtifactPath(parserStorage: string, projectId: string, repoName: string): string {
  return join(parserDir(parserStorage, projectId, repoName), PROFILE_FILENAME);
}

/** True when the repo has a parser artifact (profile.ts or legacy parser.ts). */
export function hasParserArtifact(parserStorage: string, projectId: string, repoName: string): boolean {
  return resolveParserArtifactPath(parserStorage, projectId, repoName) !== undefined;
}
