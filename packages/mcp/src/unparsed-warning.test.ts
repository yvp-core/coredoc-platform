import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CONFIG_PATH = '/ws/coredoc.config.json';
const CONFIG = {
  configDir: '/ws',
  projects: [
    { id: 'proj-a', name: 'Project A', repos: [{ name: 'api' }, { name: 'web' }] },
    { id: 'proj-b', name: 'Project B', repos: [{ name: 'billing' }] },
  ],
};

const { listAllRepositories, openProjectDatabase } = vi.hoisted(() => {
  const listAllRepositories = vi.fn(async () => [{ name: 'api' }, { name: 'web' }]);
  return {
    listAllRepositories,
    openProjectDatabase: vi.fn(async (configDir: string, projectId: string) => ({
      projectId,
      url: `file:${configDir}/coredoc.db.d/${projectId}.db`,
      graph: { listAllRepositories },
      operations: {},
      metrics: {},
    })),
  };
});

// Partial mock: the real module still supplies the value exports other modules
// pull in transitively (e.g. the CypherResultShape enum tool-schemas.ts uses).
vi.mock('@coredoc/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@coredoc/db')>()),
  getConfiguredBackend: () => 'sqlite',
  getRepository: vi.fn(),
  isDatabaseAvailable: async () => true,
  openProjectDatabase,
  registerExitHandlers: vi.fn(),
}));

vi.mock('node:fs', () => ({ existsSync: () => true }));

vi.mock('./scope-resolver.js', async () => {
  const actual = await vi.importActual<typeof import('./scope-resolver.js')>('./scope-resolver.js');
  return { ...actual, loadConfig: () => CONFIG };
});

let warnings: string[];
let savedUrl: string | undefined;
let savedScope: string | undefined;
let savedConfig: string | undefined;

beforeEach(() => {
  warnings = [];
  vi.spyOn(console, 'error').mockImplementation((msg: unknown) => {
    warnings.push(String(msg));
  });
  savedUrl = process.env.COREDOC_SQLITE_URL;
  savedScope = process.env.COREDOC_SCOPE;
  savedConfig = process.env.MCP_CONFIG_PATH;
  process.env.MCP_CONFIG_PATH = CONFIG_PATH;
  process.env.COREDOC_SCOPE = 'project:proj-a';
  process.env.COREDOC_SQLITE_URL = 'file:/tmp/must-be-ignored.db';
  listAllRepositories.mockReset().mockResolvedValue([{ name: 'api' }, { name: 'web' }]);
  openProjectDatabase.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of [
    ['COREDOC_SQLITE_URL', savedUrl],
    ['COREDOC_SCOPE', savedScope],
    ['MCP_CONFIG_PATH', savedConfig],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('warnUnparsedRepos', () => {
  it('checks only the project bound by exact id and ignores a legacy URL pin', async () => {
    const { warnUnparsedRepos } = await import('./server.js');

    await warnUnparsedRepos();

    expect(openProjectDatabase).toHaveBeenCalledWith('/ws', 'proj-a', { mode: 'read' });
    expect(openProjectDatabase.mock.calls.flat()).not.toContain('file:/tmp/must-be-ignored.db');
    expect(warnings.join('\n')).not.toContain('billing');
  });

  it('reports a genuinely unparsed repo inside the bound project', async () => {
    listAllRepositories.mockResolvedValueOnce([{ name: 'api' }]);
    const { warnUnparsedRepos } = await import('./server.js');

    await warnUnparsedRepos();

    expect(warnings.join('\n')).toContain('web');
    expect(warnings.join('\n')).toContain('proj-a');
    expect(warnings.join('\n')).toContain('coredoc push');
  });

  it('does nothing when there is no exact project binding', async () => {
    process.env.COREDOC_SCOPE = 'auto';
    const { warnUnparsedRepos } = await import('./server.js');

    await warnUnparsedRepos();

    expect(openProjectDatabase).not.toHaveBeenCalled();
    expect(warnings).toEqual([]);
  });
});
