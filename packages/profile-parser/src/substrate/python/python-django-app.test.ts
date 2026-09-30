import { StableIdGenerator } from '@coredoc/core';
import { describe, expect, it } from 'vitest';
import { type PythonFile, parsePython } from './python-cst.js';
import { buildDjangoAppIndex, djangoAppLabel } from './python-django-app.js';
import { type PythonEntityConfig, extractPythonEntities } from './python-entities.js';

const ID = new StableIdGenerator('/demo', 'demo');
const DJANGO_CFG: PythonEntityConfig = { idGen: ID, baseClasses: ['models.Model'] };

async function pf(relPath: string, source: string): Promise<PythonFile> {
  return { relPath, source, root: await parsePython(source) };
}

const APPS_NAME_ONLY = `
from django.apps import AppConfig


class PostHogConfig(AppConfig):
    name = "posthog"
    verbose_name = "PostHog"
`;

const APPS_WITH_LABEL = `
from django.apps import AppConfig


class SurveysConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "products.surveys.backend"
    label = "surveys"
`;

describe('buildDjangoAppIndex / djangoAppLabel', () => {
  it('reads the AppConfig `name` tail when no explicit label is declared', async () => {
    const index = buildDjangoAppIndex([await pf('posthog/apps.py', APPS_NAME_ONLY)]);
    expect(index.get('posthog')).toBe('posthog');
  });

  it('prefers an explicit AppConfig `label` over the `name` tail', async () => {
    const index = buildDjangoAppIndex([await pf('products/surveys/backend/apps.py', APPS_WITH_LABEL)]);
    // `name` tail would be 'backend' — the declared label wins.
    expect(index.get('products/surveys/backend')).toBe('surveys');
  });

  it('falls back to the directory name for an apps.py with no usable AppConfig', async () => {
    const index = buildDjangoAppIndex([await pf('ee/apps.py', 'x = 1\n')]);
    expect(index.get('ee')).toBe('ee');
  });

  it('resolves a file to its NEAREST ancestor app root', async () => {
    const index = buildDjangoAppIndex([
      await pf('posthog/apps.py', APPS_NAME_ONLY),
      await pf('products/surveys/backend/apps.py', APPS_WITH_LABEL),
    ]);
    expect(djangoAppLabel('posthog/models/cohort/cohort.py', index)).toBe('posthog');
    expect(djangoAppLabel('products/surveys/backend/models/survey.py', index)).toBe('surveys');
  });

  it('falls back to the first path segment when no apps.py is in scope', () => {
    expect(djangoAppLabel('ee/models/license.py', new Map())).toBe('ee');
  });
});

describe('django tableName (G10)', () => {
  it('prefixes the app label from the nearest apps.py', async () => {
    const files = [
      await pf('posthog/apps.py', APPS_NAME_ONLY),
      await pf(
        'posthog/models/cohort/cohort.py',
        `
class Cohort(models.Model):
    name = models.CharField(max_length=50)
`,
      ),
    ];
    const { entities } = await extractPythonEntities(files, DJANGO_CFG);
    expect(entities.find((e) => e.name === 'Cohort')?.tableName).toBe('posthog_cohort');
  });

  it('honors an explicit Meta.app_label over the resolved app root', async () => {
    const files = [
      await pf('posthog/apps.py', APPS_NAME_ONLY),
      await pf(
        'posthog/models/thing.py',
        `
class Thing(models.Model):
    class Meta:
        app_label = "otherapp"
`,
      ),
    ];
    const { entities } = await extractPythonEntities(files, DJANGO_CFG);
    expect(entities.find((e) => e.name === 'Thing')?.tableName).toBe('otherapp_thing');
  });

  it('keeps an explicit Meta.db_table verbatim (no prefixing)', async () => {
    const files = [
      await pf('posthog/apps.py', APPS_NAME_ONLY),
      await pf(
        'posthog/models/thing.py',
        `
class Thing(models.Model):
    class Meta:
        db_table = "posthog_custom"
        app_label = "otherapp"
`,
      ),
    ];
    const { entities } = await extractPythonEntities(files, DJANGO_CFG);
    expect(entities.find((e) => e.name === 'Thing')?.tableName).toBe('posthog_custom');
  });

  it('leaves a non-django ORM on the bare lowercased class name', async () => {
    const files = [
      await pf(
        'app/models.py',
        `
class Thing(Base):
    pass
`,
      ),
    ];
    const { entities } = await extractPythonEntities(files, { idGen: ID, baseClasses: ['Base'], orm: 'sqlalchemy' });
    expect(entities.find((e) => e.name === 'Thing')?.tableName).toBe('thing');
  });
});
