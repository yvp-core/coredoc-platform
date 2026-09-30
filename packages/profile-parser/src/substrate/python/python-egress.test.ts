import { StableIdGenerator } from '@coredoc/core';
import { describe, expect, it } from 'vitest';
import { type PythonFile, parsePython } from './python-cst.js';
import { extractPythonEgress } from './python-egress.js';

/**
 * Python HTTP EGRESS extraction (Lane D, spec S8/S11) — outbound HTTP client calls a Python
 * app makes to OTHER services (makes the app a cross-repo CONSUMER). Generic client modules
 * only (`requests`/`httpx`/`aiohttp`, profile-configurable); NO client-specific hosts.
 *
 * Detection = an `attribute`-receiver `call` whose method is an HTTP verb and whose receiver
 * ROOT token resolves (literal or import-table alias) to a configured client module. The path
 * template comes from the first positional arg with interpolations PRESERVED (S8): f-strings
 * keep `{name}`, `.format` keeps `{}`/`{0}`, `+`-concat keeps the leading literal prefix, a
 * full `http(s)://host/path` is stripped to `/path`. No usable path → the site is skipped.
 */

const REL = 'app/svc.py';

async function file(source: string, relPath = REL): Promise<PythonFile> {
  return { relPath, source, root: await parsePython(source) };
}

/** Fresh id generator seeded exactly like the parser. */
function idGen(): StableIdGenerator {
  return new StableIdGenerator('/demo', 'demo');
}

describe('extractPythonEgress', () => {
  it('extracts a requests.post f-string egress: host stripped, interpolation preserved, caller = enclosing def', async () => {
    const src = 'import requests\ndef send(uid):\n  requests.post(f"https://svc/users/{uid}/events", json={})\n';
    const id = idGen();
    const edges = extractPythonEgress([await file(src)], id, {});

    expect(edges).toHaveLength(1);
    const e = edges[0];
    expect(e.method).toBe('POST');
    expect(e.serviceName).toBe('');
    // Host stripped, interpolation preserved as {uid} (S8).
    expect(e.targetDescriptor?.protocol).toBe('http');
    expect(e.targetDescriptor?.http?.method).toBe('POST');
    expect(e.targetDescriptor?.http?.pathTemplate).toBe('/users/{uid}/events');
    // originalPath keeps the pre-normalization form (host included).
    expect(e.targetDescriptor?.http?.originalPath).toBe('https://svc/users/{uid}/events');
    // callerId = the enclosing module-level def `send`.
    expect(e.callerId).toBe(id.functionId(REL, 'send'));
    expect(e.location.filePath).toBe(REL);
    expect(e.location.startLine).toBe(3);
    // two-ID integrity: versionedId = id@checksum, checksum is not a constant.
    expect(e.versionedId).toBe(id.versionedId(e.id, 'POST /users/{uid}/events'));
    expect(e.versionedId).not.toBe(`${e.id}@1`);
  });

  it('extracts httpx.get with a plain path; module-scope egress → synthetic caller id', async () => {
    const src = "httpx.get('/health')";
    const id = idGen();
    const edges = extractPythonEgress([await file(src)], id, {});

    expect(edges).toHaveLength(1);
    expect(edges[0].method).toBe('GET');
    expect(edges[0].targetDescriptor?.http?.pathTemplate).toBe('/health');
    // No enclosing def → synthetic `egress@<line>` caller (line 1).
    expect(edges[0].callerId).toBe(id.functionId(REL, 'egress@1'));
  });

  it('renders an empty .format() {} placeholder as the {_} param token, host stripped', async () => {
    // An empty `.format` placeholder `{}` renders as `{_}` so the linker normalizer collapses it
    // (`{_}`→`:_`) and joins a producer route; a bare `{}` would stay literal and never link.
    const src = 'requests.get("https://x/{}".format(v))';
    const edges = extractPythonEgress([await file(src)], idGen(), {});

    expect(edges).toHaveLength(1);
    expect(edges[0].method).toBe('GET');
    expect(edges[0].targetDescriptor?.http?.pathTemplate).toBe('/{_}');
  });

  it('best-effort +-concat: keeps the leading literal prefix, drops the dynamic tail', async () => {
    const src = "requests.get('/p/' + str(uid))";
    const edges = extractPythonEgress([await file(src)], idGen(), {});

    expect(edges).toHaveLength(1);
    expect(edges[0].method).toBe('GET');
    // Dynamic `+ str(uid)` tail is dropped — the prefix `/p/` is the joinable stub.
    expect(edges[0].targetDescriptor?.http?.pathTemplate).toBe('/p/');
  });

  it('does NOT emit for a non-client receiver (obj.get)', async () => {
    expect(extractPythonEgress([await file("obj.get('config')")], idGen(), {})).toEqual([]);
    // Even with a valid-looking path, a non-client receiver is rejected at the receiver gate.
    expect(extractPythonEgress([await file("obj.get('/config')")], idGen(), {})).toEqual([]);
  });

  it('resolves a client via an import alias (`import httpx as h`)', async () => {
    const src = "import httpx as h\nh.get('/ping')";
    const edges = extractPythonEgress([await file(src)], idGen(), {});
    expect(edges).toHaveLength(1);
    expect(edges[0].method).toBe('GET');
    expect(edges[0].targetDescriptor?.http?.pathTemplate).toBe('/ping');
  });

  it('drops a leading host interpolation but keeps the literal path tail (f"{BASE}/x")', async () => {
    const src = 'requests.post(f"{BASE}/x")';
    const edges = extractPythonEgress([await file(src)], idGen(), {});
    expect(edges).toHaveLength(1);
    expect(edges[0].targetDescriptor?.http?.pathTemplate).toBe('/x');
  });

  it('strips scheme+host from a full-URL plain literal', async () => {
    const src = "httpx.post('https://api.example.com/orders')";
    const edges = extractPythonEgress([await file(src)], idGen(), {});
    expect(edges).toHaveLength(1);
    expect(edges[0].targetDescriptor?.http?.pathTemplate).toBe('/orders');
  });

  it('keeps a plain path literal verbatim', async () => {
    const src = "requests.put('/v1/users')";
    const edges = extractPythonEgress([await file(src)], idGen(), {});
    expect(edges).toHaveLength(1);
    expect(edges[0].method).toBe('PUT');
    expect(edges[0].targetDescriptor?.http?.pathTemplate).toBe('/v1/users');
  });

  it('resolves the receiver ROOT token through a client chain (httpx.Client().get)', async () => {
    const src = "httpx.Client().get('/x')";
    const edges = extractPythonEgress([await file(src)], idGen(), {});
    expect(edges).toHaveLength(1);
    expect(edges[0].method).toBe('GET');
    expect(edges[0].targetDescriptor?.http?.pathTemplate).toBe('/x');
  });

  it('skips a non-HTTP-verb method on a client module', async () => {
    // `requests.Session()` etc. — `connect`/`session` are not in the HTTP verb set.
    expect(extractPythonEgress([await file("requests.connect('/x')")], idGen(), {})).toEqual([]);
  });

  it('skips an untraceable bare receiver (session.get) — precision-first', async () => {
    // `session` is a local var of unknown origin (not imported from a client module).
    expect(extractPythonEgress([await file("session.get('/x')")], idGen(), {})).toEqual([]);
  });

  it('skips a call whose first positional arg is dynamic (no usable path)', async () => {
    expect(extractPythonEgress([await file('requests.get(url)')], idGen(), {})).toEqual([]);
  });

  it('is config-driven: cfg.clientModules overrides the defaults', async () => {
    const src = "import myhttp\nrequests.get('/a')\nmyhttp.get('/b')";
    const edges = extractPythonEgress([await file(src)], idGen(), { clientModules: ['myhttp'] });
    // Only the configured client matches; the default `requests` is not in the override list.
    expect(edges.map((e) => e.targetDescriptor?.http?.pathTemplate)).toEqual(['/b']);
  });

  it('emits one edge per call site (call-site granularity) and returns [] for non-egress files', async () => {
    const src = "import requests\nrequests.get('/a')\nrequests.post('/b')\n";
    const edges = extractPythonEgress([await file(src)], idGen(), {});
    expect(edges.map((e) => `${e.method} ${e.targetDescriptor?.http?.pathTemplate}`)).toEqual(['GET /a', 'POST /b']);

    expect(extractPythonEgress([await file('def f():\n  return 1\n')], idGen(), {})).toEqual([]);
  });

  // --- Cross-repo route-join regression fixes (S11) -------------------------------------------

  it('skips a host-only URL (no path) instead of emitting a bogus `/` edge', async () => {
    // `https://analytics.svc` has NO path → no joinable route → NO edge (was a spurious `/`).
    expect(extractPythonEgress([await file('requests.get("https://analytics.svc")')], idGen(), {})).toEqual([]);
  });

  it('still keeps the path of a full host+path f-string URL (host-strip regression guard)', async () => {
    const src = 'requests.post(f"https://svc/orders/{oid}")';
    const edges = extractPythonEgress([await file(src)], idGen(), {});
    expect(edges).toHaveLength(1);
    expect(edges[0].method).toBe('POST');
    expect(edges[0].targetDescriptor?.http?.pathTemplate).toBe('/orders/{oid}');
  });

  it('renders an empty .format() placeholder as {_} so it joins a producer route', async () => {
    const src = 'requests.get("https://svc/users/{}".format(uid))';
    const edges = extractPythonEgress([await file(src)], idGen(), {});
    expect(edges).toHaveLength(1);
    // `{_}` normalizes to `:_` in the linker, matching a producer's `/users/{pk}` → `/users/:_`.
    expect(edges[0].targetDescriptor?.http?.pathTemplate).toBe('/users/{_}');
  });

  it('mints every id through the passed idGen (serviceName always empty, method uppercased)', async () => {
    const src = "requests.patch('/v1/toggle')";
    const id = idGen();
    const edges = extractPythonEgress([await file(src)], id, {});
    expect(edges).toHaveLength(1);
    const e = edges[0];
    const callerId = id.functionId(REL, 'egress@1');
    const expectedId = id.externalCallId(callerId, '', 'PATCH', `${REL}:1:/v1/toggle`);
    expect(e.id).toBe(expectedId);
    expect(e.callerId).toBe(callerId);
    expect(e.serviceName).toBe('');
    expect(e.method).toBe('PATCH');
  });
});

describe('extractPythonEgress — session receivers', () => {
  // Rooting the receiver directly in an imported module only matches `requests.get(url)`.
  // aiohttp and httpx are in the default client list while being used almost exclusively
  // through a session object, so without binding those locals an async Python service reads
  // as having near-zero egress and nothing says otherwise.
  it('follows a session bound by assignment', async () => {
    const src = 'import requests\ns = requests.Session()\ndef send(uid):\n  s.get(f"https://svc/users/{uid}")\n';
    const edges = extractPythonEgress([await file(src)], idGen(), {});
    expect(edges).toHaveLength(1);
    expect(edges[0].targetDescriptor?.http?.pathTemplate).toBe('/users/{uid}');
  });

  it('follows an async-with ClientSession alias', async () => {
    const src =
      'import aiohttp\nasync def send(uid):\n  async with aiohttp.ClientSession() as sess:\n    await sess.get(f"https://svc/users/{uid}")\n';
    const edges = extractPythonEgress([await file(src)], idGen(), {});
    expect(edges).toHaveLength(1);
    expect(edges[0].method).toBe('GET');
    expect(edges[0].targetDescriptor?.http?.pathTemplate).toBe('/users/{uid}');
  });

  it('follows a sync with-Client alias', async () => {
    const src = "import httpx\ndef send():\n  with httpx.Client() as c:\n    c.get('/health')\n";
    const edges = extractPythonEgress([await file(src)], idGen(), {});
    expect(edges).toHaveLength(1);
  });

  it('follows a client constructed from a from-import', async () => {
    const src = "from httpx import Client\nc = Client()\ndef send():\n  c.get('/health')\n";
    const edges = extractPythonEgress([await file(src)], idGen(), {});
    expect(edges).toHaveLength(1);
  });

  it('does NOT follow a session-shaped local built from a non-client module', async () => {
    const src = "import boto3\ns = boto3.Session()\ndef send():\n  s.get('/health')\n";
    expect(extractPythonEgress([await file(src)], idGen(), {})).toEqual([]);
  });

  it('does NOT follow a client bound under TYPE_CHECKING', async () => {
    const src =
      "from typing import TYPE_CHECKING\nif TYPE_CHECKING:\n    import httpx\ns = httpx.Client()\ndef send():\n  s.get('/health')\n";
    expect(extractPythonEgress([await file(src)], idGen(), {})).toEqual([]);
  });

  it('respects cfg.clientModules for session binding too', async () => {
    const src = "import requests\ns = requests.Session()\ndef send():\n  s.get('/health')\n";
    expect(extractPythonEgress([await file(src)], idGen(), { clientModules: ['httpx'] })).toEqual([]);
  });
});
