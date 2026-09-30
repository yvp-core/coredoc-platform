import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';

const PROFILE_ROOT = join(tmpdir(), `coredoc-test-profiles-${process.pid}-${process.env.VITEST_POOL_ID ?? 'main'}`);
const PROFILE_DIR = join(PROFILE_ROOT, 'proj1', 'repo1');
const PROFILE_PATH = `${PROFILE_DIR}/profile.ts`;
const { csharpSources, rubySources } = vi.hoisted(() => ({
  csharpSources: vi.fn(() => ({ included: [] as string[] })),
  rubySources: vi.fn(() => ({ included: [] as string[] })),
}));
vi.mock('@coredoc/profile-parser', async (original) => ({
  ...(await original<typeof import('@coredoc/profile-parser')>()),
  csharpProvider: { sourceFiles: csharpSources },
  rubyProvider: { sourceFiles: rubySources },
  pythonProvider: { sourceFiles: () => ({ included: [] }) },
  rustProvider: { sourceFiles: () => ({ included: [] }) },
  goProvider: { sourceFiles: () => ({ included: [] }) },
}));

const { workers } = vi.hoisted(() => ({ workers: [] as Array<{ postMessage: ReturnType<typeof vi.fn> }> }));
vi.mock('worker_threads', () => ({
  Worker: class {
    readonly postMessage = vi.fn();
    readonly terminate = vi.fn();
    readonly on = vi.fn();
    constructor() {
      workers.push(this);
    }
  },
}));

// command-runner pulls in a wide set of main-process modules at import time; the E2E guard
// fires at the top of runGenerateCommand before any of them are touched, so stub minimally.
const { electronAppMock } = vi.hoisted(() => ({
  electronAppMock: { getPath: () => '/Users/tester', isPackaged: false },
}));
vi.mock('electron', () => ({ app: electronAppMock }));
vi.mock('./config-manager.js', () => ({
  getCurrentConfigPath: vi.fn(() => '/config/coredoc.json'),
  getConfigDir: vi.fn(() => '/tmp'),
  getCurrentConfig: vi.fn(),
  resolveRepoPath: vi.fn(),
}));
vi.mock('@coredoc/core/utils', () => ({
  projectDbUrl: vi.fn(() => 'file:/tmp/x.db'),
  parsedRepoFile: vi.fn(
    (output: string, projectId: string, repoName: string) => `${output}/${projectId}/${repoName}.json`,
  ),
}));
vi.mock('@coredoc/db', () => ({ closeAllDrivers: vi.fn(), closeProjectDatabases: vi.fn() }));
vi.mock('@coredoc/cli/sdk', () => ({ loadConfig: vi.fn() }));
vi.mock('./pty-manager.js', () => ({
  writePty: vi.fn(),
  resizePty: vi.fn(),
  spawnPty: vi.fn(),
  killPty: vi.fn(),
  killAllPtys: vi.fn(),
}));
vi.mock('./parser-artifact.js', () => ({
  profileArtifactPath: vi.fn(() => PROFILE_PATH),
}));
vi.mock('./runtime-paths.js', () => ({
  requireProjectRoot: vi.fn(() => '/root'),
  getNodeExec: vi.fn(() => ({ execPath: 'node', env: { PATH: '/toolchain/bin:/usr/bin' } })),
  getCliPath: vi.fn(() => '/root/cli/index.js'),
  getClaudeCodeCliPath: vi.fn(() => '/root/claude'),
  getCodexCliPath: vi.fn(() => '/root/codex'),
  getAuthoringKitDir: vi.fn(() => '/root/kit'),
  getEnvPath: vi.fn(() => '/config/.env'),
}));
vi.mock('./cloud-docs-manager.js', () => ({ runCloudDocsCommand: vi.fn() }));
const { startAgentRunMock } = vi.hoisted(() => ({ startAgentRunMock: vi.fn() }));
vi.mock('./agent-run/agent-run-service.js', () => ({
  startAgentRun: startAgentRunMock,
  registerAgentRunHandlers: vi.fn(),
}));
const { harnessSettings, buildHarnessEnvironmentMock } = vi.hoisted(() => ({
  harnessSettings: { provider: 'claude-code' as 'claude-code' | 'codex', authMode: 'subscription', credentials: {} },
  buildHarnessEnvironmentMock: vi.fn((_env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({ PATH: '/usr/bin' })),
}));
vi.mock('./harness-settings.js', () => ({
  readHarnessSettings: vi.fn(() => ({ ...harnessSettings })),
  buildHarnessEnvironment: buildHarnessEnvironmentMock,
}));
vi.mock('./agent-run/claude-adapter.js', () => ({
  ClaudeAdapter: class {
    readonly kind = 'claude-code';
  },
}));
vi.mock('./agent-run/codex-adapter.js', () => ({
  CodexAdapter: class {
    readonly kind = 'codex';
    constructor(readonly executablePath: string) {}
  },
}));
vi.mock('./telemetry-manager.js', () => ({ buildCloudChannelConfig: vi.fn() }));
vi.mock('./build-env.js', () => ({ BUNDLED_POSTHOG_KEY: '', BUNDLED_POSTHOG_HOST: '' }));
const { sandboxLaunchMock, sandboxTerminateMock } = vi.hoisted(() => ({
  sandboxLaunchMock: vi.fn(),
  sandboxTerminateMock: vi.fn(),
}));
vi.mock('./profile-parse-sandbox.js', () => ({
  resolveSandboxExecutable: (executable: string) => (executable === 'node' ? '/usr/bin/node' : executable),
  spawnSandboxedParse: (options: unknown) => {
    sandboxLaunchMock(options);
    return { terminate: sandboxTerminateMock };
  },
}));

import { spawnPty } from './pty-manager.js';
import * as scoreHost from './profile-score-host.js';
import { getCurrentConfig, resolveRepoPath } from './config-manager.js';
import { cancelCommand, runCommand } from './command-runner.js';
import { getAnalysisPrompts, answerAnalysisPrompt } from './analysis-prompts.js';

const sends = vi.fn();
const fakeWindow = {
  isDestroyed: () => false,
  webContents: { isDestroyed: () => false, send: sends },
} as unknown as import('electron').BrowserWindow;

describe('command-runner E2E guard (generate)', () => {
  afterEach(() => {
    delete process.env.COREDOC_DESKTOP_E2E;
    electronAppMock.isPackaged = false;
    vi.unstubAllGlobals();
    sends.mockClear();
    startAgentRunMock.mockClear();
    vi.mocked(spawnPty).mockClear();
    buildHarnessEnvironmentMock.mockClear();
    harnessSettings.provider = 'claude-code';
    harnessSettings.authMode = 'subscription';
    harnessSettings.credentials = {};
    delete process.env.COREDOC_GENERATE_PTY;
    workers.length = 0;
    sandboxLaunchMock.mockClear();
    sandboxTerminateMock.mockClear();
    csharpSources.mockReset().mockReturnValue({ included: [] });
    rubySources.mockReset().mockReturnValue({ included: [] });
    rmSync(PROFILE_DIR, { recursive: true, force: true });
  });

  it('fails the generate command under COREDOC_DESKTOP_E2E without starting an agent run or PTY', async () => {
    process.env.COREDOC_DESKTOP_E2E = '1';

    const result = await runCommand({ command: 'generate', projectId: 'proj1', repo: 'repo1' }, fakeWindow);
    expect(result.started).toBe(true);

    // runGenerateCommand rejects asynchronously; let the .catch handler run.
    await new Promise((resolve) => setImmediate(resolve));

    expect(startAgentRunMock).not.toHaveBeenCalled();
    expect(spawnPty).not.toHaveBeenCalled();
    const completedCall = sends.mock.calls.find(([channel]) => channel === 'command:completed');
    expect(completedCall?.[1]).toMatchObject({ id: result.id, success: false });
    expect(completedCall?.[1].error).toMatch(/E2E mode/);
  });
  it('starts authoring with a stray C# project without provisioning tools or writing SDK logs in the checkout', async () => {
    const client = mkdtempSync(join(tmpdir(), 'coredoc-generate-source-'));
    try {
      writeFileSync(join(client, 'Stray.csproj'), '<Project/>');
      vi.mocked(resolveRepoPath).mockReturnValue(client);
      vi.mocked(getCurrentConfig).mockReturnValue({ projects: [], parserStorage: './parsers' } as never);
      await runCommand({ command: 'generate', projectId: 'proj1', repo: 'repo1' }, fakeWindow);
      await new Promise((resolve) => setImmediate(resolve));
      const request = startAgentRunMock.mock.calls[0]![1];
      expect(request.policy.safeCommandPrefixes).toEqual([]);
      expect(request.scoreProfile).toBeTypeOf('function');
      expect(request.env.CLAUDE_CODE_DEBUG_LOGS_DIR).toContain(request.policy.writeDirs[0]);
      expect(existsSync(join(client, '.claude-sdk'))).toBe(false);
    } finally {
      rmSync(client, { recursive: true, force: true });
    }
  });

  it('asks for C# mode before starting the agent and resumes the saved draft', async () => {
    harnessSettings.provider = 'codex';
    csharpSources.mockReturnValueOnce({ included: ['App.cs'] });
    vi.mocked(resolveRepoPath).mockReturnValue('/tmp');
    vi.mocked(getCurrentConfig).mockReturnValue({ projects: [], parserStorage: './parsers' } as never);
    mkdirSync(PROFILE_DIR, { recursive: true });
    writeFileSync(`${PROFILE_DIR}/profile.draft.ts`, '// saved unverified work');
    await runCommand({ command: 'generate', projectId: 'proj1', repo: 'repo1' }, fakeWindow);
    await new Promise((resolve) => setImmediate(resolve));
    expect(startAgentRunMock).not.toHaveBeenCalled();
    const prompt = getAnalysisPrompts()[0]!;
    expect(prompt).toMatchObject({ repoName: 'repo1', phase: 'execution', canUseBasic: true });
    answerAnalysisPrompt(prompt.id, 'basic');
    await new Promise((resolve) => setImmediate(resolve));
    const request = startAgentRunMock.mock.calls[0]![1];
    expect(request.prompt).toContain('user selected basic analysis');
    expect(request.prompt).toContain('call the score tool first');
    expect(request.prompt).toContain('do not repeat the four directional scouts');
    expect(request.prompt).not.toContain('use spawn_agent');
  });

  it('asks for Ruby mode before starting profile authoring', async () => {
    rubySources.mockReturnValueOnce({ included: ['app.rb'] });
    vi.mocked(resolveRepoPath).mockReturnValue('/tmp');
    vi.mocked(getCurrentConfig).mockReturnValue({ projects: [], parserStorage: './parsers' } as never);
    await runCommand({ command: 'generate', projectId: 'proj1', repo: 'repo1' }, fakeWindow);
    await new Promise((resolve) => setImmediate(resolve));
    expect(startAgentRunMock).not.toHaveBeenCalled();
    const prompt = getAnalysisPrompts()[0]!;
    expect(prompt).toMatchObject({ language: 'ruby', phase: 'execution', canUseBasic: true });
    answerAnalysisPrompt(prompt.id, 'basic');
    await new Promise((resolve) => setImmediate(resolve));
    expect(startAgentRunMock.mock.calls[0]![1].prompt).toContain('user selected basic analysis');
  });

  it('starts Codex profile authoring on Sol with Luna directional-scout instructions', async () => {
    harnessSettings.provider = 'codex';
    harnessSettings.authMode = 'api-token';
    harnessSettings.credentials = { codex: 'stored-token' };
    buildHarnessEnvironmentMock.mockReturnValueOnce({ PATH: '/usr/bin', CODEX_API_KEY: 'stored-token' });
    vi.mocked(resolveRepoPath).mockReturnValue(process.cwd());
    vi.mocked(getCurrentConfig).mockReturnValue({ projects: [], parserStorage: './parsers' } as never);
    process.env.COREDOC_GENERATE_PTY = '1';

    const result = await runCommand({ command: 'generate', projectId: 'proj1', repo: 'repo1' }, fakeWindow);
    await new Promise((resolve) => setImmediate(resolve));

    expect(result.started).toBe(true);
    expect(startAgentRunMock).toHaveBeenCalledOnce();
    const [id, request, _window, adapter] = startAgentRunMock.mock.calls[0];
    const stagingDir = request.policy.writeDirs[0] as string;
    expect(id).toBe(result.id);
    expect(request).toMatchObject({
      model: 'gpt-6-sol',
      env: { PATH: '/root:/usr/bin', CODEX_API_KEY: 'stored-token' },
      prompt: expect.stringMatching(/spawn_agent[\s\S]*gpt-6-luna/),
      additionalDirectories: expect.arrayContaining([stagingDir]),
      policy: {
        writeDirs: [expect.stringContaining(`${PROFILE_DIR}/.authoring-`)],
        readDirs: expect.arrayContaining([process.cwd(), '/root/kit', stagingDir]),
        // Score-toolchain sandbox grants: CLI bundle dir + dev monorepo module tree. Kept out
        // of readDirs so the agent's Read/Glob/Grep scope stays repo+kit only.
        toolchainReadDirs: expect.arrayContaining(['/root/cli', '/root/node_modules', '/root/packages']),
      },
    });
    expect(request.additionalDirectories).not.toContain(PROFILE_DIR);
    expect(request.policy.readDirs).not.toContain(PROFILE_DIR);
    expect(request.policy.readDirs).not.toContain('/root/cli');
    expect(request.prompt).toContain('coredoc_score_profile');
    expect(request.prompt).toContain('coredoc_request_user_input');
    expect(request.prompt).toMatch(/inventory[\s\S]*source roots/i);
    expect(request.prompt).toMatch(/entrypoints[\s\S]*data\/DB[\s\S]*frontend[\s\S]*DI\/indirection\/egress/);
    expect(request.prompt).toMatch(/split[\s\S]*package[\s\S]*distinct stack/i);
    expect(request.prompt).toMatch(/ExtractionProfile[\s\S]*MultiTargetProfile[\s\S]*polyglot/i);
    expect(request.prompt).toMatch(/one target per canonical language provider[\s\S]*TS and JS/i);
    expect(request.prompt).not.toContain('single ExtractionProfile export');
    expect(request.prompt).toContain('read-only inspection commands such as rg, find, sed, and cat');
    expect(request.prompt).toContain('Do not install dependencies');
    expect(request.prompt).toContain('ad-hoc Node/Python/Ruby analysis scripts');
    expect(request.prompt).toContain('including documentation comments, before the final score tool call');
    expect(request.prompt).toContain('never finalize or end with an unscored revision');
    expect(request.prompt).toContain('never delete those reports yourself');
    expect(request.deliverableExists()).toBe(false);
    expect(request.prompt).not.toContain('Read/Glob/Grep tools');
    expect(request.prompt).not.toMatch(/use the request_user_input tool/);
    expect(request.policy.readDirs).not.toContain(PROFILE_ROOT);
    expect(adapter).toMatchObject({ kind: 'codex', executablePath: '/root/codex' });
    expect(spawnPty).not.toHaveBeenCalled();
  });

  it('keeps Claude authoring on the staged fail-closed SDK path when the retired PTY flag is set', async () => {
    vi.mocked(resolveRepoPath).mockReturnValue(process.cwd());
    vi.mocked(getCurrentConfig).mockReturnValue({ projects: [], parserStorage: './parsers' } as never);
    process.env.COREDOC_GENERATE_PTY = '1';

    const result = await runCommand({ command: 'generate', projectId: 'proj1', repo: 'repo1' }, fakeWindow);
    await new Promise((resolve) => setImmediate(resolve));

    expect(result.started).toBe(true);
    expect(startAgentRunMock).toHaveBeenCalledOnce();
    const request = startAgentRunMock.mock.calls[0][1];
    const stagingDir = request.policy.writeDirs[0] as string;
    expect(stagingDir).toMatch(`${PROFILE_DIR}/.authoring-`);
    expect(request.prompt).toContain(`${stagingDir}/profile.ts`);
    expect(request.prompt).toContain('arbitrary shell commands');
    expect(request.prompt).toContain('are unavailable');
    expect(request.prompt).toContain('Read/Glob/Grep tools');
    expect(request.verifyCompletion).toBeTypeOf('function');
    expect(request.finalizeCompletion).toBeTypeOf('function');
    expect(spawnPty).not.toHaveBeenCalled();
  });

  it('requires the latest profile revision to match the ExtractionProfile schema before generation completes', async () => {
    harnessSettings.provider = 'codex';
    vi.mocked(resolveRepoPath).mockReturnValue(process.cwd());
    vi.mocked(getCurrentConfig).mockReturnValue({ projects: [], parserStorage: './parsers' } as never);
    let finishRun: (() => void) | undefined;
    startAgentRunMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishRun = resolve;
        }),
    );

    await runCommand({ command: 'generate', projectId: 'proj1', repo: 'repo1' }, fakeWindow);
    await new Promise((resolve) => setImmediate(resolve));

    const request = startAgentRunMock.mock.calls[0]?.[1];
    const candidate = `${request.policy.writeDirs[0]}/profile.ts`;
    expect(request?.verifyCompletion).toBeTypeOf('function');
    expect(request.verifyCompletion()).toMatch(/without writing the profile/);

    writeFileSync(
      candidate,
      `import type { ExtractionProfile } from '@coredoc/profile-parser';
const profile: ExtractionProfile = {
  parserId: 'fixture/valid',
  substrate: { language: 'ts', include: ['**/*.ts'] },
};
export default profile;
`,
    );
    expect(request.verifyCompletion()).toMatch(/has not been scored/i);
    request.onCommandCompleted({
      command: 'coredoc_score_profile',
      success: true,
      output: '=== Overall: PASS ===\n=== Profile completion: PASS ===',
    });
    expect(request.verifyCompletion()).toBeNull();

    writeFileSync(
      candidate,
      `import type { ExtractionProfile } from '@coredoc/profile-parser';
const profile: ExtractionProfile = {
  parserId: 'fixture/invalid',
  substrate: { language: 'ts', include: ['**/*.ts'] },
  routes: { fileConvention: [{ framework: 'unknown', routeDir: 'unknown' }] },
  stateStores: [{ library: 'unknown', factory: {} }],
};
export default profile;
`,
    );
    const failure = request.verifyCompletion();
    expect(failure).toMatch(/Profile does not match the ExtractionProfile schema \(3 errors\)/);
    expect(failure).toMatch(/Type '"unknown"' is not assignable to type '"next-pages" \| "next-app"'/);
    expect(failure).toMatch(/Type '\{\}' is not assignable to type 'string'/);
    finishRun?.();
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('stages regeneration, rejects executable/runtime artifacts, and promotes only the verified profile', async () => {
    const createScorer = vi.spyOn(scoreHost, 'createProfileScoreHost');
    harnessSettings.provider = 'codex';
    vi.mocked(resolveRepoPath).mockReturnValue(process.cwd());
    vi.mocked(getCurrentConfig).mockReturnValue({ projects: [], parserStorage: './parsers' } as never);
    mkdirSync(PROFILE_DIR, { recursive: true });
    writeFileSync(PROFILE_PATH, '// existing profile stays live until promotion\n');
    let finishRun: (() => void) | undefined;
    startAgentRunMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishRun = resolve;
        }),
    );

    await runCommand({ command: 'generate', projectId: 'proj1', repo: 'repo1' }, fakeWindow);
    await new Promise((resolve) => setImmediate(resolve));

    const request = startAgentRunMock.mock.calls[0]?.[1];
    const stagingDir = request.policy.writeDirs[0] as string;
    expect(stagingDir).toMatch(`${PROFILE_DIR}/.authoring-`);
    expect(stagingDir).not.toBe(PROFILE_DIR);
    expect(request.additionalDirectories).toContain(stagingDir);
    expect(request.additionalDirectories).not.toContain(PROFILE_DIR);
    expect(request.policy.readDirs).toContain(stagingDir);
    expect(request.policy.readDirs).not.toContain(PROFILE_DIR);
    expect(readFileSync(PROFILE_PATH, 'utf8')).toContain('existing profile');

    const candidate = `${stagingDir}/profile.ts`;
    expect(readFileSync(candidate, 'utf8')).toContain('existing profile');
    writeFileSync(
      candidate,
      `import process from 'node:process';
import type { ExtractionProfile } from '@coredoc/profile-parser';
process.env.PATH = '/tmp/shim';
const profile: ExtractionProfile = {
  parserId: 'fixture/unsafe',
  substrate: { language: 'ts', include: ['**/*.ts'] },
};
export default profile;
`,
    );
    expect(request.verifyCompletion()).toMatch(/runtime imports.*not allowed/i);

    writeFileSync(
      candidate,
      `import type { ExtractionProfile } from '@coredoc/profile-parser';
const profile: ExtractionProfile = {
  parserId: 'fixture/unsafe-dynamic',
  substrate: { language: 'ts', include: ['**/*.ts'] },
  customRules: [{
    name: 'unsafe',
    run: async () => { await import('node:child_process'); },
  }],
};
export default profile;
`,
    );
    expect(request.verifyCompletion()).toMatch(/dynamic import/i);

    writeFileSync(
      candidate,
      `import type { ExtractionProfile } from '@coredoc/profile-parser';
const profile: ExtractionProfile = {
  parserId: 'fixture/valid',
  substrate: { language: 'ts', include: ['**/*.ts'] },
};
export default profile;
`,
    );
    const shim = `${stagingDir}/node`;
    writeFileSync(shim, '#!/bin/sh\nexit 0\n');
    chmodSync(shim, 0o755);
    expect(request.verifyCompletion()).toMatch(/executable artifact/i);

    rmSync(shim);
    expect(request.verifyCompletion()).toMatch(/has not been scored/i);
    request.onCommandCompleted({
      command: 'coredoc_score_profile',
      success: true,
      output: '=== Overall: PASS ===\n=== Profile completion: PASS ===',
    });
    expect(request.verifyCompletion()).toBeNull();
    expect(request.finalizeCompletion()).toBeNull();
    expect(readFileSync(PROFILE_PATH, 'utf8')).toContain("parserId: 'fixture/valid'");
    finishRun?.();
    await new Promise((resolve) => setImmediate(resolve));
    expect(() => readFileSync(stagingDir, 'utf8')).toThrow();
    const scorer = createScorer.mock.results[0].value as ReturnType<typeof scoreHost.createProfileScoreHost>;
    const beginParse = vi.spyOn(scorer, 'beginParse');
    vi.mocked(getCurrentConfig).mockReturnValue({
      projects: [],
      parserStorage: './parsers',
      output: { dir: './output' },
    } as never);
    await runCommand({ command: 'parse', projectId: 'proj1', repo: 'repo1' }, fakeWindow);
    expect(beginParse).toHaveBeenCalledOnce();
    sandboxLaunchMock.mock.calls.at(-1)![0].onClose(0, null);
    beginParse.mockRestore();
    createScorer.mockRestore();
  });

  it('preserves the live profile when a schema-valid draft ends before scoring', async () => {
    harnessSettings.provider = 'codex';
    vi.mocked(resolveRepoPath).mockReturnValue(process.cwd());
    vi.mocked(getCurrentConfig).mockReturnValue({ projects: [], parserStorage: './parsers' } as never);
    mkdirSync(PROFILE_DIR, { recursive: true });
    writeFileSync(PROFILE_PATH, '// known-good live profile\n');
    let finishRun: (() => void) | undefined;
    startAgentRunMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishRun = resolve;
        }),
    );

    await runCommand({ command: 'generate', projectId: 'proj1', repo: 'repo1' }, fakeWindow);
    await new Promise((resolve) => setImmediate(resolve));
    const request = startAgentRunMock.mock.calls[0]?.[1];
    const candidate = `${request.policy.writeDirs[0]}/profile.ts`;
    writeFileSync(
      candidate,
      `import type { ExtractionProfile } from '@coredoc/profile-parser';
const profile: ExtractionProfile = {
  parserId: 'fixture/unscored',
  substrate: { language: 'ts', include: ['**/*.ts'] },
};
export default profile;
`,
    );

    expect(request.verifyCompletion()).toMatch(/has not been scored/i);
    expect(request.finalizeCompletion()).toMatch(/has not been scored/i);
    expect(readFileSync(PROFILE_PATH, 'utf8')).toBe('// known-good live profile\n');
    finishRun?.();
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('binds PASS or an explicitly accepted partial gap to the exact candidate revision', async () => {
    harnessSettings.provider = 'codex';
    vi.mocked(resolveRepoPath).mockReturnValue(process.cwd());
    vi.mocked(getCurrentConfig).mockReturnValue({ projects: [], parserStorage: './parsers' } as never);
    let finishRun: (() => void) | undefined;
    startAgentRunMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishRun = resolve;
        }),
    );

    await runCommand({ command: 'generate', projectId: 'proj1', repo: 'repo1' }, fakeWindow);
    await new Promise((resolve) => setImmediate(resolve));
    const request = startAgentRunMock.mock.calls[0]?.[1];
    const candidate = `${request.policy.writeDirs[0]}/profile.ts`;
    const validProfile = `import type { ExtractionProfile } from '@coredoc/profile-parser';
const profile: ExtractionProfile = {
  parserId: 'fixture/attested',
  substrate: { language: 'ts', include: ['**/*.ts'] },
};
export default profile;
`;
    writeFileSync(candidate, validProfile);
    const scoreCommand = 'coredoc_score_profile';

    request.onCommandCompleted({
      command: scoreCommand,
      success: true,
      output: '=== Overall: PASS ===',
    });
    expect(request.verifyCompletion()).toMatch(/did not produce a complete result/i);

    request.onCommandCompleted({
      command: scoreCommand,
      success: true,
      output: '=== Overall: PASS ===\n=== Profile completion: PASS ===',
    });
    expect(request.verifyCompletion()).toBeNull();

    request.onCommandCompleted({
      command: scoreCommand,
      success: false,
      output: '=== Overall: PASS ===\nError: TypeScript target could not read its sources.',
    });
    expect(request.verifyCompletion()).toMatch(/did not produce a complete result/i);
    expect(request.verifyCompletion()).toContain('TypeScript target could not read its sources.');
    expect(request.finalizeCompletion()).not.toBeNull();
    request.onQuestionAnswered(
      [
        {
          header: 'Gap',
          question: 'Accept?',
          multiSelect: false,
          options: [{ label: 'Accept documented gap', description: 'Continue' }],
        },
      ],
      [['Accept documented gap']],
    );
    expect(request.verifyCompletion()).toContain('TypeScript target could not read its sources.');
    request.onCommandCompleted({
      command: scoreCommand,
      success: true,
      output: '=== Overall: PASS ===\n=== Profile completion: PASS ===',
    });
    expect(request.verifyCompletion()).toBeNull();

    writeFileSync(candidate, `${validProfile}\n// edited after score\n`);
    expect(request.verifyCompletion()).toMatch(/current profile revision has not been scored/i);

    request.onCommandCompleted({
      command: scoreCommand,
      success: false,
      output: '=== Overall: PASS ===\n=== Overall (all targets): FAIL ===\n=== Profile completion: ACCEPTABLE_GAP ===',
    });
    expect(request.verifyCompletion()).toMatch(/score result is FAIL/i);
    const gapQuestion = [
      {
        header: 'Score gap',
        question: 'How should Coredoc proceed?',
        multiSelect: false,
        options: [
          { label: 'Accept documented gap', description: 'Keep the documented partial result' },
          { label: 'Keep iterating', description: 'Try more changes' },
        ],
      },
    ];
    request.onQuestionAnswered(gapQuestion, [['Keep iterating']]);
    expect(request.verifyCompletion()).toMatch(/score result is FAIL/i);
    request.onQuestionAnswered(gapQuestion, [['Accept documented gap']]);
    expect(request.verifyCompletion()).toBeNull();

    request.onCommandCompleted({
      command: scoreCommand,
      success: false,
      output: '=== Overall: FAIL ===\n=== Profile completion: BLOCKED ===',
    });
    expect(request.verifyCompletion()).toMatch(/cannot be accepted/i);
    request.onQuestionAnswered(gapQuestion, [['Accept documented gap']]);
    expect(request.verifyCompletion()).toMatch(/cannot be accepted/i);
    writeFileSync(candidate, `${validProfile}\n// documented after the blocked score\n`);
    expect(request.verifyCompletion()).toMatch(/last scored profile revision was BLOCKED/i);
    expect(request.verifyCompletion()).toMatch(/changed after that score/i);

    finishRun?.();
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('preserves the live profile and removes isolated artifacts when authoring fails', async () => {
    harnessSettings.provider = 'codex';
    vi.mocked(resolveRepoPath).mockReturnValue(process.cwd());
    vi.mocked(getCurrentConfig).mockReturnValue({ projects: [], parserStorage: './parsers' } as never);
    mkdirSync(PROFILE_DIR, { recursive: true });
    writeFileSync(PROFILE_PATH, '// live profile\n');
    startAgentRunMock.mockRejectedValueOnce(new Error('authoring crashed'));

    await runCommand({ command: 'generate', projectId: 'proj1', repo: 'repo1' }, fakeWindow);
    await new Promise((resolve) => setImmediate(resolve));

    const stagingDir = startAgentRunMock.mock.calls[0]?.[1].policy.writeDirs[0] as string;
    expect(readFileSync(PROFILE_PATH, 'utf8')).toBe('// live profile\n');
    expect(existsSync(stagingDir)).toBe(false);
    expect(readFileSync(`${PROFILE_DIR}/profile.draft.ts`, 'utf8')).toBe('// live profile\n');
    expect(sends.mock.calls.find(([channel]) => channel === 'command:completed')?.[1]).toMatchObject({
      success: false,
      error: 'authoring crashed',
    });
  });

  it('keeps Claude Code subscription as the default without requiring a token', async () => {
    vi.mocked(resolveRepoPath).mockReturnValue('/tmp');
    vi.mocked(getCurrentConfig).mockReturnValue({ projects: [], parserStorage: './parsers' } as never);

    await runCommand({ command: 'generate', projectId: 'proj1', repo: 'repo1' }, fakeWindow);
    await new Promise((resolve) => setImmediate(resolve));

    expect(startAgentRunMock).toHaveBeenCalledOnce();
    const request = startAgentRunMock.mock.calls[0][1];
    const adapter = startAgentRunMock.mock.calls[0][3];
    expect(request).toMatchObject({ model: 'claude-sonnet-5', env: { PATH: '/usr/bin' } });
    expect(request.prompt).toContain('mcp__coredoc__score_profile');
    expect(adapter).toMatchObject({ kind: 'claude-code' });
  });

  it('passes the selected Codex runtime and isolated credential env to summarize worker', async () => {
    harnessSettings.provider = 'codex';
    harnessSettings.authMode = 'api-token';
    harnessSettings.credentials = { codex: 'stored-token' };
    buildHarnessEnvironmentMock
      .mockReturnValueOnce({ PATH: '/usr/bin' })
      .mockReturnValueOnce({ PATH: '/usr/bin', CODEX_API_KEY: 'stored-token' });

    const result = await runCommand({ command: 'summarize', projectId: 'proj1', repo: 'repo1' }, fakeWindow);

    expect(result.started).toBe(true);
    expect(workers).toHaveLength(1);
    expect(workers[0]?.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'summarize',
        harnessProvider: 'codex',
        codexCliPath: '/root/codex',
        nodeEnv: { PATH: '/root:/usr/bin', CODEX_API_KEY: 'stored-token' },
      }),
    );
    cancelCommand(result.id);
  });

  it.each([
    false,
    true,
  ])('runs generated profiles in a sandbox with read-only runtime grants (packaged=%s)', async (packaged) => {
    electronAppMock.isPackaged = packaged;
    vi.stubGlobal(
      'process',
      Object.assign(Object.create(process), { resourcesPath: '/test/Coredoc.app/Contents/Resources' }),
    );
    vi.mocked(resolveRepoPath).mockReturnValue('/tmp/repo');
    vi.mocked(getCurrentConfig).mockReturnValue({
      projects: [],
      parserStorage: './parsers',
      output: { dir: './output' },
    } as never);

    const result = await runCommand({ command: 'parse', projectId: 'proj1', repo: 'repo1' }, fakeWindow);

    expect(result.started).toBe(true);
    expect(workers).toHaveLength(0);
    expect(sandboxLaunchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        databaseUrl: 'file:/tmp/x.db',
        homeDir: '/Users/tester',
        readPaths: expect.arrayContaining(['/tmp/repo']),
        readFiles: expect.arrayContaining(['/config/coredoc.json', '/tmp/output/proj1/repo1.json', '/tmp/x.db']),
        writePaths: expect.arrayContaining(['/tmp/dist/coredoc-parsers/proj1/repo1']),
        writeFiles: expect.arrayContaining(['/tmp/output/proj1/repo1.json', '/tmp/x.db']),
        deniedReadPaths: expect.arrayContaining(['/config/.env', '/tmp/repo/.env']),
        message: expect.objectContaining({ command: 'parse', projectId: 'proj1', repo: 'repo1' }),
      }),
    );
    const policy = sandboxLaunchMock.mock.calls[0][0];
    if (packaged) {
      expect(policy.readPaths).toContain('/test/Coredoc.app/Contents/Frameworks');
      expect(policy.readPaths).toContain('/test/Coredoc.app/Contents/Resources');
      expect([...policy.writePaths, ...policy.writeFiles]).not.toContain('/test/Coredoc.app/Contents/Frameworks');
      expect([...policy.writePaths, ...policy.writeFiles]).not.toContain('/test/Coredoc.app/Contents/Resources');
    }
    expect(sandboxLaunchMock.mock.calls[0][0].message).not.toHaveProperty('nodeEnv');
    expect(sandboxLaunchMock.mock.calls[0][0].message).not.toHaveProperty('nodeExecPath');
    expect(cancelCommand(result.id)).toBe(true);
    expect(sandboxTerminateMock).toHaveBeenCalledOnce();
  });
});
