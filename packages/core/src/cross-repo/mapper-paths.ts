import * as path from 'path';

export interface MapperPaths {
  mapperJson: string;
  mapperMeta: string;
  backup: string;
}

const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * Reject projectIds that could escape the parser storage root via path
 * traversal (e.g. `../../etc`) or contain separators that would split the
 * conventional `<root>/<projectId>/mapper.json` layout. Throws — every writer
 * of mapper artifacts must call this before joining the id into a path.
 */
export function assertSafeProjectId(projectId: string): void {
  if (!PROJECT_ID_PATTERN.test(projectId) || path.basename(projectId) !== projectId) {
    throw new Error(
      `Invalid projectId '${projectId}': must match ${PROJECT_ID_PATTERN.source} and contain no path separators`,
    );
  }
}

/**
 * Resolve the conventional locations of mapper artifacts for a given project.
 *
 * Layout: `<parsersRoot>/<projectId>/{mapper.json, mapper.meta.json, .mapper.json.bak}`
 *
 * Pure path math — does not touch the filesystem. Validates projectId to
 * prevent traversal at the boundary so every downstream writer is safe.
 */
export function mapperPathsForProject(parsersRoot: string, projectId: string): MapperPaths {
  assertSafeProjectId(projectId);
  const dir = path.join(parsersRoot, projectId);
  return {
    mapperJson: path.join(dir, 'mapper.json'),
    mapperMeta: path.join(dir, 'mapper.meta.json'),
    backup: path.join(dir, '.mapper.json.bak'),
  };
}
