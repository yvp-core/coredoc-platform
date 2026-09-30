import { StableIdGenerator } from '@coredoc/core';
import { describe, expect, it } from 'vitest';
import { type RustFile, parseRust } from './rust-cst.js';
import { extractRustEgress } from './rust-egress.js';

const ID = new StableIdGenerator('/demo', 'demo');

async function rf(relPath: string, source: string): Promise<RustFile> {
  return { relPath, source, root: await parseRust(source) };
}

/** Extract egress and describe each edge as `METHOD path`. */
async function egressOf(source: string, relPath = 'src/client.rs'): Promise<string[]> {
  const edges = extractRustEgress([await rf(relPath, source)], ID, {});
  return edges.map((e) => `${e.method} ${e.targetDescriptor?.http?.pathTemplate}`);
}

describe('the receiver gate', () => {
  it('(a) accepts the crate itself and an aliased import', async () => {
    const src = `
use reqwest as http_client;
async fn calls() {
    reqwest::get("/v1/health").await;
    http_client::post("/v1/events").await;
}
`;
    expect(await egressOf(src)).toEqual(['GET /v1/health', 'POST /v1/events']);
  });

  it('(b) accepts a local bound to a client constructor or builder chain', async () => {
    const src = `
async fn calls() {
    let c = reqwest::Client::new();
    c.get("/v1/users").send().await;
    let b = reqwest::Client::builder().build().unwrap();
    b.post("/v1/orders").send().await;
}
`;
    expect(await egressOf(src)).toEqual(['GET /v1/users', 'POST /v1/orders']);
  });

  it('(a) accepts a client CONSTRUCTED inline at the call site', async () => {
    // `scoped_identifier.path` is the whole prefix (`reqwest::Client`), not the head, so a
    // receiver root that keeps the prefix matches no crate name and this shape emits nothing.
    const src = `
async fn calls() {
    reqwest::Client::new().get("/v1/inline").send().await;
}
`;
    expect(await egressOf(src)).toEqual(['GET /v1/inline']);
  });

  it('(b) accepts a local or PARAMETER with a declared client type', async () => {
    const src = `
async fn calls(client: &reqwest::Client) {
    client.get("/v1/items").send().await;
}
async fn declared() {
    let c: reqwest::Client = make();
    c.delete("/v1/items/1").send().await;
}
`;
    expect(await egressOf(src)).toEqual(['GET /v1/items', 'DELETE /v1/items/1']);
  });

  it('(c) accepts a struct FIELD whose declared type is a client', async () => {
    // The shape most production Rust services use — and one the Python substrate cannot type,
    // because Python does not write `self.session`'s type down.
    const src = `
pub struct Svc { http: reqwest::Client, name: String }

impl Svc {
    async fn fetch(&self) {
        self.http.get("/v1/profile").send().await;
        self.name.get("not a client").unwrap();
    }
}
`;
    expect(await egressOf(src)).toEqual(['GET /v1/profile']);
  });

  it('SKIPS a verb call whose receiver cannot be traced to a client', async () => {
    // `.get` is also HashMap::get / Option::get / HeaderMap::get; an ungated verb match would
    // bury the real egress edges under thousands of false ones.
    const src = `
fn ordinary(map: HashMap<String, u8>, req: Request) {
    map.get("key");
    req.headers().get("X-Amz-Date");
    let session = make_client();
    session.get("/v1/x");
}
`;
    expect(await egressOf(src)).toEqual([]);
  });

  it('SKIPS a bare `Client::new()` that is not bound to a configured client crate', async () => {
    const src = `
use aws_sdk_s3::Client;
async fn f() {
    let c = Client::new();
    c.get("/v1/x").send().await;
}
`;
    expect(await egressOf(src)).toEqual([]);
  });
});

describe('path templates', () => {
  it('keeps a literal path and strips the scheme+host from a full URL', async () => {
    const src = `
async fn f() {
    reqwest::get("/v1/a").await;
    reqwest::get("https://svc.internal/v1/b").await;
}
`;
    expect(await egressOf(src)).toEqual(['GET /v1/a', 'GET /v1/b']);
  });

  it('drops a LEADING interpolation as the host and keeps named captures', async () => {
    const src = `
async fn f(client: &reqwest::Client, id: u32) {
    client.get(format!("{}/v1/users/{id}", base)).send().await;
    client.post(format!("{base}/v1/orders")).send().await;
}
`;
    expect(await egressOf(src)).toEqual(['GET /v1/users/{id}', 'POST /v1/orders']);
  });

  it('renders a positional placeholder as the linker’s `{_}` token', async () => {
    const src = 'async fn f(c: &reqwest::Client) { c.get(format!("{}/v1/{}", base, id)).send().await; }';
    expect(await egressOf(src)).toEqual(['GET /v1/{_}']);
  });

  it('emits NOTHING for a host-only URL — a bare "/" pollutes the route join', async () => {
    const src = 'async fn f() { reqwest::get("https://svc.internal").await; }';
    expect(await egressOf(src)).toEqual([]);
  });

  it('skips a fully dynamic URL rather than inventing a path', async () => {
    const src = 'async fn f(c: &reqwest::Client, url: String) { c.get(&url).send().await; }';
    expect(await egressOf(src)).toEqual([]);
  });
});

describe('edge shape', () => {
  it('uses serviceName "" — the literal "http" collides with the linker’s unresolvableServices', async () => {
    const edges = extractRustEgress([await rf('src/c.rs', 'async fn f() { reqwest::get("/v1/a").await; }')], ID, {});
    expect(edges[0].serviceName).toBe('');
    expect(edges[0].targetDescriptor?.protocol).toBe('http');
  });

  it('attributes the edge to the enclosing fn', async () => {
    const src = 'async fn fetch_profile() { reqwest::get("/v1/a").await; }';
    const edges = extractRustEgress([await rf('src/c.rs', src)], ID, {});
    expect(edges[0].callerId).toBe(ID.functionId('src/c.rs', 'fetch_profile'));
  });

  it('honors a configured client crate list', async () => {
    const src = 'async fn f() { awc::get("/v1/a").await; reqwest::get("/v1/b").await; }';
    const edges = extractRustEgress([await rf('src/c.rs', src)], ID, { clientCrates: ['awc'] });
    expect(edges.map((e) => e.targetDescriptor?.http?.pathTemplate)).toEqual(['/v1/a']);
  });
});
