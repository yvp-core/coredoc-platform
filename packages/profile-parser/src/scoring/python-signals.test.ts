import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PythonProfile } from '../types/python-profile.js';
import { pythonSourceSignals } from './python-signals.js';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** Write a repo. `checkoutDir` nests it, to model where the repo actually lives on disk. */
function repo(files: Record<string, string>, checkoutDir = ''): string {
  const base = mkdtempSync(join(tmpdir(), 'py-signals-'));
  roots.push(base);
  const root = checkoutDir ? join(base, checkoutDir) : base;
  mkdirSync(root, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

const profile: PythonProfile = {
  parserId: 'py-v1',
  substrate: { language: 'python', include: ['**/*.py'] },
};

const FILES = {
  'app/urls.py': "path('users/', views.users)\nre_path(r'^orders/$', views.orders)\n",
  'app/models.py': 'class User(models.Model):\n    pass\n',
  'app/tests/urls.py': "path('nope/', views.nope)\n",
  'app/migrations/0001_initial.py': 'class Migration(models.Model):\n    pass\n',
};

describe('pythonSourceSignals', () => {
  it('counts the same route and model sources the parser includes, excluding migration defaults', () => {
    expect(pythonSourceSignals(repo(FILES), profile)).toEqual({ http: 3, entities: 1 });
  });

  it('does not let the CHECKOUT path zero the denominators', () => {
    // grep echoes absolute paths, so testing the noise regex against the whole line makes a repo
    // living under `~/tests/…` or `…/venv/…` drop every match. A zero denominator scores
    // `not_applicable`, which the scorer reads as PASS — the failure mode is a false PASS.
    for (const dir of ['tests/api', 'node_modules/api', '.venv/api', 'migrations/api']) {
      expect(pythonSourceSignals(repo(FILES, dir), profile), dir).toEqual({ http: 3, entities: 1 });
    }
  });

  it('does not count route or entity signals from profile-excluded generated sources', () => {
    const root = repo({
      'app/urls.py': "path('live/', views.live)\n",
      'app/models.py': 'class Live(models.Model):\n    pass\n',
      'generated/urls.py': "path('generated/', views.generated)\n",
      'generated/models.py': 'class Generated(models.Model):\n    pass\n',
    });
    const scoped: PythonProfile = {
      ...profile,
      substrate: { language: 'python', include: ['**/*.py'], exclude: ['generated/**'] },
    };

    expect(pythonSourceSignals(root, scoped)).toEqual({ http: 1, entities: 1 });
  });
});
