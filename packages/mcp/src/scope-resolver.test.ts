/**
 * Tests for the Scope Resolver module
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  generateRepoHash,
  loadConfig,
  resolveScope,
  buildRepoHashFilter,
  getScopeDescription,
  resolveVantageRepo,
  type ScopeContext,
} from './scope-resolver.js';
import type { CoredocConfig } from '@coredoc/core/types';
import { repoRefKey } from '@coredoc/core/utils';

describe('Scope Resolver', () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(() => {
    // Create temporary directory for test configs
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-resolver-test-'));
  });

  afterEach(() => {
    // Clean up temporary directory
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    // Clean up environment variable
    delete process.env.MCP_CONFIG_PATH;
  });

  // ===========================================================================
  // Repo Hash Generation
  // ===========================================================================

  describe('generateRepoHash', () => {
    it('should generate 12-character hex hash', () => {
      const hash = generateRepoHash('/path/to/repo');

      expect(hash).toHaveLength(12);
      expect(hash).toMatch(/^[0-9a-f]{12}$/);
    });

    it('should generate consistent hashes for same path', () => {
      const path1 = '/path/to/repo';
      const hash1 = generateRepoHash(path1);
      const hash2 = generateRepoHash(path1);

      expect(hash1).toBe(hash2);
    });

    it('should generate different hashes for different paths', () => {
      const hash1 = generateRepoHash('/path/to/repo1');
      const hash2 = generateRepoHash('/path/to/repo2');

      expect(hash1).not.toBe(hash2);
    });

    it('should handle absolute paths consistently', () => {
      const relativePath = 'some/relative/path';
      const absolutePath = path.resolve(relativePath);
      const hash1 = generateRepoHash(relativePath);
      const hash2 = generateRepoHash(absolutePath);

      // Different representations should produce different hashes
      // (generateRepoHash doesn't normalize paths)
      expect(hash1).not.toBe(hash2);
    });
  });

  // ===========================================================================
  // Config Loading
  // ===========================================================================

  describe('loadConfig', () => {
    it('should load and parse valid config', () => {
      const config: CoredocConfig = {
        version: '2.0',
        projects: [
          {
            id: 'default',
            name: 'Default',
            repos: [
              { name: 'service1', path: './service1', type: 'backend' },
              { name: 'service2', path: './service2', type: 'backend' },
            ],
          },
        ],
        output: { dir: './output', format: 'json' },
        parserStorage: './parsers',
        agentMode: 'interactive',
      };

      configPath = path.join(tempDir, 'coredoc.config.json');
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

      const result = loadConfig(configPath);

      expect(result.version).toBe('2.0');
      expect(result.projects[0].repos).toHaveLength(2);
      expect(result.configPath).toBe(configPath);
      expect(result.configDir).toBe(tempDir);
    });

    it('should resolve repo paths relative to config directory', () => {
      const config: CoredocConfig = {
        version: '2.0',
        projects: [
          {
            id: 'default',
            name: 'Default',
            repos: [
              { name: 'service1', path: './service1', type: 'backend' },
              { name: 'service2', path: '../other/service2', type: 'backend' },
            ],
          },
        ],
        output: { dir: './output', format: 'json' },
        parserStorage: './parsers',
        agentMode: 'interactive',
      };

      configPath = path.join(tempDir, 'coredoc.config.json');
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

      const result = loadConfig(configPath);

      expect(result.resolvedRepoPaths.get(repoRefKey('default', 'service1'))).toBe(path.resolve(tempDir, 'service1'));
      expect(result.resolvedRepoPaths.get(repoRefKey('default', 'service2'))).toBe(
        path.resolve(tempDir, '../other/service2'),
      );
    });

    it('should resolve output and parser storage paths', () => {
      const config: CoredocConfig = {
        version: '2.0',
        projects: [
          {
            id: 'default',
            name: 'Default',
            repos: [{ name: 'service1', path: './service1', type: 'backend' }],
          },
        ],
        output: { dir: './output', format: 'json' },
        parserStorage: './parsers',
        agentMode: 'interactive',
      };

      configPath = path.join(tempDir, 'coredoc.config.json');
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

      const result = loadConfig(configPath);

      expect(result.resolvedOutputDir).toBe(path.resolve(tempDir, 'output'));
      expect(result.resolvedParserStorage).toBe(path.resolve(tempDir, 'parsers'));
    });

    it('should throw error if config file does not exist', () => {
      const nonExistentPath = path.join(tempDir, 'nonexistent.json');

      expect(() => loadConfig(nonExistentPath)).toThrow(`Config file not found: ${nonExistentPath}`);
    });

    it('should throw error if config JSON is invalid', () => {
      configPath = path.join(tempDir, 'invalid.json');
      fs.writeFileSync(configPath, '{ invalid json }');

      expect(() => loadConfig(configPath)).toThrow();
    });

    it('should handle absolute repo paths', () => {
      const absolutePath = path.join(tempDir, 'absolute-repo');
      const config: CoredocConfig = {
        version: '2.0',
        projects: [
          {
            id: 'default',
            name: 'Default',
            repos: [{ name: 'service1', path: absolutePath, type: 'backend' }],
          },
        ],
        output: { dir: './output', format: 'json' },
        parserStorage: './parsers',
        agentMode: 'interactive',
      };

      configPath = path.join(tempDir, 'coredoc.config.json');
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

      const result = loadConfig(configPath);

      expect(result.resolvedRepoPaths.get(repoRefKey('default', 'service1'))).toBe(absolutePath);
    });
  });

  // ===========================================================================
  // Scope Resolution
  // ===========================================================================

  describe('resolveScope', () => {
    beforeEach(() => {
      // Create test repo directories
      const service1Path = path.join(tempDir, 'service1');
      const service2Path = path.join(tempDir, 'service2');
      const service3Path = path.join(tempDir, 'service3');

      fs.mkdirSync(service1Path, { recursive: true });
      fs.mkdirSync(service2Path, { recursive: true });
      fs.mkdirSync(service3Path, { recursive: true });

      // Create config
      const config: CoredocConfig = {
        version: '2.0',
        projects: [
          {
            id: 'main',
            name: 'main',
            repos: [
              { name: 'service1', path: './service1', type: 'backend' },
              { name: 'service2', path: './service2', type: 'backend' },
            ],
          },
          {
            id: 'other',
            name: 'other',
            repos: [{ name: 'service3', path: './service3', type: 'backend' }],
          },
        ],
        output: { dir: './output', format: 'json' },
        parserStorage: './parsers',
        agentMode: 'interactive',
      };

      configPath = path.join(tempDir, 'coredoc.config.json');
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    });

    it('should resolve scope for path inside repo', () => {
      const workspacePath = path.join(tempDir, 'service1', 'src', 'index.ts');
      const result = resolveScope(workspacePath, { configPath });

      expect(result.success).toBe(true);
      expect(result.scope.resolvedRepos).toContain('service1');
      expect(result.scope.project).toBe('main');
      expect(result.scope.projectId).toBe('main');
    });

    it('should resolve scope for repo root path', () => {
      const workspacePath = path.join(tempDir, 'service2');
      const result = resolveScope(workspacePath, { configPath });

      expect(result.success).toBe(true);
      expect(result.scope.resolvedRepos).toContain('service2');
    });

    it('should include project repos when cross-repo enabled', () => {
      const workspacePath = path.join(tempDir, 'service1');
      const result = resolveScope(workspacePath, {
        configPath,
        includeCrossRepo: true,
      });

      expect(result.success).toBe(true);
      expect(result.scope.resolvedRepos).toContain('service1');
      expect(result.scope.resolvedRepos).toContain('service2');
      expect(result.scope.resolvedRepos).not.toContain('service3');
      expect(result.scope.crossRepoEnabled).toBe(true);
    });

    it('should exclude project repos when cross-repo disabled', () => {
      const workspacePath = path.join(tempDir, 'service1');
      const result = resolveScope(workspacePath, {
        configPath,
        includeCrossRepo: false,
      });

      expect(result.success).toBe(true);
      expect(result.scope.resolvedRepos).toHaveLength(1);
      expect(result.scope.resolvedRepos).toContain('service1');
      expect(result.scope.crossRepoEnabled).toBe(false);
    });

    it('should generate repo hashes for matched repos', () => {
      const workspacePath = path.join(tempDir, 'service1');
      const result = resolveScope(workspacePath, { configPath });

      expect(result.success).toBe(true);
      expect(result.scope.repoHashes.length).toBeGreaterThan(0);
      result.scope.repoHashes.forEach((hash) => {
        expect(hash).toMatch(/^[0-9a-f]{12}$/);
      });
    });

    it('should fail when config not found', () => {
      const workspacePath = path.join('/some/random/path');
      const result = resolveScope(workspacePath);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Could not find coredoc.config.json');
    });

    it('should fail when workspace path does not match any repo', () => {
      const workspacePath = path.join(tempDir, 'nonexistent-service');
      const result = resolveScope(workspacePath, { configPath });

      expect(result.success).toBe(false);
      expect(result.error).toContain('does not match any configured repository');
      expect(result.scope.resolvedRepos).toHaveLength(0);
    });

    it('should use MCP_CONFIG_PATH environment variable', () => {
      process.env.MCP_CONFIG_PATH = configPath;

      const workspacePath = path.join(tempDir, 'service1');
      const result = resolveScope(workspacePath);

      expect(result.success).toBe(true);
      expect(result.scope.resolvedRepos).toContain('service1');
    });

    it('should search up directory tree for config', () => {
      const nestedPath = path.join(tempDir, 'service1', 'src', 'controllers');
      fs.mkdirSync(nestedPath, { recursive: true });

      const result = resolveScope(nestedPath);

      expect(result.success).toBe(true);
      expect(result.scope.resolvedRepos).toContain('service1');
    });

    it('should fallback to matching by repo name in path', () => {
      // Use a path that doesn't actually exist but has a repo name
      const workspacePath = path.join('/some/other/location', 'service2');
      const result = resolveScope(workspacePath, { configPath });

      expect(result.success).toBe(true);
      expect(result.scope.resolvedRepos).toContain('service2');
    });

    it('should resolve a bare repo name string to the configured repo', () => {
      // Agents call `describe_repository({scope: "service2"})` with a name, not
      // a path. Previously this got cwd-relative path-resolved and the prefix
      // check matched whichever repo owned cwd. The bare-name branch resolves
      // it cleanly against the config instead.
      const result = resolveScope('service2', { configPath });
      expect(result.success).toBe(true);
      expect(result.scope.resolvedRepos).toEqual(['service2']);
      expect(result.scope.project).toBe('main');
    });

    it('should return explicit unknown-scope error for a bare name with no match', () => {
      // The regression seen in the 2026-05-12 eval: scope="server-api" (a
      // service name, not a configured repo) silently resolved to the cwd's
      // repo. Now it returns an actionable error listing the real repos.
      const result = resolveScope('server-api', { configPath });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown scope "server-api"');
      expect(result.error).toContain('service1');
      expect(result.error).toContain('service2');
      expect(result.error).toContain('service3');
    });

    it('should flag an ambiguous bare repo name across projects', () => {
      const ambigConfig: CoredocConfig = {
        version: '2.0',
        projects: [
          { id: 'a', name: 'a', repos: [{ name: 'shared', path: './shared-a', type: 'backend' }] },
          { id: 'b', name: 'b', repos: [{ name: 'shared', path: './shared-b', type: 'backend' }] },
        ],
        output: { dir: './output', format: 'json' },
        parserStorage: './parsers',
        agentMode: 'interactive',
      };
      const ambigConfigPath = path.join(tempDir, 'ambig-config.json');
      fs.writeFileSync(ambigConfigPath, JSON.stringify(ambigConfig, null, 2));
      const result = resolveScope('shared', { configPath: ambigConfigPath });
      expect(result.success).toBe(false);
      expect(result.error).toContain('ambiguous');
    });

    it('should resolve a globally-ambiguous bare name within the bound project', () => {
      // When the server is scoped to a project, a bare repo name that exists in
      // multiple projects must resolve within the bound project (matching what
      // describe_repository lists) instead of erroring as ambiguous.
      const ambigConfig: CoredocConfig = {
        version: '2.0',
        projects: [
          { id: 'a', name: 'a', repos: [{ name: 'shared', path: './shared-a', type: 'backend' }] },
          { id: 'b', name: 'b', repos: [{ name: 'shared', path: './shared-b', type: 'backend' }] },
        ],
        output: { dir: './output', format: 'json' },
        parserStorage: './parsers',
        agentMode: 'interactive',
      };
      const ambigConfigPath = path.join(tempDir, 'ambig-config-bound.json');
      fs.writeFileSync(ambigConfigPath, JSON.stringify(ambigConfig, null, 2));

      // Unbound → ambiguous (sanity).
      expect(resolveScope('shared', { configPath: ambigConfigPath }).success).toBe(false);

      // Bound to project b → resolves to b/shared.
      const loaded = loadConfig(ambigConfigPath);
      fs.writeFileSync(
        '/tmp/cfg21.json',
        JSON.stringify(
          {
            projects: loaded.projects.map((p) => ({ id: p.id, name: p.name, repos: p.repos.map((r) => r.name) })),
            fileOnDisk: JSON.parse(fs.readFileSync(ambigConfigPath, 'utf-8')),
          },
          null,
          2,
        ),
      );
      const result = resolveScope('shared', { configPath: ambigConfigPath, projectConstraint: 'b' });
      fs.writeFileSync('/tmp/r21.json', JSON.stringify(result, null, 2));
      expect(result.success, result.error).toBe(true);
      expect(result.scope.resolvedRepos).toEqual(['shared']);
      expect(result.scope.projectId).toBe('b');
    });

    it('should resolve a "project/repo" qualified scope to the single repo', () => {
      // Agents frequently address a repo as `project/repo` (mirrors how
      // describe_repository lists them). It resolves to exactly that repo.
      const result = resolveScope('main/service1', { configPath });
      expect(result.success).toBe(true);
      expect(result.scope.resolvedRepos).toEqual(['service1']);
      expect(result.scope.project).toBe('main');
      expect(result.scope.projectId).toBe('main');
      expect(result.scope.crossRepoEnabled).toBe(false);
    });

    it('should disambiguate a repo shared across projects via "project/repo"', () => {
      // Bare "shared" is ambiguous (see test above); the qualified form picks
      // the project explicitly.
      const ambigConfig: CoredocConfig = {
        version: '2.0',
        projects: [
          { id: 'a', name: 'a', repos: [{ name: 'shared', path: './shared-a', type: 'backend' }] },
          { id: 'b', name: 'b', repos: [{ name: 'shared', path: './shared-b', type: 'backend' }] },
        ],
        output: { dir: './output', format: 'json' },
        parserStorage: './parsers',
        agentMode: 'interactive',
      };
      const ambigConfigPath = path.join(tempDir, 'ambig-config-qualified.json');
      fs.writeFileSync(ambigConfigPath, JSON.stringify(ambigConfig, null, 2));

      const result = resolveScope('b/shared', { configPath: ambigConfigPath });
      expect(result.success).toBe(true);
      expect(result.scope.resolvedRepos).toEqual(['shared']);
      expect(result.scope.projectId).toBe('b');
    });

    it('should fall through to path resolution when "a/b" is not a real project/repo', () => {
      // Valid project, unknown repo segment → not the project/repo form; falls
      // through to the path/last-segment logic, which finds no match.
      const result = resolveScope('main/nonexistent', { configPath });
      expect(result.success).toBe(false);
    });

    it('should handle single-repo project', () => {
      const config: CoredocConfig = {
        version: '2.0',
        projects: [
          {
            id: 'solo',
            name: 'Solo',
            repos: [{ name: 'standalone', path: './standalone', type: 'backend' }],
          },
        ],
        output: { dir: './output', format: 'json' },
        parserStorage: './parsers',
        agentMode: 'interactive',
      };

      const standalonePath = path.join(tempDir, 'standalone');
      fs.mkdirSync(standalonePath, { recursive: true });

      const standaloneConfigPath = path.join(tempDir, 'standalone-config.json');
      fs.writeFileSync(standaloneConfigPath, JSON.stringify(config, null, 2));

      const workspacePath = path.join(tempDir, 'standalone');
      const result = resolveScope(workspacePath, { configPath: standaloneConfigPath });

      expect(result.success).toBe(true);
      expect(result.scope.resolvedRepos).toHaveLength(1);
      expect(result.scope.project).toBe('Solo');
      expect(result.scope.crossRepoEnabled).toBe(false);
    });

    it('should return empty scope on error', () => {
      const workspacePath = path.join(tempDir, 'nonexistent');
      const result = resolveScope(workspacePath, { configPath });

      expect(result.success).toBe(false);
      expect(result.scope.resolvedRepos).toHaveLength(0);
      expect(result.scope.repoHashes).toHaveLength(0);
      expect(result.scope.currentPath).toBe(path.resolve(workspacePath));
    });

    it('should handle multiple repos in same project', () => {
      const config: CoredocConfig = {
        version: '2.0',
        projects: [
          {
            id: 'platform',
            name: 'platform',
            repos: [
              { name: 'api', path: './api', type: 'backend' },
              { name: 'worker', path: './worker', type: 'backend' },
              { name: 'admin', path: './admin', type: 'backend' },
            ],
          },
        ],
        output: { dir: './output', format: 'json' },
        parserStorage: './parsers',
        agentMode: 'interactive',
      };

      const apiPath = path.join(tempDir, 'api');
      fs.mkdirSync(apiPath, { recursive: true });

      const multiGroupConfigPath = path.join(tempDir, 'multi-group.json');
      fs.writeFileSync(multiGroupConfigPath, JSON.stringify(config, null, 2));

      const workspacePath = apiPath;
      const result = resolveScope(workspacePath, {
        configPath: multiGroupConfigPath,
        includeCrossRepo: true,
      });

      expect(result.success).toBe(true);
      expect(result.scope.resolvedRepos).toHaveLength(3);
      expect(result.scope.resolvedRepos).toContain('api');
      expect(result.scope.resolvedRepos).toContain('worker');
      expect(result.scope.resolvedRepos).toContain('admin');
    });

    // =========================================================================
    // Project Narrowing Tests
    // =========================================================================

    describe('project narrowing', () => {
      it('should resolve full project by stable project id', () => {
        const configWithDisplayNames: CoredocConfig = {
          version: '2.0',
          projects: [
            {
              id: 'main-project',
              name: 'Main Project',
              repos: [
                { name: 'service1', path: './service1', type: 'backend' },
                { name: 'service2', path: './service2', type: 'backend' },
              ],
            },
          ],
          output: { dir: './output', format: 'json' },
          parserStorage: './parsers',
          agentMode: 'interactive',
        };

        const configWithDisplayNamesPath = path.join(tempDir, 'display-name-config.json');
        fs.writeFileSync(configWithDisplayNamesPath, JSON.stringify(configWithDisplayNames, null, 2));

        const result = resolveScope('project:main-project', {
          configPath: configWithDisplayNamesPath,
        });

        expect(result.success).toBe(true);
        expect(result.scope.resolvedRepos).toHaveLength(2);
        expect(result.scope.project).toBe('Main Project');
        expect(result.scope.projectId).toBe('main-project');
        expect(result.scope.crossRepoEnabled).toBe(true);
      });

      it('should narrow by repo within a stable project id constraint', () => {
        const configWithDisplayNames: CoredocConfig = {
          version: '2.0',
          projects: [
            {
              id: 'main-project',
              name: 'Main Project',
              repos: [
                { name: 'service1', path: './service1', type: 'backend' },
                { name: 'service2', path: './service2', type: 'backend' },
              ],
            },
          ],
          output: { dir: './output', format: 'json' },
          parserStorage: './parsers',
          agentMode: 'interactive',
        };

        const configWithDisplayNamesPath = path.join(tempDir, 'display-name-config.json');
        fs.writeFileSync(configWithDisplayNamesPath, JSON.stringify(configWithDisplayNames, null, 2));

        const result = resolveScope('service2', {
          configPath: configWithDisplayNamesPath,
          projectConstraint: 'main-project',
        });

        expect(result.success).toBe(true);
        expect(result.scope.resolvedRepos).toEqual(['service2']);
        expect(result.scope.project).toBe('Main Project');
        expect(result.scope.projectId).toBe('main-project');
        expect(result.scope.crossRepoEnabled).toBe(false);
      });

      it('should narrow to specific repo when repo name passed with project constraint', () => {
        const workspacePath = 'service1'; // Just the repo name
        const result = resolveScope(workspacePath, {
          configPath,
          projectConstraint: 'main',
        });

        expect(result.success).toBe(true);
        expect(result.scope.resolvedRepos).toHaveLength(1);
        expect(result.scope.resolvedRepos).toContain('service1');
        expect(result.scope.project).toBe('main');
        expect(result.scope.projectId).toBe('main');
        expect(result.scope.crossRepoEnabled).toBe(false);
      });

      it('should narrow to different repo in same project', () => {
        const workspacePath = 'service2'; // Different repo in same project
        const result = resolveScope(workspacePath, {
          configPath,
          projectConstraint: 'main',
        });

        expect(result.success).toBe(true);
        expect(result.scope.resolvedRepos).toHaveLength(1);
        expect(result.scope.resolvedRepos).toContain('service2');
        expect(result.scope.project).toBe('main');
      });

      it('should resolve full project when addressed with project: prefix', () => {
        // Using project: prefix falls through to resolveByProject
        const workspacePath = 'project:main';
        const result = resolveScope(workspacePath, {
          configPath,
          projectConstraint: 'main',
        });

        expect(result.success).toBe(true);
        expect(result.scope.resolvedRepos).toHaveLength(2);
        expect(result.scope.resolvedRepos).toContain('service1');
        expect(result.scope.resolvedRepos).toContain('service2');
        expect(result.scope.crossRepoEnabled).toBe(true);
      });

      // describe_repository accepts `project:<project-id>` through this same path;
      // an unknown project must hard-error naming the valid tokens, never resolve
      // to some other project's repo set.
      it('rejects an unresolvable project token and lists the valid ones', () => {
        const result = resolveScope('project:not-a-project', { configPath });

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/No repos found in project: not-a-project/);
        expect(result.error).toMatch(/Available projects:/);
        expect(result.scope.repoHashes).toEqual([]);
      });

      it('should fail gracefully when narrowing to invalid repo name', () => {
        const workspacePath = 'invalid-repo';
        const result = resolveScope(workspacePath, {
          configPath,
          projectConstraint: 'main',
        });

        // Bare-name lookup catches this with an explicit "unknown scope" error
        // (previously it silently fell through to path-based resolution and
        // matched whichever repo owned cwd).
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/Unknown scope|does not match/);
        expect(result.error).toContain('main/service1');
        expect(result.error).toContain('main/service2');
        expect(result.error).not.toContain('other/service3');
      });

      it('should reject a package coordinate with actionable scope guidance', () => {
        const result = resolveScope('@posthog/mcp', {
          configPath,
          projectConstraint: 'main',
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('looks like a package coordinate');
        expect(result.error).toContain('scope accepts repository names/paths');
        expect(result.error).toContain('main/service1');
        expect(result.error).not.toContain('other/service3');
      });

      it('should preserve project context when narrowing', () => {
        const workspacePath = 'service1';
        const result = resolveScope(workspacePath, {
          configPath,
          projectConstraint: 'main',
        });

        expect(result.success).toBe(true);
        expect(result.scope.project).toBe('main'); // Project context preserved
      });

      it('should generate correct repo hash when narrowing', () => {
        const workspacePath = 'service1';
        const result = resolveScope(workspacePath, {
          configPath,
          projectConstraint: 'main',
        });

        expect(result.success).toBe(true);
        expect(result.scope.repoHashes).toHaveLength(1);
        expect(result.scope.repoHashes[0]).toMatch(/^[0-9a-f]{12}$/);
      });
    });

    // =========================================================================
    // Project Boundary Enforcement
    //
    // When the host binds the server to a project (COREDOC_SCOPE=project:X →
    // projectConstraint), a caller-supplied scope must NOT reach a repo in a
    // different project. The fixture has project 'main' (service1, service2)
    // and project 'other' (service3); every cross-project address below must
    // fail closed.
    // =========================================================================

    describe('project boundary enforcement', () => {
      it('should reject a bare repo name that belongs to another project', () => {
        const result = resolveScope('service3', { configPath, projectConstraint: 'main' });

        expect(result.success).toBe(false);
        expect(result.error).toContain('outside the bound project "main"');
        expect(result.scope.resolvedRepos).toEqual([]);
      });

      it('should reject a "project/repo" address that crosses the boundary', () => {
        const result = resolveScope('other/service3', { configPath, projectConstraint: 'main' });

        expect(result.success).toBe(false);
        expect(result.error).toContain('outside the bound project "main"');
        expect(result.scope.resolvedRepos).toEqual([]);
      });

      it('should reject a "project:" prefix naming a different project', () => {
        const result = resolveScope('project:other', { configPath, projectConstraint: 'main' });

        expect(result.success).toBe(false);
        expect(result.error).toContain('outside the bound project "main"');
        expect(result.scope.resolvedRepos).toEqual([]);
      });

      it('should reject a filesystem path inside a repo of another project', () => {
        const otherRepoFile = path.join(tempDir, 'service3', 'src', 'index.ts');
        const result = resolveScope(otherRepoFile, { configPath, projectConstraint: 'main' });

        expect(result.success).toBe(false);
        expect(result.error).toContain('outside the bound project "main"');
        expect(result.scope.resolvedRepos).toEqual([]);
      });

      it('should still resolve a repo inside the bound project', () => {
        const result = resolveScope('service2', { configPath, projectConstraint: 'main' });

        expect(result.success).toBe(true);
        expect(result.scope.resolvedRepos).toEqual(['service2']);
        expect(result.scope.projectId).toBe('main');
      });

      it('should resolve the whole bound project when scope is project:<bound>', () => {
        const result = resolveScope('project:main', { configPath, projectConstraint: 'main' });

        expect(result.success).toBe(true);
        expect(result.scope.projectId).toBe('main');
        expect(result.scope.resolvedRepos).toEqual(expect.arrayContaining(['service1', 'service2']));
      });
    });

    // =========================================================================
    // Project Boundary Enforcement — id / display-name collision
    //
    // The boundary must be enforced by canonical project IDENTITY (id), not by
    // the raw COREDOC_SCOPE token matched against a resolved scope's id OR
    // display name. Here project B's DISPLAY NAME ("foo") collides with project
    // A's ID ("foo"), and the server is bound to A (projectConstraint "foo").
    // Any scope landing in B must fail closed even though B.name === the token —
    // otherwise project isolation is bypassable.
    // =========================================================================

    describe('project boundary — id/name collision (no cross-field bypass)', () => {
      const collisionConfig: CoredocConfig = {
        version: '2.0',
        projects: [
          // Put B first: identifier lookup must still prefer A's exact id over
          // this earlier display-name match.
          { id: 'bar', name: 'foo', repos: [{ name: 'b-svc', path: './b-svc', type: 'backend' }] },
          { id: 'foo', name: 'Foo Display', repos: [{ name: 'a-svc', path: './a-svc', type: 'backend' }] },
        ],
        output: { dir: './output', format: 'json' },
        parserStorage: './parsers',
        agentMode: 'interactive',
      };
      let collisionConfigPath: string;

      beforeEach(() => {
        collisionConfigPath = path.join(tempDir, 'collision-config.json');
        fs.writeFileSync(collisionConfigPath, JSON.stringify(collisionConfig, null, 2));
      });

      it('rejects project:<collidingId> from the wrong project despite the name collision', () => {
        // Bound to A (id "foo"); B (id "bar") whose name is also "foo".
        const result = resolveScope('project:bar', { configPath: collisionConfigPath, projectConstraint: 'foo' });

        expect(result.success).toBe(false);
        expect(result.error).toContain('outside the bound project "foo"');
        expect(result.scope.resolvedRepos).toEqual([]);
      });

      it('rejects a bare repo name from the colliding project', () => {
        const result = resolveScope('b-svc', { configPath: collisionConfigPath, projectConstraint: 'foo' });

        expect(result.success).toBe(false);
        expect(result.error).toContain('outside the bound project "foo"');
        expect(result.scope.resolvedRepos).toEqual([]);
      });

      it('rejects a "project/repo" address into the colliding project', () => {
        const result = resolveScope('bar/b-svc', { configPath: collisionConfigPath, projectConstraint: 'foo' });

        expect(result.success).toBe(false);
        expect(result.error).toContain('outside the bound project "foo"');
        expect(result.scope.resolvedRepos).toEqual([]);
      });

      it('still allows the genuinely bound project (id "foo")', () => {
        const result = resolveScope('a-svc', { configPath: collisionConfigPath, projectConstraint: 'foo' });

        expect(result.success).toBe(true);
        expect(result.scope.projectId).toBe('foo');
        expect(result.scope.resolvedRepos).toEqual(['a-svc']);
      });

      it('still resolves the whole bound project via project:<boundId>', () => {
        const result = resolveScope('project:foo', { configPath: collisionConfigPath, projectConstraint: 'foo' });

        expect(result.success).toBe(true);
        expect(result.scope.projectId).toBe('foo');
        expect(result.scope.resolvedRepos).toEqual(['a-svc']);
      });

      it('rejects a legacy display name as a project boundary token', () => {
        const result = resolveScope('a-svc', {
          configPath: collisionConfigPath,
          projectConstraint: 'Foo Display',
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('outside the bound project "Foo Display"');
        expect(result.scope.resolvedRepos).toEqual([]);
      });
    });
  });

  // ===========================================================================
  // Cypher Filter Generation
  // ===========================================================================

  describe('buildRepoHashFilter', () => {
    it('should return "true" for empty repo hashes', () => {
      const scope: ScopeContext = {
        currentPath: '/test',
        resolvedRepos: [],
        repoHashes: [],
        crossRepoEnabled: false,
      };

      const filter = buildRepoHashFilter(scope);
      expect(filter).toBe('true');
    });

    it('should generate STARTS WITH for single repo hash', () => {
      const scope: ScopeContext = {
        currentPath: '/test',
        resolvedRepos: ['service1'],
        repoHashes: ['abc123def456'],
        crossRepoEnabled: false,
      };

      const filter = buildRepoHashFilter(scope);
      expect(filter).toBe("n.id STARTS WITH 'abc123def456:'");
    });

    it('should use custom node alias', () => {
      const scope: ScopeContext = {
        currentPath: '/test',
        resolvedRepos: ['service1'],
        repoHashes: ['abc123def456'],
        crossRepoEnabled: false,
      };

      const filter = buildRepoHashFilter(scope, 'node');
      expect(filter).toBe("node.id STARTS WITH 'abc123def456:'");
    });

    it('should generate ANY() clause for multiple repo hashes', () => {
      const scope: ScopeContext = {
        currentPath: '/test',
        resolvedRepos: ['service1', 'service2'],
        repoHashes: ['abc123def456', 'xyz789ghi012'],
        crossRepoEnabled: true,
      };

      const filter = buildRepoHashFilter(scope);
      expect(filter).toContain('ANY(prefix IN');
      expect(filter).toContain("'abc123def456:'");
      expect(filter).toContain("'xyz789ghi012:'");
      expect(filter).toContain('WHERE n.id STARTS WITH prefix');
    });

    it('should generate ANY() with custom node alias', () => {
      const scope: ScopeContext = {
        currentPath: '/test',
        resolvedRepos: ['service1', 'service2'],
        repoHashes: ['abc123def456', 'xyz789ghi012'],
        crossRepoEnabled: true,
      };

      const filter = buildRepoHashFilter(scope, 'target');
      expect(filter).toContain('WHERE target.id STARTS WITH prefix');
    });
  });

  // ===========================================================================
  // Scope Description
  // ===========================================================================

  describe('getScopeDescription', () => {
    it('should describe empty scope', () => {
      const scope: ScopeContext = {
        currentPath: '/test',
        resolvedRepos: [],
        repoHashes: [],
        crossRepoEnabled: false,
      };

      const description = getScopeDescription(scope);
      expect(description).toBe('No repositories matched');
    });

    it('should describe single repo', () => {
      const scope: ScopeContext = {
        currentPath: '/test',
        resolvedRepos: ['service1'],
        repoHashes: ['abc123'],
        crossRepoEnabled: false,
      };

      const description = getScopeDescription(scope);
      expect(description).toBe('Repository: service1');
    });

    it('should describe multiple repos with project', () => {
      const scope: ScopeContext = {
        currentPath: '/test',
        resolvedRepos: ['service1', 'service2', 'service3'],
        repoHashes: ['abc123', 'def456', 'ghi789'],
        project: 'platform',
        crossRepoEnabled: true,
      };

      const description = getScopeDescription(scope);
      expect(description).toBe("Project 'platform': service1, service2, service3");
    });

    it('should describe multiple repos without project', () => {
      const scope: ScopeContext = {
        currentPath: '/test',
        resolvedRepos: ['service1', 'service2'],
        repoHashes: ['abc123', 'def456'],
        crossRepoEnabled: false,
      };

      const description = getScopeDescription(scope);
      expect(description).toBe('Repositories: service1, service2');
    });
  });

  // ===========================================================================
  // Vantage Repo Resolution
  // ===========================================================================

  describe('resolveVantageRepo', () => {
    // A project-wide scope: every repo in the project is visible (the boundary),
    // but the agent is physically standing in one of them (the vantage).
    const projectScope: ScopeContext = {
      currentPath: '/test/workspace',
      resolvedRepos: ['api-server', 'web-app', 'billing-service'],
      repoHashes: [generateRepoHash('api-server'), generateRepoHash('web-app'), generateRepoHash('billing-service')],
      project: 'acme',
      projectId: 'acme',
      crossRepoEnabled: true,
    };

    it('resolves a bare repo name to its name and hash within scope', () => {
      const vantage = resolveVantageRepo(projectScope, 'web-app');
      expect(vantage).toEqual({ name: 'web-app', hash: generateRepoHash('web-app') });
    });

    it('resolves the qualified project/repo form to the repo segment', () => {
      const vantage = resolveVantageRepo(projectScope, 'acme/billing-service');
      expect(vantage).toEqual({ name: 'billing-service', hash: generateRepoHash('billing-service') });
    });

    it('resolves by repo key when the key differs from the name', () => {
      // Hash is generated from `key ?? name`; a repo addressed by its key still
      // lands on the same stored hash prefix even though the name differs.
      const keyedScope: ScopeContext = {
        currentPath: '/test/workspace',
        resolvedRepos: ['web-app'],
        repoHashes: [generateRepoHash('acme-web-app')],
        project: 'acme',
        projectId: 'acme',
        crossRepoEnabled: false,
      };
      const vantage = resolveVantageRepo(keyedScope, 'acme-web-app');
      expect(vantage).toEqual({ name: 'web-app', hash: generateRepoHash('acme-web-app') });
    });

    it('returns undefined when the signal names a repo outside the scope (never crosses the boundary)', () => {
      expect(resolveVantageRepo(projectScope, 'some-other-repo')).toBeUndefined();
    });

    it('returns undefined for an empty or whitespace signal', () => {
      expect(resolveVantageRepo(projectScope, '')).toBeUndefined();
      expect(resolveVantageRepo(projectScope, '   ')).toBeUndefined();
    });
  });
});
