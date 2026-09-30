import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../..');
const SERVER_READ_SURFACES = [
  resolve(HERE, 'workspace-mcp-context.service.ts'),
  resolve(HERE, 'tools/base-tool.ts'),
  resolve(REPO_ROOT, 'apps/server/src/modules/graph/graph.service.ts'),
];

function productionTypescriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') files.push(...productionTypescriptFiles(path));
    } else if (extname(entry.name) === '.ts' && !entry.name.endsWith('.test.ts')) {
      files.push(path);
    }
  }
  return files;
}

describe('read-path capability boundary', () => {
  it('keeps cloud read consumers on IGraphReadRepository and callback context APIs', () => {
    for (const path of SERVER_READ_SURFACES) {
      const source = readFileSync(path, 'utf8');
      expect(source, path).not.toMatch(/\bIGraphRepository\b/);
      expect(source, path).not.toMatch(/\b(?:this\.)?(?:wsContext|workspaceContext)\.resolve(?:ByWorkspaceId)?\s*\(/);
    }
  });

  it('keeps portable MCP production readers independent of graph write capability', () => {
    const files = productionTypescriptFiles(resolve(REPO_ROOT, 'packages/mcp/src'));
    const offenders = files.filter((path) => /\bIGraphRepository\b/.test(readFileSync(path, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
