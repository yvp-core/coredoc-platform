/**
 * Docs Manager - Handles listing and reading generated documentation files
 */

import { app, IpcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { getCurrentConfig, getConfigDir } from './config-manager.js';
import { docsDir as docsDirHelper } from '@coredoc/core/utils';
import type {
  DocFileInfo,
  DocsListResult,
  DocContentResult,
  DocsPromptOption,
  DocsPromptCatalogResult,
} from '../shared/ipc-types.js';

interface PromptDagEntry {
  name: string;
  dependencies: string[];
  templatePath: string;
  domain?: 'mobile' | 'blockchain';
}

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

function getDefaultDagPath(): string | null {
  // The bundled prompts-DAG shipped with @coredoc/docs-gen, removed in the profile-parser
  // reseed. With no default catalog, callers fall back to an empty prompt list; doc viewing
  // (list/read generated markdown) is unaffected.
  return null;
}

function resolveDagPath(dagPath?: string): string | null {
  if (!dagPath) {
    return getDefaultDagPath();
  }

  const resolvedPath = path.resolve(dagPath);
  if (!fs.existsSync(resolvedPath)) {
    return null;
  }

  const stat = fs.statSync(resolvedPath);
  if (stat.isDirectory()) {
    const nestedDagPath = path.join(resolvedPath, 'prompts-dag.json');
    return fs.existsSync(nestedDagPath) ? nestedDagPath : null;
  }

  return resolvedPath;
}

function humanizePromptName(promptName: string): string {
  if (/[A-Z]{2,}/.test(promptName) && !promptName.includes('_') && !promptName.includes('-')) {
    return promptName;
  }
  return promptName.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function getPromptCategory(templatePath: string, domain?: 'mobile' | 'blockchain'): string {
  if (domain === 'mobile') return 'Mobile';
  if (domain === 'blockchain') return 'Blockchain';

  const normalized = normalizeSep(templatePath);
  const folder = normalized.split('/')[0];
  if (!folder) return 'Shared';
  if (folder === 'shared') return 'Shared';
  return humanizeFilename(folder);
}

function loadPromptCatalog(dagPath?: string): {
  prompts: DocsPromptOption[];
  promptLabelMap: Map<string, string>;
  sourceDagPath?: string;
} {
  const resolvedDagPath = resolveDagPath(dagPath);
  if (!resolvedDagPath) {
    return { prompts: [], promptLabelMap: new Map() };
  }

  try {
    const raw = fs.readFileSync(resolvedDagPath, 'utf-8');
    const parsed = JSON.parse(raw) as { prompts?: PromptDagEntry[] };
    const entries = Array.isArray(parsed.prompts) ? parsed.prompts : [];

    const prompts: DocsPromptOption[] = entries
      .filter((entry) => typeof entry?.name === 'string' && entry.name.length > 0)
      .map((entry) => ({
        prompt: entry.name,
        label: humanizePromptName(entry.name),
        category: getPromptCategory(entry.templatePath, entry.domain),
        domain: entry.domain,
      }));

    const promptLabelMap = new Map(prompts.map((p) => [p.prompt, p.label]));

    return {
      prompts,
      promptLabelMap,
      sourceDagPath: resolvedDagPath,
    };
  } catch {
    return { prompts: [], promptLabelMap: new Map() };
  }
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

function getTitle(relativePath: string, promptName: string | undefined, promptLabelMap: Map<string, string>): string {
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

  // Analysis files - use prompt labels from DAG when available.
  if (promptName && promptLabelMap.has(promptName)) {
    return promptLabelMap.get(promptName)!;
  }

  const stem = filename.replace(/\.md$/, '');
  if (promptLabelMap.has(stem)) {
    return promptLabelMap.get(stem)!;
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

function stripFrontmatter(content: string): string {
  if (!content.startsWith('---\n')) return content;

  const endIdx = content.indexOf('\n---\n', 4);
  if (endIdx === -1) return content;

  return content.slice(endIdx + 5);
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

export function listDocs(
  projectId: string,
  repoNames: string[],
  dagPath?: string,
  workspaceId?: string,
): DocsListResult {
  try {
    const { promptLabelMap } = loadPromptCatalog(dagPath);
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
          const stem = path.basename(relativePath).replace(/\.md$/, '');
          const promptName = prompt || (promptLabelMap.has(stem) ? stem : undefined);

          allDocs.push({
            id: `${idPrefix}${repoName}:${relativePath}`,
            repoName,
            title: getTitle(relativePath, promptName, promptLabelMap),
            relativePath,
            promptName,
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

export function listDocsPrompts(dagPath?: string): DocsPromptCatalogResult {
  try {
    const { prompts, sourceDagPath } = loadPromptCatalog(dagPath);
    return {
      success: true,
      prompts,
      sourceDagPath,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error loading prompt catalog',
    };
  }
}

export function readDoc(
  projectId: string,
  repoName: string,
  relativePath: string,
  workspaceId?: string,
): DocContentResult {
  try {
    // Try cloud docs first if workspaceId provided
    let repoDocsDir: string;
    if (workspaceId) {
      repoDocsDir = path.join(getCloudDocsDir(workspaceId), `${repoName}-docs`);
    } else {
      const outputDir = getOutputDir();
      if (!outputDir) {
        return { success: false, error: 'No config loaded' };
      }
      repoDocsDir = docsDirHelper(outputDir, projectId, repoName);
    }

    const filePath = path.join(repoDocsDir, relativePath);

    // Path traversal protection: append separator to prevent sibling dir bypass
    const resolvedBase = path.resolve(repoDocsDir) + path.sep;
    const resolvedFile = path.resolve(filePath);
    if (!resolvedFile.startsWith(resolvedBase)) {
      return { success: false, error: 'Invalid path' };
    }

    if (!fs.existsSync(filePath)) {
      return { success: false, error: `File not found: ${relativePath}` };
    }

    const raw = fs.readFileSync(filePath, 'utf-8');
    const content = stripFrontmatter(raw);

    return { success: true, content };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error reading doc',
    };
  }
}

export function deleteDoc(
  projectId: string,
  repoName: string,
  relativePath: string,
  workspaceId?: string,
): { success: boolean; error?: string } {
  try {
    let repoDocsDir: string;
    if (workspaceId) {
      repoDocsDir = path.join(getCloudDocsDir(workspaceId), `${repoName}-docs`);
    } else {
      const outputDir = getOutputDir();
      if (!outputDir) {
        return { success: false, error: 'No config loaded' };
      }
      repoDocsDir = docsDirHelper(outputDir, projectId, repoName);
    }
    const filePath = path.join(repoDocsDir, relativePath);

    if (!fs.existsSync(filePath)) {
      return { success: false, error: `File not found: ${relativePath}` };
    }

    // Path traversal protection: resolve real paths to defeat symlink attacks
    const resolvedBase = fs.realpathSync(repoDocsDir) + path.sep;
    const resolvedFile = fs.realpathSync(filePath);
    if (!resolvedFile.startsWith(resolvedBase)) {
      return { success: false, error: 'Invalid path' };
    }

    // Ensure target is a regular file (not a symlink to outside)
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile()) {
      return { success: false, error: 'Invalid path' };
    }

    fs.unlinkSync(filePath);

    return { success: true };
  } catch (error) {
    console.error('[Main] Error deleting doc');
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error deleting doc',
    };
  }
}

export function registerDocsHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(
    'docs:list',
    (_event, projectId: string, repoNames: string[], dagPath?: string, workspaceId?: string) =>
      listDocs(projectId, repoNames, dagPath, workspaceId),
  );
  ipcMain.handle(
    'docs:read',
    (_event, projectId: string, repoName: string, relativePath: string, workspaceId?: string) =>
      readDoc(projectId, repoName, relativePath, workspaceId),
  );
  ipcMain.handle(
    'docs:delete',
    (_event, projectId: string, repoName: string, relativePath: string, workspaceId?: string) =>
      deleteDoc(projectId, repoName, relativePath, workspaceId),
  );
  ipcMain.handle('docs:prompts', (_event, dagPath?: string) => listDocsPrompts(dagPath));
}
