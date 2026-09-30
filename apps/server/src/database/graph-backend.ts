import { GraphSnapshotError } from '../libs/pipeline/graph-snapshot.errors.js';

/**
 * The graph data plane a workspace reads and writes.
 * `Turso` is the deprecated legacy backend; `FileSnapshot` (Ladybug files on R2)
 * is the default for new workspaces.
 */
export enum GraphBackend {
  Turso = 'turso',
  FileSnapshot = 'file_snapshot',
}

/**
 * The one owner of `Workspace.graphBackend` validation. An absent value mirrors
 * the Prisma column default and resolves to `FileSnapshot` — never to the
 * deprecated Turso plane. Anything outside the enum fails fast as
 * `graph_backend_conflict` (409, non-retryable), which is what every call site
 * already threw for an unknown value.
 *
 * Retiring Turso later is a find-usages of `GraphBackend.Turso`, not a grep for a string.
 */
export function resolveGraphBackend(workspace: { graphBackend?: string | null }): GraphBackend {
  const raw = workspace.graphBackend;
  if (raw === undefined || raw === null) return GraphBackend.FileSnapshot;
  if (raw === GraphBackend.FileSnapshot) return GraphBackend.FileSnapshot;
  if (raw === GraphBackend.Turso) return GraphBackend.Turso;
  throw new GraphSnapshotError('graph_backend_conflict', `Unsupported graph backend: ${raw}`);
}
