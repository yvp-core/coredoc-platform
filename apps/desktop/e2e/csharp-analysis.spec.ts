import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from './fixtures/launch.js';
import { listCSharpWorkspaceFiles } from '../../../packages/profile-parser/src/substrate/csharp/workspace.js';
import { applyIntegrityReport } from '../../../packages/profile-parser/src/integrity/referential-integrity.js';

function fingerprint(root: string): string {
  const hash = createHash('sha256');
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    hash.update(entry.name).update(readFileSync(join(entry.parentPath, entry.name)));
  }
  return hash.digest('hex');
}
test.describe('desktop C# analysis', () => {
  test.use({ profile: 'csharp-analysis' });
  test.beforeEach(async ({ page }) => {
    page.on('console', (message) => {
      if (message.text().startsWith('parse-proof:')) console.log(message.text());
    });
    await page.evaluate(() => {
      window.electronAPI.onPtyData((event) => console.log('parse-proof:', event.data));
    });
  });
  test('real sandbox prompts, restores after reload, skips to basic and preserves source', async ({
    page,
    app,
    launchProfile,
  }, testInfo) => {
    const repo = join(launchProfile.workspaceDir, 'repos/demo-api');
    writeFileSync(join(repo, 'App.csproj'), '<Project Sdk="Microsoft.NET.Sdk" />');
    writeFileSync(join(repo, 'App.cs'), 'class Worker { void Run() { Save(); } void Save() {} }');
    writeFileSync(
      join(launchProfile.workspaceDir, 'coredoc-parsers/demo/demo-api/profile.ts'),
      "export default { parserId: 'desktop-csharp', substrate: { language: 'csharp', include: ['**/*.cs'] } };\n",
    );
    const before = fingerprint(repo);
    await app.evaluate(() => {
      process.env.COREDOC_SCIP_DOTNET = '/missing/coredoc-test-indexer';
    });
    const command = await page.evaluate(() =>
      window.electronAPI.runCommand({ command: 'parse', projectId: 'demo', repo: 'demo-api' }),
    );
    expect(command.started).toBe(true);
    await expect(page.getByRole('heading', { name: 'Run enhanced C# analysis?' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Run enhanced C# analysis?' })).toBeVisible();
    const dialog = page.getByRole('dialog');
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    const bounds = await dialog.boundingBox();
    for (const button of await dialog.getByRole('button').all()) {
      const rect = await button.boundingBox();
      expect(rect!.x + rect!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width);
    }
    await page.screenshot({ path: testInfo.outputPath('prerequisites.png') });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { name: 'Run enhanced C# analysis?' })).toBeVisible();
    await page.getByRole('button', { name: 'Run enhanced' }).click();
    await expect(page.getByRole('heading', { name: 'Improve C# analysis' })).toBeVisible();
    await page.getByRole('button', { name: 'Check again' }).click();
    await expect(page.getByRole('heading', { name: 'Improve C# analysis' })).toBeVisible();
    await page.getByRole('button', { name: 'Use basic' }).click();
    await expect.poll(async () => (await page.evaluate(() => window.electronAPI.getRunningCommands())).length).toBe(0);
    const output = JSON.parse(
      readFileSync(join(launchProfile.workspaceDir, 'coredoc-output/demo/demo-api.json'), 'utf8'),
    );
    expect(output.stats.analysis).toEqual([
      { language: 'csharp', mode: 'basic', compilerReceiverTypes: false, fallback: false },
    ]);
    expect(output.calls.filter((call: { calleeId?: string }) => call.calleeId)).toHaveLength(1);
    expect(fingerprint(repo)).toBe(before);
  });
  test('strict enhanced cannot skip and cancellation closes the pending dialog', async ({
    page,
    app,
    launchProfile,
  }) => {
    const repo = join(launchProfile.workspaceDir, 'repos/demo-api');
    writeFileSync(join(repo, 'App.csproj'), '<Project Sdk="Microsoft.NET.Sdk" />');
    writeFileSync(join(repo, 'App.cs'), 'class Worker {}');
    writeFileSync(
      join(launchProfile.workspaceDir, 'coredoc-parsers/demo/demo-api/profile.ts'),
      "export default { parserId: 'strict', substrate: { language: 'csharp', include: ['**/*.cs'], analysis: { mode: 'enhanced', fallback: false } } };\n",
    );
    await app.evaluate(() => {
      process.env.COREDOC_SCIP_DOTNET = '/missing/coredoc-test-indexer';
    });
    const result = await page.evaluate(() =>
      window.electronAPI.runCommand({ command: 'parse', projectId: 'demo', repo: 'demo-api' }),
    );
    expect(result.started).toBe(true);
    await expect(page.getByRole('heading', { name: 'Run enhanced C# analysis?' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Use basic' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Cancel analysis' }).click();
    await expect(page.getByRole('heading', { name: 'Run enhanced C# analysis?' })).toHaveCount(0);
    await expect.poll(async () => (await page.evaluate(() => window.electronAPI.getRunningCommands())).length).toBe(0);
  });
  test('installed compiler tools produce enhanced facts through the real desktop sandbox', async ({
    page,
    app,
    launchProfile,
  }) => {
    test.skip(
      !process.env.COREDOC_TEST_DOTNET_DIR || !process.env.COREDOC_TEST_SCIP_DOTNET,
      'Optional installed compiler tools are required for this live test.',
    );
    const repo = join(launchProfile.workspaceDir, 'repos/demo-api');
    writeFileSync(
      join(repo, 'App.csproj'),
      '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>',
    );
    writeFileSync(join(repo, 'App.cs'), 'class Worker { void Run() { Save(); } void Save() {} }');
    writeFileSync(
      join(launchProfile.workspaceDir, 'coredoc-parsers/demo/demo-api/profile.ts'),
      "export default { parserId: 'enhanced', substrate: { language: 'csharp', include: ['**/*.cs'], analysis: { mode: 'enhanced', fallback: false } } };\n",
    );
    const before = fingerprint(repo);
    await app.evaluate(
      (_electron, tools) => {
        process.env.PATH = `${tools.sdk}:${process.env.PATH}`;
        process.env.COREDOC_SCIP_DOTNET = tools.indexer;
      },
      { sdk: process.env.COREDOC_TEST_DOTNET_DIR!, indexer: process.env.COREDOC_TEST_SCIP_DOTNET! },
    );
    const result = await page.evaluate(() =>
      window.electronAPI.runCommand({ command: 'parse', projectId: 'demo', repo: 'demo-api' }),
    );
    expect(result.started).toBe(true);
    await expect(page.getByRole('button', { name: 'Run enhanced' })).toBeVisible();
    expect(await page.evaluate(() => window.electronAPI.getRunningCommands())).toHaveLength(1);
    await page.getByRole('button', { name: 'Run enhanced' }).click();
    await expect
      .poll(async () => (await page.evaluate(() => window.electronAPI.getRunningCommands())).length, {
        timeout: 60_000,
      })
      .toBe(0);
    const output = JSON.parse(
      readFileSync(join(launchProfile.workspaceDir, 'coredoc-output/demo/demo-api.json'), 'utf8'),
    );
    expect(output.stats.analysis[0]).toMatchObject({ language: 'csharp', mode: 'enhanced', fallback: false });
    expect(output.calls.filter((call: { calleeId?: string }) => call.calleeId)).toHaveLength(1);
    expect(fingerprint(repo)).toBe(before);
  });
  test('explicit Install downloads the published tool and continues enhanced with defines', async ({
    page,
    app,
    launchProfile,
  }, testInfo) => {
    test.skip(
      !process.env.COREDOC_TEST_INSTALL_CSHARP || !process.env.COREDOC_TEST_DOTNET_DIR,
      'Explicit opt-in to download the published release and use an installed SDK.',
    );
    test.setTimeout(180_000);
    const repo = join(launchProfile.workspaceDir, 'repos/demo-api');
    const toolsHome = join(launchProfile.homeDir, '.coredoc');
    writeFileSync(
      join(repo, 'App.csproj'),
      '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>',
    );
    writeFileSync(
      join(repo, 'App.cs'),
      '#if FEATURE_ONE && FEATURE_TWO\nclass Worker { void Run() { Save(); } void Save() {} }\n#endif\n',
    );
    writeFileSync(
      join(launchProfile.workspaceDir, 'coredoc-parsers/demo/demo-api/profile.ts'),
      "export default { parserId: 'install', substrate: { language: 'csharp', include: ['**/*.cs'], defines: ['FEATURE_ONE', 'FEATURE_TWO'], analysis: { mode: 'enhanced', fallback: false } } };\n",
    );
    const before = fingerprint(repo);
    await app.evaluate(
      (_electron, paths) => {
        process.env.PATH = `${paths.sdk}:${process.env.PATH}`;
        delete process.env.COREDOC_SCIP_DOTNET;
      },
      { sdk: process.env.COREDOC_TEST_DOTNET_DIR!, toolsHome },
    );
    expect(
      (
        await page.evaluate(() =>
          window.electronAPI.runCommand({ command: 'parse', projectId: 'demo', repo: 'demo-api' }),
        )
      ).started,
    ).toBe(true);
    await page.getByRole('button', { name: 'Run enhanced' }).click();
    await expect(page.getByRole('heading', { name: 'Improve C# analysis' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Install C# indexer' })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('install-prerequisites.png') });
    await page.getByRole('button', { name: 'Install C# indexer' }).click();
    await expect(page.getByRole('heading', { name: 'Installing C# indexer' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Installing C# indexer' })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('install-progress.png') });
    await expect
      .poll(async () => (await page.evaluate(() => window.electronAPI.getRunningCommands())).length, {
        timeout: 150_000,
      })
      .toBe(0);
    const output = JSON.parse(
      readFileSync(join(launchProfile.workspaceDir, 'coredoc-output/demo/demo-api.json'), 'utf8'),
    );
    expect(output.stats.analysis).toEqual([
      { language: 'csharp', mode: 'enhanced', compilerReceiverTypes: true, fallback: false },
    ]);
    expect(output.calls.filter((call: { calleeId?: string }) => call.calleeId)).toHaveLength(1);
    expect(readdirSync(join(toolsHome, 'tools/scip-dotnet'))).toEqual(['0.2.15-coredoc.1']);
    expect(fingerprint(repo)).toBe(before);
  });
  test('TS uses structural fallback without activating an incidental C# project', async ({
    page,
    app,
    launchProfile,
  }) => {
    const repo = join(launchProfile.workspaceDir, 'repos/demo-api');
    writeFileSync(join(repo, 'App.csproj'), '<Project Sdk="Microsoft.NET.Sdk" />');
    writeFileSync(join(repo, 'main.ts'), 'export function run() { return 42; }');
    writeFileSync(
      join(launchProfile.workspaceDir, 'coredoc-parsers/demo/demo-api/profile.ts'),
      "export default { parserId: 'typescript', substrate: { language: 'ts', include: ['main.ts'] } };\n",
    );
    const before = fingerprint(repo);
    await app.evaluate(() => {
      process.env.COREDOC_SCIP_DOTNET = '/missing/coredoc-test-indexer';
    });
    const result = await page.evaluate(async () => {
      let logs = '';
      const stopLogs = window.electronAPI.onPtyData((event) => {
        logs += event.data;
      });
      const completed = new Promise<boolean>((resolve) => {
        const stop = window.electronAPI.onCommandCompleted((result) => {
          stop();
          resolve(result.success);
        });
      });
      const command = await window.electronAPI.runCommand({ command: 'parse', projectId: 'demo', repo: 'demo-api' });
      const success = await completed;
      stopLogs();
      return { command, success, logs };
    });
    expect(result.command.started).toBe(true);
    expect(result.success).toBe(true);
    expect(result.logs).toContain('node_modules not installed');
    expect(result.logs).not.toContain('C#');
    expect(await page.evaluate(() => window.electronAPI.getAnalysisPrompts())).toEqual([]);
    const output = JSON.parse(
      readFileSync(join(launchProfile.workspaceDir, 'coredoc-output/demo/demo-api.json'), 'utf8'),
    );
    expect(output.functions).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'run' })]));
    expect(output.errors).toEqual([
      expect.objectContaining({ severity: 'warning', message: expect.stringContaining('node_modules not installed') }),
    ]);
    expect(fingerprint(repo)).toBe(before);
  });

  test('reference repository through the desktop compiler host', async ({ page, app, launchProfile }, testInfo) => {
    test.skip(
      !process.env.COREDOC_TEST_REFERENCE_REPO || !process.env.COREDOC_TEST_REFERENCE_PROFILE,
      'Optional real repository proof.',
    );
    test.setTimeout(600_000);
    const repo = process.env.COREDOC_TEST_REFERENCE_REPO!;
    const sourceFingerprint = () => {
      const hash = createHash('sha256');
      for (const file of listCSharpWorkspaceFiles(repo).sort()) {
        hash
          .update(file)
          .update('\0')
          .update(readFileSync(join(repo, file)));
      }
      return hash.digest('hex');
    };
    const before = sourceFingerprint();
    const configPath = join(launchProfile.workspaceDir, 'coredoc.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.projects[0].repos[0].path = repo;
    writeFileSync(configPath, JSON.stringify(config));
    writeFileSync(
      join(launchProfile.workspaceDir, 'coredoc-parsers/demo/demo-api/profile.ts'),
      readFileSync(process.env.COREDOC_TEST_REFERENCE_PROFILE!),
    );
    expect((await page.evaluate((config) => window.electronAPI.loadConfig(config), configPath)).success).toBe(true);
    await app.evaluate(
      (_electron, tools) => {
        process.env.PATH = `${tools.sdk}:${process.env.PATH}`;
        process.env.COREDOC_SCIP_DOTNET = tools.indexer;
      },
      { sdk: process.env.COREDOC_TEST_DOTNET_DIR!, indexer: process.env.COREDOC_TEST_SCIP_DOTNET! },
    );
    const command = await page.evaluate(() =>
      window.electronAPI.runCommand({ command: 'parse', projectId: 'demo', repo: 'demo-api' }),
    );
    expect(command.started).toBe(true);
    await expect(page.getByRole('button', { name: 'Run enhanced' })).toBeVisible();
    expect(await page.evaluate(() => window.electronAPI.getRunningCommands())).toHaveLength(1);
    await page.getByRole('button', { name: 'Run enhanced' }).click();
    await expect
      .poll(async () => (await page.evaluate(() => window.electronAPI.getRunningCommands())).length, {
        timeout: 540_000,
      })
      .toBe(0);
    const output = JSON.parse(
      readFileSync(join(launchProfile.workspaceDir, 'coredoc-output/demo/demo-api.json'), 'utf8'),
    );
    expect(output.stats.analysis[0]).toMatchObject({ mode: 'enhanced', fallback: false });
    expect((output.errors ?? []).filter((error: { severity: string }) => error.severity === 'error')).toEqual([]);
    expect(applyIntegrityReport(output).violations).toEqual([]);
    expect(sourceFingerprint()).toBe(before);
    const outputPath = testInfo.outputPath('reference-graph.json');
    writeFileSync(outputPath, JSON.stringify(output));
    await testInfo.attach('reference-graph', { path: outputPath, contentType: 'application/json' });
    console.log(
      JSON.stringify({
        sourceFingerprint: before,
        files: output.files.length,
        calls: output.calls.length,
        resolvedCalls: output.calls.filter((call: { calleeId?: string }) => call.calleeId).length,
        entrypoints: output.entrypoints.length,
        dbOperations: output.dbOperations.length,
        analysis: output.stats.analysis,
      }),
    );
  });
});
