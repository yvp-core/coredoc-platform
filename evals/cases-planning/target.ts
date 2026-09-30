// evals/cases-planning/target.ts
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectDbUrl } from '@coredoc/core/utils';
import type { PlanningTarget } from '../harness/planning-types.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..'); // coredoc-parser repo root

/**
 * Graph databases are per project, so the scope and the database must name the
 * same project — derive both from one constant rather than letting them drift
 * (a mismatched pair reads an empty database and scores every task zero, which
 * looks exactly like a model regression).
 */
const PROJECT_ID = process.env.COREDOC_EVAL_PROJECT ?? 'acme';

export const planningTarget: PlanningTarget = {
  // Common parent directory holding the workspace's repo checkouts.
  workspaceRoot: process.env.COREDOC_EVAL_WORKSPACE_ROOT ?? resolve(repoRoot, '..'),
  dbUrl: projectDbUrl(repoRoot, PROJECT_ID),
  mcpConfigPath: join(repoRoot, 'coredoc.config.json'),
  mcpServerCommand: join(repoRoot, 'packages', 'mcp', 'dist', 'index.js'),
  scope: `project:${PROJECT_ID}`,
};
