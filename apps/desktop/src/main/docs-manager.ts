/**
 * Docs Manager - Lists generated documentation files
 */

import { app, IpcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { getCurrentConfig, getConfigDir } from './config-manager.js';
import { docsDir as docsDirHelper } from '@coredoc/core/utils';
import type { DocFileInfo, DocsListResult } from '../shared/ipc-types.js';

const ROOT_FILE_TITLES: Record<string, string> = {
  'README.md': 'README',
  'DEEP_ANALYSIS.md': 'Deep Analysis',
  'service-overview.md': 'Service Overview',
};

const DATABASE_FILE_TITLES: Record<string, string> = {
  'erd.md': 'Entity Relationship Diagram',
};

function getOutputDir(): string | null {
  const config = getCurrentConfig();
  const configDir = getConfigDir();
  if (!config || !configDir) return null;
  return path.resolve(configDir, config.output.dir);
}

function getCloudDocsDir(workspaceId: string): string {
  return path.join(app.getPath('userData'), 'cloud-docs', workspaceId);
}

function humanizeFilename(filename: string): string {
  return filename
    .replace(/\.md$/, '')
    .replace(/[_-]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Normalize path separators to forward slashes for consistent matching */
function normalizeSep(p: string): string {
  return p.replace(/\\/g, '/');
}

function getTitle(relativePath: string): string {
  const normalized = normalizeSep(relativePath);
  const filename = path.basename(relativePath);

  // Root-level files
  if (!normalized.includes('/') || normalized.indexOf('/') === normalized.length - 1) {
    if (ROOT_FILE_TITLES[filename]) return ROOT_FILE_TITLES[filename];
  }

  // Database files
  if (normalized.startsWith('database/')) {
    if (DATABASE_FILE_TITLES[filename]) return DATABASE_FILE_TITLES[filename];
  }

  // Fallback
  return humanizeFilename(filename);
}

function getCategory(relativePath: string): string {
  const normalized = normalizeSep(relativePath);
  if (normalized.startsWith('database/')) return 'database';
  const filename = path.basename(relativePath);
  if (
    filename === 'README.md' ||
    filename === 'DEEP_ANALYSIS.md' ||
    filename === 'service-overview.md' ||
    filename === 'hl_overview.md'
  ) {
    return 'overview';
  }
  return 'analysis';
}

function extractFrontmatter(content: string): { generatedAt?: string; contentHash?: string; prompt?: string } {
  if (!content.startsWith('---\n')) return {};

  const endIdx = content.indexOf('\n---\n', 4);
  if (endIdx === -1) return {};

  const frontmatter = content.slice(4, endIdx);
  const result: { generatedAt?: string; contentHash?: string; prompt?: string } = {};

  const promptMatch = frontmatter.match(/^prompt:\s*(.+)$/m);
  if (promptMatch) result.prompt = promptMatch[1].trim();

  const genMatch = frontmatter.match(/^generatedAt:\s*(.+)$/m);
  if (genMatch) result.generatedAt = genMatch[1].trim();

  const hashMatch = frontmatter.match(/^contentHash:\s*(.+)$/m);
  if (hashMatch) result.contentHash = hashMatch[1].trim();

  return result;
}

function walkDir(dir: string, baseDir: string): { relativePath: string; fullPath: string }[] {
  const results: { relativePath: string; fullPath: string }[] = [];

  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip .repo-data directory
      if (entry.name === '.repo-data') continue;
      results.push(...walkDir(fullPath, baseDir));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push({
        relativePath: path.relative(baseDir, fullPath),
        fullPath,
      });
    }
  }

  return results;
}

function sortDocs(docs: DocFileInfo[]): DocFileInfo[] {
  const categoryOrder: Record<string, number> = { overview: 0, analysis: 1, database: 2 };
  return docs.sort((a, b) => {
    const catA = categoryOrder[a.category] ?? 1;
    const catB = categoryOrder[b.category] ?? 1;
    if (catA !== catB) return catA - catB;
    return a.title.localeCompare(b.title);
  });
}

export function listDocs(projectId: string, repoNames: string[], workspaceId?: string): DocsListResult {
  try {
    const allDocs: DocFileInfo[] = [];

    // Scan local output dir (non-cloud)
    const outputDir = getOutputDir();
    if (!workspaceId && !outputDir) {
      return { success: false, error: 'No config loaded' };
    }

    // Determine base directories to scan — cloud-only when workspaceId is set
    const baseDirs: { baseDir: string; idPrefix: string; useProjectScoping: boolean }[] = [];
    if (workspaceId) {
      baseDirs.push({
        baseDir: getCloudDocsDir(workspaceId),
        idPrefix: `cloud:${workspaceId}:`,
        useProjectScoping: false,
      });
    } else if (outputDir) {
      baseDirs.push({ baseDir: outputDir, idPrefix: '', useProjectScoping: true });
    }

    for (const { baseDir, idPrefix, useProjectScoping } of baseDirs) {
      for (const repoName of repoNames) {
        const repoDocsDir = useProjectScoping
          ? docsDirHelper(baseDir, projectId, repoName)
          : path.join(baseDir, `${repoName}-docs`);
        const files = walkDir(repoDocsDir, repoDocsDir);

        for (const { relativePath, fullPath } of files) {
          const stat = fs.statSync(fullPath);
          const head = fs.readFileSync(fullPath, 'utf-8').slice(0, 4096);
          const { generatedAt, contentHash, prompt } = extractFrontmatter(head);

          allDocs.push({
            id: `${idPrefix}${repoName}:${relativePath}`,
            repoName,
            title: getTitle(relativePath),
            relativePath,
            promptName: prompt,
            category: getCategory(relativePath),
            generatedAt,
            contentHash,
            sizeBytes: stat.size,
          });
        }
      }
    }

    return { success: true, docs: sortDocs(allDocs) };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error listing docs',
    };
  }
}

export function registerDocsHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('docs:list', (_event, projectId: string, repoNames: string[], workspaceId?: string) =>
    listDocs(projectId, repoNames, workspaceId),
  );
}
