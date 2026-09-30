import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseMultiTarget } from './multi/orchestrate.js';
import { scoreProfile } from './score.js';
import type { MultiTargetProfile } from './types/multi-profile.js';

let fixtureDir: string | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  fixtureDir = undefined;
});

describe('scoreProfile completion marker', () => {
  it('marks an invisible Next API surface BLOCKED end to end', async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'profile-score-completion-'));
    const repoRoot = join(fixtureDir, 'repo');
    const routeDir = join(repoRoot, 'app', 'api', 'health');
    mkdirSync(routeDir, { recursive: true });
    mkdirSync(join(repoRoot, 'node_modules'));
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ private: true, dependencies: { next: '^15.0.0' } }));
    writeFileSync(join(routeDir, 'route.ts'), 'export async function GET() { return new Response("ok"); }\n');

    const profilePath = join(fixtureDir, 'profile.ts');
    writeFileSync(
      profilePath,
      `import type { ExtractionProfile } from '@coredoc/profile-parser';
const profile: ExtractionProfile = {
  parserId: 'fixture/completion',
  repoType: 'frontend',
  substrate: { language: 'ts', include: ['**/*.ts'] },
};
export default profile;
`,
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));
    vi.spyOn(console, 'table').mockImplementation(() => undefined);

    await expect(scoreProfile(profilePath, repoRoot)).resolves.toBe(false);
    const rendered = output.join('\n');
    expect(rendered).toContain('=== Overall: FAIL ===');
    expect(rendered).toContain('=== Profile completion: BLOCKED ===');
    expect(rendered).toContain('Next.js App Router API-handler');
  });

  it('marks an invisible Next page-route surface BLOCKED end to end', async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'profile-score-completion-'));
    const repoRoot = join(fixtureDir, 'repo');
    const pageDir = join(repoRoot, 'apps', 'web', 'app');
    mkdirSync(pageDir, { recursive: true });
    mkdirSync(join(repoRoot, 'node_modules'));
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ private: true }));
    writeFileSync(
      join(repoRoot, 'apps', 'web', 'package.json'),
      JSON.stringify({ name: 'web', private: true, dependencies: { next: '^15.0.0' } }),
    );
    writeFileSync(join(pageDir, 'page.tsx'), 'export default function Page() { return null; }\n');

    const profilePath = join(fixtureDir, 'profile.ts');
    writeFileSync(
      profilePath,
      `import type { ExtractionProfile } from '@coredoc/profile-parser';
const profile: ExtractionProfile = {
  parserId: 'fixture/page-completion',
  repoType: 'frontend',
  substrate: { language: 'ts', include: ['**/*.ts', '**/*.tsx'] },
};
export default profile;
`,
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));
    vi.spyOn(console, 'table').mockImplementation(() => undefined);

    await expect(scoreProfile(profilePath, repoRoot)).resolves.toBe(false);
    const rendered = output.join('\n');
    expect(rendered).toContain('RED routes:');
    expect(rendered).toContain('routes.fileConvention');
    expect(rendered).toContain('=== Overall: FAIL ===');
    expect(rendered).toContain('=== Profile completion: BLOCKED ===');
  });

  it('blocks a single-target profile whose include omits a source root', async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'profile-score-completion-'));
    const repoRoot = join(fixtureDir, 'repo');
    const apiDir = join(repoRoot, 'packages', 'api', 'src');
    const webDir = join(repoRoot, 'apps', 'web', 'app');
    mkdirSync(apiDir, { recursive: true });
    mkdirSync(webDir, { recursive: true });
    mkdirSync(join(repoRoot, 'node_modules'));
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ private: true }));
    writeFileSync(join(apiDir, 'index.ts'), 'export const apiVersion = 1;\n');
    writeFileSync(join(webDir, 'page.tsx'), 'export default function Page() { return null; }\n');

    const profilePath = join(fixtureDir, 'profile.ts');
    writeFileSync(
      profilePath,
      `import type { ExtractionProfile } from '@coredoc/profile-parser';
const profile: ExtractionProfile = {
  parserId: 'fixture/narrow-single-target',
  repoType: 'frontend',
  substrate: { language: 'ts', include: ['packages/api/**/*.ts'] },
};
export default profile;
`,
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));
    vi.spyOn(console, 'table').mockImplementation(() => undefined);

    await expect(scoreProfile(profilePath, repoRoot)).resolves.toBe(false);
    const rendered = output.join('\n');
    expect(rendered).toContain('=== Unclaimed scope ===');
    expect(rendered).toContain('1/2 known-language files claimed by no target');
    expect(rendered).toContain('apps (1)');
    expect(rendered).toContain('=== Overall: FAIL ===');
    expect(rendered).toContain('=== Profile completion: BLOCKED ===');
  });

  it('blocks a profile-authored exclude-all instead of promoting an empty graph', async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'profile-score-completion-'));
    const repoRoot = join(fixtureDir, 'repo');
    mkdirSync(join(repoRoot, 'src'), { recursive: true });
    mkdirSync(join(repoRoot, 'node_modules'));
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ private: true }));
    writeFileSync(join(repoRoot, 'src', 'app.ts'), 'export const app = true;\n');

    const profilePath = join(fixtureDir, 'profile.ts');
    writeFileSync(
      profilePath,
      `import type { ExtractionProfile } from '@coredoc/profile-parser';
const profile: ExtractionProfile = {
  parserId: 'fixture/exclude-all',
  repoType: 'library',
  substrate: { language: 'ts', include: ['**/*.ts'], exclude: ['**/*'] },
};
export default profile;
`,
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));
    vi.spyOn(console, 'table').mockImplementation(() => undefined);

    await expect(scoreProfile(profilePath, repoRoot)).resolves.toBe(false);
    const rendered = output.join('\n');
    expect(rendered).toContain('1/1 known-language files claimed by no target');
    expect(rendered).toContain('=== Overall: FAIL ===');
    expect(rendered).toContain('=== Profile completion: BLOCKED ===');
  });

  it('rejects targets that split one canonical provider before scoring or parsing', async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'profile-score-completion-'));
    const repoRoot = join(fixtureDir, 'repo');
    mkdirSync(join(repoRoot, 'src'), { recursive: true });
    mkdirSync(join(repoRoot, 'node_modules'));
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ private: true }));
    writeFileSync(join(repoRoot, 'src', 'app.ts'), 'export const app = true;\n');

    const profile: MultiTargetProfile = {
      parserId: 'fixture/overlap',
      repoType: 'monorepo',
      targets: [
        { name: 'one', repoType: 'library', substrate: { language: 'ts', include: ['src/**/*.ts'] } },
        { name: 'two', repoType: 'library', substrate: { language: 'js', include: ['scripts/**/*.js'] } },
      ],
    };
    const profilePath = join(fixtureDir, 'profile.ts');
    writeFileSync(
      profilePath,
      `import type { MultiTargetProfile } from '@coredoc/profile-parser';
const profile: MultiTargetProfile = ${JSON.stringify(profile, null, 2)};
export default profile;
`,
    );

    const sameProvider = /Targets 'one' \(language 'ts'\).*'two' \(language 'js'\).*canonical 'ts'/i;
    await expect(scoreProfile(profilePath, repoRoot)).rejects.toThrow(sameProvider);
    await expect(parseMultiTarget(profile, { repoRoot, repoName: 'overlap' })).rejects.toThrow(sameProvider);
  });

  it('does not block Next-shaped paths in a package without a Next dependency', async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'profile-score-completion-'));
    const repoRoot = join(fixtureDir, 'repo');
    mkdirSync(join(repoRoot, 'app', 'api', 'health'), { recursive: true });
    mkdirSync(join(repoRoot, 'src', 'pages'), { recursive: true });
    mkdirSync(join(repoRoot, 'node_modules'));
    writeFileSync(
      join(repoRoot, 'package.json'),
      JSON.stringify({ private: true, dependencies: { react: '^19.0.0' } }),
    );
    writeFileSync(join(repoRoot, 'app', 'page.tsx'), 'export default function AppPage() { return null; }\n');
    writeFileSync(
      join(repoRoot, 'app', 'api', 'health', 'route.ts'),
      'export async function GET() { return new Response("ok"); }\n',
    );
    writeFileSync(join(repoRoot, 'src', 'pages', 'Home.tsx'), 'export default function Home() { return null; }\n');

    const profilePath = join(fixtureDir, 'profile.ts');
    writeFileSync(
      profilePath,
      `import type { ExtractionProfile } from '@coredoc/profile-parser';
const profile: ExtractionProfile = {
  parserId: 'fixture/non-next-paths',
  repoType: 'frontend',
  substrate: { language: 'ts', include: ['**/*.ts', '**/*.tsx'] },
};
export default profile;
`,
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));
    vi.spyOn(console, 'table').mockImplementation(() => undefined);

    await expect(scoreProfile(profilePath, repoRoot)).resolves.toBe(true);
    const rendered = output.join('\n');
    expect(rendered).toContain("does not declare 'next'");
    expect(rendered).not.toContain('RED routes:');
    expect(rendered).not.toContain('RED api-handlers:');
    expect(rendered).toContain('=== Overall: PASS ===');
    expect(rendered).toContain('=== Profile completion: PASS ===');
  });

  it('audits Ruby provider source intent even though its ParsedRepo has no FileNodes', async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'profile-score-completion-'));
    const repoRoot = join(fixtureDir, 'repo');
    mkdirSync(join(repoRoot, 'app'), { recursive: true });
    mkdirSync(join(repoRoot, 'tasks'), { recursive: true });
    mkdirSync(join(repoRoot, 'spec'), { recursive: true });
    mkdirSync(join(repoRoot, 'scripts'), { recursive: true });
    writeFileSync(join(repoRoot, 'app', 'main.rb'), '# application source\n');
    writeFileSync(join(repoRoot, 'tasks', 'setup.rake'), '# rake source\n');
    writeFileSync(join(repoRoot, 'spec', 'widget_spec.rb'), '# default-excluded test\n');
    writeFileSync(join(repoRoot, 'scripts', 'legacy.py'), '# inventoried non-target helper\n');

    const profilePath = join(fixtureDir, 'profile.ts');
    writeFileSync(
      profilePath,
      `import type { RubyProfile } from '@coredoc/profile-parser';
const profile: RubyProfile = {
  parserId: 'fixture/ruby-source-scope',
  repoType: 'backend',
  substrate: {
    language: 'ruby',
    include: ['**/*.rb', '**/*.rake'],
    exclude: ['scripts/legacy.py'],
  },
  entrypoints: {
    grape: { enabled: false },
    railsRoutes: { enabled: false },
    queue: { enabled: false },
  },
};
export default profile;
`,
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));
    vi.spyOn(console, 'table').mockImplementation(() => undefined);

    await expect(scoreProfile(profilePath, repoRoot)).resolves.toBe(true);
    const rendered = output.join('\n');
    expect(rendered).toContain('0/4 known-language files claimed by no target');
    expect(rendered).toContain('2 known-language file(s) intentionally excluded by target scope');
    expect(rendered).toContain('=== Overall: PASS ===');
    expect(rendered).toContain('=== Profile completion: PASS ===');
  });

  it('does not block a Go profile for signals in an intentionally excluded generated tree', async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'profile-score-completion-'));
    const repoRoot = join(fixtureDir, 'repo');
    mkdirSync(join(repoRoot, 'cmd'), { recursive: true });
    mkdirSync(join(repoRoot, 'generated'), { recursive: true });
    writeFileSync(
      join(repoRoot, 'cmd', 'main.go'),
      'package main\n\nfunc routes() {\n\tr.Get("/live", live)\n}\nfunc live() {}\n',
    );
    writeFileSync(
      join(repoRoot, 'generated', 'routes.go'),
      'package generated\n\nfunc routes() {\n\tr.Get("/one", h)\n\tr.Get("/two", h)\n\tr.Get("/three", h)\n\tr.Get("/four", h)\n}\n',
    );

    const profilePath = join(fixtureDir, 'profile.ts');
    writeFileSync(
      profilePath,
      `import type { GoProfile } from '@coredoc/profile-parser';
const profile: GoProfile = {
  parserId: 'fixture/go-excluded-generated',
  repoType: 'backend',
  substrate: { language: 'go', include: ['**/*.go'], exclude: ['generated/**'] },
};
export default profile;
`,
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));
    vi.spyOn(console, 'table').mockImplementation(() => undefined);

    await expect(scoreProfile(profilePath, repoRoot)).resolves.toBe(true);
    const rendered = output.join('\n');
    expect(rendered).toContain('1 known-language file(s) intentionally excluded by target scope');
    expect(rendered).toContain('=== Overall: PASS ===');
    expect(rendered).toContain('=== Profile completion: PASS ===');
  });
});
