import { type EventEntrypointDetails, type HttpEntrypointDetails, StableIdGenerator } from '@coredoc/core';
import { describe, expect, it } from 'vitest';
import { type PythonFile, parsePython } from './python-cst.js';
import { extractPythonEntrypoints } from './python-entrypoints.js';

/** Same seed the parser uses — assertions recompute canonical ids through it. */
const ID = new StableIdGenerator('/demo', 'demo');

async function file(relPath: string, source: string): Promise<PythonFile> {
  return { relPath, source, root: await parsePython(source) };
}

/** The http entrypoints' `${method} ${fullPath}` keys, for set-membership assertions. */
function httpKeys(eps: ReturnType<typeof extractPythonEntrypoints>): string[] {
  return eps
    .filter((e) => e.type === 'http')
    .map((e) => {
      const d = e.details as HttpEntrypointDetails;
      return `${d.method} ${d.fullPath}`;
    });
}

describe('extractPythonEntrypoints — Django/DRF routes (S5, S11)', () => {
  const URLS = `
from django.urls import path, re_path
from rest_framework import routers
from . import views

router = routers.DefaultRouter()
router.register(r'orders', OrdersViewSet)

urlpatterns = [
    path('users/<int:pk>/', views.user_detail, name='user-detail'),
    re_path(r'^legacy/(?P<slug>[\\w-]+)/$', views.legacy),
]
`;

  it('normalizes a Django path() converter to a {pk} template (default GET)', async () => {
    const eps = extractPythonEntrypoints([await file('api/urls.py', URLS)], ID, {});
    const keys = httpKeys(eps);
    expect(keys).toContain('GET /users/{pk}/');
  });

  it('strips re_path regex anchors and lifts named groups to {slug}', async () => {
    const eps = extractPythonEntrypoints([await file('api/urls.py', URLS)], ID, {});
    expect(httpKeys(eps)).toContain('GET /legacy/{slug}/');
  });

  it('expands a DRF router.register(prefix) to the standard REST set', async () => {
    const eps = extractPythonEntrypoints([await file('api/urls.py', URLS)], ID, {});
    const keys = httpKeys(eps);
    // list routes on the prefix; detail routes on {pk}.
    expect(keys).toContain('GET /orders/');
    expect(keys).toContain('POST /orders/');
    expect(keys).toContain('GET /orders/{pk}/');
    expect(keys).toContain('PUT /orders/{pk}/');
    expect(keys).toContain('PATCH /orders/{pk}/');
    expect(keys).toContain('DELETE /orders/{pk}/');
  });

  it('mints http entrypoints through the single idGen (two-ID integrity)', async () => {
    const eps = extractPythonEntrypoints([await file('api/urls.py', URLS)], ID, {});
    const users = eps.find((e) => (e.details as HttpEntrypointDetails).fullPath === '/users/{pk}/');
    expect(users).toBeDefined();
    expect(users!.type).toBe('http');
    expect(users!.id).toBe(ID.httpEntrypointId('GET', '/users/{pk}/', 'api/urls.py'));
    expect(users!.versionedId).toBe(ID.versionedId(users!.id, 'GET /users/{pk}/'));
    expect(users!.handlerId).toBe(ID.functionId('api/urls.py', 'GET /users/{pk}/'));
    // At least one http per source-shape + the 6 REST routes = >= 8 total.
    expect(httpKeys(eps).length).toBeGreaterThanOrEqual(8);
  });

  it('IGNORES a path() call outside the route-file globs (glob scoping)', async () => {
    const views = `
from django.urls import path
path('should/not/appear/', views.x)
`;
    const eps = extractPythonEntrypoints([await file('app/views.py', views)], ID, {});
    expect(httpKeys(eps)).not.toContain('GET /should/not/appear/');
    expect(eps.filter((e) => e.type === 'http')).toHaveLength(0);
  });

  it('honors a custom routeFileGlobs config', async () => {
    const eps = extractPythonEntrypoints([await file('app/routes.py', URLS)], ID, {
      routeFileGlobs: ['**/routes.py'],
    });
    expect(httpKeys(eps)).toContain('GET /users/{pk}/');
  });

  it('converts an UNNAMED re_path capture group to {_} (no raw regex, no stray parens)', async () => {
    const src = `
from django.urls import re_path
urlpatterns = [
    re_path(r'^users/([0-9]+)/$', v),
]
`;
    const eps = extractPythonEntrypoints([await file('api/urls.py', src)], ID, {});
    const keys = httpKeys(eps);
    // Positional group collapses to the {_} param token; anchors/regex chars are gone.
    expect(keys).toContain('GET /users/{_}/');
    // No leaked regex / stray parens.
    for (const k of keys) {
      expect(k).not.toMatch(/[()[\]^$]/);
    }
    // A named group still lifts to its name (regression guard).
    const named = extractPythonEntrypoints(
      [await file('api/urls.py', "from django.urls import re_path\nurlpatterns=[re_path(r'^u/(?P<pk>[0-9]+)/$', v)]")],
      ID,
      {},
    );
    expect(httpKeys(named)).toContain('GET /u/{pk}/');
  });

  it('keeps same-path routes from DISTINCT files as two entrypoints (file-scoped de-dup)', async () => {
    const app1 = "from django.urls import path\nurlpatterns=[path('items/', v)]";
    const app2 = "from django.urls import path\nurlpatterns=[path('items/', v)]";
    const eps = extractPythonEntrypoints([await file('app1/urls.py', app1), await file('app2/urls.py', app2)], ID, {});
    const items = eps.filter((e) => e.type === 'http' && (e.details as HttpEntrypointDetails).fullPath === '/items/');
    expect(items).toHaveLength(2);
    // Distinct ids — one per file (matches httpEntrypointId's file scoping).
    expect(new Set(items.map((e) => e.id)).size).toBe(2);
    expect(items.map((e) => e.id)).toEqual([
      ID.httpEntrypointId('GET', '/items/', 'app1/urls.py'),
      ID.httpEntrypointId('GET', '/items/', 'app2/urls.py'),
    ]);
  });
});

describe('extractPythonEntrypoints — Celery task entrypoints (S5)', () => {
  const TASKS = `
from celery import shared_task

@shared_task
def sync():
    pass

@app.task
def t():
    pass

def not_a_task():
    pass
`;

  it('emits an `event` entrypoint per @shared_task / @app.task def', async () => {
    const eps = extractPythonEntrypoints([await file('app/tasks.py', TASKS)], ID, {});
    const events = eps.filter((e) => e.type === 'event');
    expect(events).toHaveLength(2);
    const names = events.map((e) => (e.details as EventEntrypointDetails).eventName).sort();
    expect(names).toEqual(['sync', 't']);
    for (const e of events) {
      const d = e.details as EventEntrypointDetails;
      expect(d.emitter).toBe('celery');
      expect(e.id).toBe(ID.queueEntrypointId('celery', d.eventName, 'app/tasks.py'));
    }
  });

  it('honors a custom taskDecorators config', async () => {
    const src = `
@task
def custom():
    pass
`;
    const eps = extractPythonEntrypoints([await file('app/tasks.py', src)], ID, {
      taskDecorators: ['task'],
    });
    const events = eps.filter((e) => e.type === 'event');
    expect(events).toHaveLength(1);
    expect((events[0].details as EventEntrypointDetails).eventName).toBe('custom');
  });
});

describe('extractPythonEntrypoints — include() mounts (prefix correctness)', () => {
  // `path('api/v1/', include('orders.urls'))` is a MOUNT, not an endpoint. Emitting it as a
  // route invented an endpoint nothing serves, and the mounted app's real routes came out
  // unprefixed — so an included app joined the cross-repo linker on a key wrong at both ends.
  const ROOT = `
from django.urls import path, include

urlpatterns = [
    path('api/v1/', include('orders.urls')),
    path('health/', views.health),
]
`;
  const ORDERS = `
from django.urls import path
from . import views

urlpatterns = [
    path('orders/<int:pk>/', views.detail),
]
`;

  const tree = () =>
    Promise.all([file('config/urls.py', ROOT), file('orders/urls.py', ORDERS), file('orders/__init__.py', '')]);

  it('does not emit the mount itself as an endpoint', async () => {
    const keys = httpKeys(extractPythonEntrypoints(await tree(), ID, {}));
    expect(keys).not.toContain('GET /api/v1/');
  });

  it('prefixes the included app routes with the mount path', async () => {
    const keys = httpKeys(extractPythonEntrypoints(await tree(), ID, {}));
    expect(keys).toContain('GET /api/v1/orders/{pk}/');
    expect(keys).not.toContain('GET /orders/{pk}/');
  });

  it('leaves a non-mounted route in the root urlconf unprefixed', async () => {
    const keys = httpKeys(extractPythonEntrypoints(await tree(), ID, {}));
    expect(keys).toContain('GET /health/');
  });

  it('composes nested mounts', async () => {
    const eps = extractPythonEntrypoints(
      await Promise.all([
        file(
          'config/urls.py',
          "from django.urls import path, include\nurlpatterns = [path('api/', include('v1.urls'))]\n",
        ),
        file('v1/__init__.py', ''),
        file(
          'v1/urls.py',
          "from django.urls import path, include\nurlpatterns = [path('v1/', include('orders.urls'))]\n",
        ),
        file('orders/__init__.py', ''),
        file('orders/urls.py', "from django.urls import path\nurlpatterns = [path('orders/', views.list)]\n"),
      ]),
      ID,
      {},
    );
    expect(httpKeys(eps)).toContain('GET /api/v1/orders/');
  });

  it('falls back to unprefixed when the included module is not in the repo', async () => {
    const eps = extractPythonEntrypoints(
      await Promise.all([
        file(
          'config/urls.py',
          "from django.urls import path, include\nurlpatterns = [path('admin/', include('django.contrib.admin.urls'))]\n",
        ),
        file('orders/urls.py', "from django.urls import path\nurlpatterns = [path('orders/', views.list)]\n"),
      ]),
      ID,
      {},
    );
    // Unresolvable mount emits nothing; the unmounted app keeps its own path honestly.
    expect(httpKeys(eps)).toEqual(['GET /orders/']);
  });

  it('terminates on a cyclic include instead of recursing', async () => {
    const eps = extractPythonEntrypoints(
      await Promise.all([
        file('a/__init__.py', ''),
        file(
          'a/urls.py',
          "from django.urls import path, include\nurlpatterns = [path('a/', include('b.urls')), path('x/', views.x)]\n",
        ),
        file('b/__init__.py', ''),
        file('b/urls.py', "from django.urls import path, include\nurlpatterns = [path('b/', include('a.urls'))]\n"),
      ]),
      ID,
      {},
    );
    expect(httpKeys(eps).length).toBeGreaterThan(0);
  });
});

describe('extractPythonEntrypoints — Celery task naming', () => {
  it('prefers an explicit name= over the def name (the producer routing key)', async () => {
    const eps = extractPythonEntrypoints(
      [
        await file(
          'billing/tasks.py',
          "from celery import shared_task\n\n@shared_task(name='billing.charge')\ndef charge_customer(uid):\n    pass\n",
        ),
      ],
      ID,
      {},
    );
    const ev = eps.find((e) => e.type === 'event');
    expect((ev?.details as EventEntrypointDetails).eventName).toBe('billing.charge');
  });

  it('still uses the def name when the decorator names nothing', async () => {
    const eps = extractPythonEntrypoints(
      [
        await file(
          'billing/tasks.py',
          'from celery import shared_task\n\n@shared_task\ndef charge_customer(uid):\n    pass\n',
        ),
      ],
      ID,
      {},
    );
    const ev = eps.find((e) => e.type === 'event');
    expect((ev?.details as EventEntrypointDetails).eventName).toBe('charge_customer');
  });
});
