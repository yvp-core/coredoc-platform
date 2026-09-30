import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from './fixtures/launch.js';

function fingerprint(root: string): string {
  const hash = createHash('sha256');
  for (const file of readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .sort((a, b) => a.name.localeCompare(b.name)))
    hash.update(file.name).update(readFileSync(join(file.parentPath, file.name)));
  return hash.digest('hex');
}

for (const fixture of [
  {
    language: 'ruby',
    title: 'Ruby',
    file: 'app.rb',
    source: '# typed: true\nclass Parent\n  def save; 1; end\nend\nclass Child < Parent\n  def run; save; end\nend\n',
    install: 'COREDOC_TEST_INSTALL_RUBY',
  },
  {
    language: 'python',
    title: 'Python',
    file: 'app.py',
    source:
      'class Parent:\n    def save(self):\n        return 1\n\nclass Child(Parent):\n    def run(self):\n        return self.save()\n',
    install: 'COREDOC_TEST_INSTALL_PYTHON',
  },
])
  test.describe(`desktop ${fixture.title} analysis`, () => {
    // Reuse the isolated analysis workspace, without changing its shared fixture files.
    test.use({ profile: 'csharp-analysis' });
    for (const enhanced of [false, true]) {
      test(
        enhanced ? 'explicitly installs and parses with optional indexer' : 'chooses basic without installing tools',
        async ({ page, launchProfile }, testInfo) => {
          test.skip(enhanced && !process.env[fixture.install], 'Explicit opt-in for the release download.');
          test.setTimeout(180_000);
          let outputLog = '';
          page.on('console', (message) => {
            if (message.text().startsWith('indexer-proof:')) {
              outputLog += message.text();
              console.log(message.text());
            }
          });
          await page.evaluate(() => {
            window.electronAPI.onPtyData((event) => console.log('indexer-proof:', event.data));
          });
          const repo = join(launchProfile.workspaceDir, 'repos/demo-api');
          writeFileSync(join(repo, fixture.file), fixture.source);
          writeFileSync(
            join(launchProfile.workspaceDir, 'coredoc-parsers/demo/demo-api/profile.ts'),
            `export default { parserId: '${fixture.language}-analysis', substrate: { language: '${fixture.language}', include: ['**/*.${fixture.file.split('.').at(-1)}'] } };\n`,
          );
          const before = fingerprint(repo);
          expect(
            (
              await page.evaluate(() =>
                window.electronAPI.runCommand({ command: 'parse', projectId: 'demo', repo: 'demo-api' }),
              )
            ).started,
          ).toBe(true);
          await expect(page.getByRole('heading', { name: `Run enhanced ${fixture.title} analysis?` })).toBeVisible();
          if (enhanced) {
            await page.getByRole('button', { name: 'Run enhanced' }).click();
            await expect(page.getByRole('heading', { name: `Improve ${fixture.title} analysis` })).toBeVisible();
            await expect(page.getByRole('button', { name: 'Get .NET SDK' })).toHaveCount(0);
            await page.screenshot({ path: testInfo.outputPath('indexer-install.png') });
            await page.getByRole('button', { name: `Install ${fixture.title} indexer` }).click();
          } else {
            await page.screenshot({ path: testInfo.outputPath('indexer-mode.png') });
            await page.getByRole('button', { name: 'Use basic' }).click();
          }
          await expect
            .poll(async () => (await page.evaluate(() => window.electronAPI.getRunningCommands())).length, {
              timeout: 150_000,
            })
            .toBe(0);
          const output = JSON.parse(
            readFileSync(join(launchProfile.workspaceDir, 'coredoc-output/demo/demo-api.json'), 'utf8'),
          );
          expect(output.stats.analysis).toEqual([
            {
              language: fixture.language,
              mode: enhanced ? 'enhanced' : 'basic',
              compilerReceiverTypes: false,
              fallback: false,
            },
          ]);
          if (enhanced) expect(output.calls.some((e: { provenance: string }) => e.provenance === 'scip')).toBe(true);
          expect(outputLog).not.toContain("couldn't create cache file");
          expect(fingerprint(repo)).toBe(before);
        },
      );
    }
  });
