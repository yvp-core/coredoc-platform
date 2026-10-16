import { type HttpEntrypointDetails, StableIdGenerator } from '@coredoc/core';
import { describe, expect, it } from 'vitest';
import { isSyntheticHandlerId } from '../../integrity/referential-integrity.js';
import { indexPythonDefs } from './python-callgraph.js';
import { type PythonFile } from './python-cst.js';
import { extractPythonEntrypoints } from './python-entrypoints.js';
import { parseSource } from '../../tree-sitter/tree-sitter-loader.js';

const ID = new StableIdGenerator('/demo', 'demo');

async function file(relPath: string, source: string): Promise<PythonFile> {
  return { relPath, source, root: await parseSource('python', source) };
}

/** `${method} ${fullPath}` for every http entrypoint. */
function httpKeys(eps: ReturnType<typeof extractPythonEntrypoints>): string[] {
  return eps
    .filter((e) => e.type === 'http')
    .map((e) => {
      const d = e.details as HttpEntrypointDetails;
      return `${d.method} ${d.fullPath}`;
    });
}

/** The entrypoint serving `${method} ${fullPath}`. */
function at(eps: ReturnType<typeof extractPythonEntrypoints>, key: string) {
  return eps.find((e) => {
    const d = e.details as HttpEntrypointDetails;
    return e.type === 'http' && `${d.method} ${d.fullPath}` === key;
  });
}

/** Every id `indexPythonDefs` mints — the FunctionNodes the parse emits. */
function functionIds(files: PythonFile[]): Set<string> {
  return new Set(indexPythonDefs(files, ID).byId.keys());
}

// A posthog-shaped router table: a root router mounted under `api/` by another file, a nested
// registration carrying its parent lookup, a grandchild, and a router imported by a third file.
const API_INIT = `
from rest_framework_extensions.routers import NestedDefaultRouter
from posthog.api import project
from posthog.api.feature_flag import FeatureFlagViewSet
from posthog.api.task import TaskViewSet, TaskRunViewSet

router = NestedDefaultRouter()
router.register(r"llm_proxy", LLMProxyViewSet, "llm_proxy")
projects_router = router.register(r"projects", project.RootProjectViewSet, "projects")
projects_router.register(r"feature_flags", FeatureFlagViewSet, "project_feature_flags", ["team_id"])
project_tasks_router = projects_router.register(r"tasks", TaskViewSet, "project_tasks", ["team_id"])
project_tasks_router.register(r"runs", TaskRunViewSet, "project_task_runs", ["team_id", "task_id"])
`;

const ROOT_URLS = `
from django.urls import path, include
from posthog.api import router

urlpatterns = [
    path("api/", include(router.urls)),
]
`;

const EE_URLS = `
def extend_api_router() -> None:
    from posthog.api import router as root_router
    from ee.api import billing

    root_router.register(r"billing", billing.BillingViewset, "billing")
`;

const PROJECT_VIEWSET = `
from rest_framework import viewsets

class RootProjectViewSet(viewsets.ModelViewSet):
    def list(self, request):
        pass

    def retrieve(self, request, pk=None):
        pass
`;

const FEATURE_FLAG_VIEWSET = `
from rest_framework.decorators import action

class FeatureFlagViewSet(BaseViewSet):
    def list(self, request):
        pass

    @action(methods=["POST"], detail=True, url_path="my/activity")
    def activity(self, request, **kwargs):
        pass

    @action(detail=False)
    def local_evaluation(self, request, **kwargs):
        pass
`;

const TASK_VIEWSETS = `
class TaskViewSet(BaseViewSet):
    pass

class TaskRunViewSet(BaseViewSet):
    pass
`;

const tree = (): Promise<PythonFile[]> =>
  Promise.all([
    file('posthog/__init__.py', ''),
    file('posthog/urls.py', ROOT_URLS),
    file('posthog/api/__init__.py', API_INIT),
    file('posthog/api/project.py', PROJECT_VIEWSET),
    file('posthog/api/feature_flag.py', FEATURE_FLAG_VIEWSET),
    file('posthog/api/task.py', TASK_VIEWSETS),
    file('ee/__init__.py', ''),
    file('ee/urls.py', EE_URLS),
    file('ee/api/__init__.py', ''),
  ]);

const CFG = { routeFileGlobs: ['**/urls.py', 'posthog/api/__init__.py'] };

describe('DRF router lane — router-object mounts (G5)', () => {
  it('prefixes a router registered table with the path() that includes <router>.urls', async () => {
    const keys = httpKeys(extractPythonEntrypoints(await tree(), ID, CFG));
    expect(keys).toContain('GET /api/llm_proxy/');
    expect(keys).toContain('DELETE /api/llm_proxy/{pk}/');
    // The unprefixed spelling is the bug this closes.
    expect(keys).not.toContain('GET /llm_proxy/');
  });

  it('does not emit the include(<router>.urls) mount itself as an endpoint', async () => {
    const keys = httpKeys(extractPythonEntrypoints(await tree(), ID, CFG));
    expect(keys).not.toContain('GET /api/');
  });

  it('follows a router imported into another route file (the ee/* prefix bug)', async () => {
    const keys = httpKeys(extractPythonEntrypoints(await tree(), ID, CFG));
    expect(keys).toContain('GET /api/billing/');
    expect(keys).not.toContain('GET /billing/');
    // The registration is declared in ee/urls.py, so that is the file the entrypoint is scoped to.
    expect(at(extractPythonEntrypoints(await tree(), ID, CFG), 'GET /api/billing/')?.location.filePath).toBe(
      'ee/urls.py',
    );
  });
});

describe('DRF router lane — nested routers (G5)', () => {
  it('composes the parent prefix and the DECLARED parent lookup', async () => {
    const keys = httpKeys(extractPythonEntrypoints(await tree(), ID, CFG));
    expect(keys).toContain('GET /api/projects/{parent_lookup_team_id}/feature_flags/');
    expect(keys).toContain('PATCH /api/projects/{parent_lookup_team_id}/feature_flags/{pk}/');
  });

  it('composes a grandchild router with one lookup per level', async () => {
    const keys = httpKeys(extractPythonEntrypoints(await tree(), ID, CFG));
    expect(keys).toContain('GET /api/projects/{parent_lookup_team_id}/tasks/{parent_lookup_task_id}/runs/');
  });

  it('degrades a nested registration with no declared lookups to the positional {_} token', async () => {
    const src = `
from rest_framework_extensions.routers import NestedDefaultRouter
router = NestedDefaultRouter()
parent = router.register(r"projects", ProjectViewSet)
parent.register(r"items", ItemViewSet)
`;
    const keys = httpKeys(extractPythonEntrypoints([await file('app/urls.py', src)], ID, {}));
    expect(keys).toContain('GET /projects/{_}/items/');
  });

  it('keeps the pre-existing file-prefix behaviour when the router lineage is opaque', async () => {
    // `a, b = helper(...)` — a tuple-unpacked router has no derivable parent; the registration
    // must keep the file's own mount prefix rather than being dropped or guessed.
    const root = `
from django.urls import path, include
urlpatterns = [path("api/", include("app.urls"))]
`;
    const src = `
env_router, legacy_router = register_grandfathered(r"plugin_configs", PluginConfigViewSet)
env_router.register(r"logs", PluginLogEntryViewSet, "logs", ["team_id"])
`;
    const keys = httpKeys(
      extractPythonEntrypoints(
        await Promise.all([file('config/urls.py', root), file('app/__init__.py', ''), file('app/urls.py', src)]),
        ID,
        {},
      ),
    );
    expect(keys).toContain('GET /api/logs/');
  });
});

describe('DRF router lane — @action sub-routes (G5)', () => {
  it('emits a detail @action at <prefix>/{pk}/<url_path>/ with its declared methods', async () => {
    const keys = httpKeys(extractPythonEntrypoints(await tree(), ID, CFG));
    expect(keys).toContain('POST /api/projects/{parent_lookup_team_id}/feature_flags/{pk}/my/activity/');
    // methods=["POST"] means POST only — no invented verbs.
    expect(keys).not.toContain('GET /api/projects/{parent_lookup_team_id}/feature_flags/{pk}/my/activity/');
  });

  it('defaults methods to GET and url_path to the method name for a collection @action', async () => {
    const keys = httpKeys(extractPythonEntrypoints(await tree(), ID, CFG));
    expect(keys).toContain('GET /api/projects/{parent_lookup_team_id}/feature_flags/local_evaluation/');
  });

  it('templatizes a regex named group inside url_path', async () => {
    const src = `
from rest_framework.decorators import action
from rest_framework import routers

class SkillViewSet(BaseViewSet):
    @action(methods=["GET"], detail=False, url_path=r"name/(?P<skill_name>[^/]+)")
    def by_name(self, request, **kwargs):
        pass

router = routers.DefaultRouter()
router.register(r"skills", SkillViewSet)
`;
    const keys = httpKeys(extractPythonEntrypoints([await file('app/urls.py', src)], ID, {}));
    expect(keys).toContain('GET /skills/name/{skill_name}/');
  });

  it('skips an @action whose detail= or url_path= is not statically decidable', async () => {
    const src = `
from rest_framework.decorators import action
from rest_framework import routers

class ThingViewSet(BaseViewSet):
    @action(methods=["GET"], detail=IS_DETAIL)
    def unknown_detail(self, request):
        pass

    @action(methods=["GET"], detail=True, url_path=SOME_CONST)
    def unknown_path(self, request):
        pass

router = routers.DefaultRouter()
router.register(r"things", ThingViewSet)
`;
    const keys = httpKeys(extractPythonEntrypoints([await file('app/urls.py', src)], ID, {}));
    expect(keys.filter((k) => k.includes('unknown'))).toEqual([]);
    // The standard REST set is unaffected.
    expect(keys).toContain('GET /things/');
  });

  it('finds an @action inherited from a repo-declared base ViewSet', async () => {
    const base = `
from rest_framework.decorators import action

class ActivityMixin:
    @action(methods=["GET"], detail=False, url_path="activity")
    def activity(self, request):
        pass
`;
    const urls = `
from rest_framework import routers
from app.mixins import ActivityMixin

class NotebookViewSet(ActivityMixin):
    pass

router = routers.DefaultRouter()
router.register(r"notebooks", NotebookViewSet)
`;
    const files = await Promise.all([
      file('app/__init__.py', ''),
      file('app/mixins.py', base),
      file('app/urls.py', urls),
    ]);
    const eps = extractPythonEntrypoints(files, ID, {});
    expect(httpKeys(eps)).toContain('GET /notebooks/activity/');
    expect(at(eps, 'GET /notebooks/activity/')?.handlerId).toBe(
      ID.methodId('app/mixins.py', 'ActivityMixin', 'activity'),
    );
  });
});

describe('DRF router lane — handler wiring (G5, referential integrity)', () => {
  it('wires the standard REST routes to the ViewSet methods that serve them', async () => {
    const files = await tree();
    const eps = extractPythonEntrypoints(files, ID, CFG);
    expect(at(eps, 'GET /api/projects/')?.handlerId).toBe(
      ID.methodId('posthog/api/project.py', 'RootProjectViewSet', 'list'),
    );
    expect(at(eps, 'GET /api/projects/{pk}/')?.handlerId).toBe(
      ID.methodId('posthog/api/project.py', 'RootProjectViewSet', 'retrieve'),
    );
  });

  it('wires an @action route to the decorated method itself', async () => {
    const eps = extractPythonEntrypoints(await tree(), ID, CFG);
    expect(at(eps, 'POST /api/projects/{parent_lookup_team_id}/feature_flags/{pk}/my/activity/')?.handlerId).toBe(
      ID.methodId('posthog/api/feature_flag.py', 'FeatureFlagViewSet', 'activity'),
    );
  });

  it('keeps the synthetic fallback (stable shape) when the ViewSet method is not declared', async () => {
    const eps = extractPythonEntrypoints(await tree(), ID, CFG);
    // `create` is inherited from the framework's ModelViewSet — no node in this repo.
    expect(at(eps, 'POST /api/projects/')?.handlerId).toBe(
      ID.functionId('posthog/api/__init__.py', 'POST /api/projects/'),
    );
  });

  it('emits only handlerIds that exist as FunctionNodes (the integrity validator contract)', async () => {
    const files = await tree();
    const known = functionIds(files);
    const eps = extractPythonEntrypoints(files, ID, CFG);
    const real = eps.filter((e) => !isSyntheticHandlerId(e.handlerId));
    expect(real.length).toBeGreaterThan(0);
    for (const ep of real) expect(known.has(ep.handlerId)).toBe(true);
  });
});
