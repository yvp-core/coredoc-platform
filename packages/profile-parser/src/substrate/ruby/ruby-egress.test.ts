import { describe, expect, it } from 'vitest';
import { extractRubyEgress } from './ruby-egress.js';

/**
 * Ruby HTTP EGRESS extraction (P4) — generic outbound HTTP client calls a Ruby app
 * makes to OTHER services (makes the app a cross-repo CONSUMER). Generic client
 * libraries only (Faraday / HTTParty / RestClient / Net::HTTP); no client-specific
 * hosts or paths. The KISS heuristic matches the verb-call SHAPE: a `get`/`post`/…
 * call that HAS a receiver (`conn`/`HTTParty`/`RestClient`/`Faraday`/`http`) or is a
 * known module, whose first positional string arg looks like a URL or path (starts
 * with `http` or `/`). Bare Grape route DSL (`get 'x' do … end`, no receiver) is NOT
 * egress and must be skipped.
 */
describe('extractRubyEgress', () => {
  it('extracts a Faraday connection verb call', async () => {
    const out = await extractRubyEgress(`
def fetch_users(conn)
  conn.get('/v2/users')
end
`);
    expect(out.map((e) => `${e.method} ${e.url}`)).toContain('GET /v2/users');
  });

  it('extracts an HTTParty absolute-URL post', async () => {
    const out = await extractRubyEgress(`HTTParty.post('https://api.example.com/things')`);
    expect(out.map((e) => `${e.method} ${e.url}`)).toContain('POST https://api.example.com/things');
  });

  it('extracts a RestClient delete with a path arg', async () => {
    const out = await extractRubyEgress(`RestClient.delete('/x/1')`);
    expect(out.map((e) => `${e.method} ${e.url}`)).toContain('DELETE /x/1');
  });

  it('does NOT match a bare Grape-style route definition (no receiver)', async () => {
    const out = await extractRubyEgress(`
class Industries < Base
  get 'industry' do
  end
end
`);
    expect(out).toEqual([]);
  });

  it('extracts Faraday module-level get and a chained Faraday.new().get', async () => {
    const out = await extractRubyEgress(`
Faraday.get('http://svc.internal/health')
Faraday.new(url: 'http://svc.internal').get('/v1/ping')
`);
    const sigs = out.map((e) => `${e.method} ${e.url}`);
    expect(sigs).toContain('GET http://svc.internal/health');
    expect(sigs).toContain('GET /v1/ping');
  });

  it('extracts a self.class.get (HTTParty-including class) path call', async () => {
    const out = await extractRubyEgress(`
class Client
  include HTTParty
  def show
    self.class.get('/widgets/42')
  end
end
`);
    expect(out.map((e) => `${e.method} ${e.url}`)).toContain('GET /widgets/42');
  });

  it('extracts RestClient::Request.execute(method:, url:)', async () => {
    const out = await extractRubyEgress(`
RestClient::Request.execute(method: :get, url: 'https://api.example.com/orders')
`);
    expect(out.map((e) => `${e.method} ${e.url}`)).toContain('GET https://api.example.com/orders');
  });

  it('extracts Net::HTTP.get(URI(...)) when a URL literal is present', async () => {
    const out = await extractRubyEgress(`Net::HTTP.get(URI('https://api.example.com/status'))`);
    expect(out.map((e) => `${e.method} ${e.url}`)).toContain('GET https://api.example.com/status');
  });

  it('skips verb calls whose arg is neither a URL nor a path', async () => {
    // `obj.get('config')` is an ambiguous accessor, not an HTTP call — the arg does
    // not start with http or /, so it must be skipped.
    const out = await extractRubyEgress(`obj.get('config')`);
    expect(out).toEqual([]);
  });

  it('skips a verb call with no static string URL', async () => {
    const out = await extractRubyEgress(`conn.get(some_dynamic_path)`);
    expect(out).toEqual([]);
  });

  // Self-review #8: a scheme-less host (no `://`, no leading `/`) is not a real URL/path.
  it('rejects a scheme-less host string', async () => {
    expect(await extractRubyEgress(`Faraday.get('httpbin.org/get')`)).toEqual([]);
  });

  // Self-review #9: an inline interpolated URL must keep its full path (interpolation → :name
  // derived from the interpolated identifier), not be truncated to the first string segment.
  it('keeps the full path of an inline interpolated URL', async () => {
    const out = await extractRubyEgress(`conn.get("/v1/users/#{id}/posts")`);
    expect(out.map((e) => `${e.method} ${e.url}`)).toContain('GET /v1/users/:id/posts');
  });

  // Two distinct interpolations must not collapse to the same placeholder.
  it('gives distinct param names to multiple interpolations', async () => {
    const out = await extractRubyEgress(`conn.get("/users/#{uid}/posts/#{pid}")`);
    expect(out.map((e) => `${e.method} ${e.url}`)).toContain('GET /users/:uid/posts/:pid');
  });

  it('reports 1-based line numbers', async () => {
    const out = await extractRubyEgress(`# header\nconn.post('/v1/login')\n`);
    expect(out[0]?.line).toBe(2);
  });

  it('returns [] for a file with no HTTP egress', async () => {
    expect(await extractRubyEgress('class Foo\n  def bar; 1; end\nend\n')).toEqual([]);
  });
});

/**
 * B2 — the dominant Faraday pattern sets a base URL on a client object and passes the
 * PATH inside a request block (`req.url CONST`) or through a custom request-wrapper
 * (`send_request(http_method:, url:)`). The path is usually a CONSTANT whose value is
 * `"#{ENV_HOST_CONST}/literal/path/%{param}"`. Cross-repo matching keys off the PATH,
 * so we resolve the constant, drop the ENV-host interpolation, and keep the literal tail.
 */
describe('extractRubyEgress — constant resolution + Faraday block + request wrappers', () => {
  const sigs = (out: Array<{ method: string; url: string }>) => out.map((e) => `${e.method} ${e.url}`);

  it('resolves a constant path passed via a Faraday request block (`req.url CONST`)', async () => {
    const out = await extractRubyEgress(`
class SessionClient
  CREATE_SESSION = "/v2/management/auth_sessions/sessions"
  def create
    @api_endpoint.post do |req|
      req.url CREATE_SESSION
    end
  end
end
`);
    expect(sigs(out)).toContain('POST /v2/management/auth_sessions/sessions');
  });

  it('strips an ENV-host interpolation and keeps the literal path tail', async () => {
    const out = await extractRubyEgress(`
class DemoCore
  CLIENT_URL = ENV["API_CORE"]
  ROUTE = "#{CLIENT_URL}/v2/management/core/list"
  def go
    @api_endpoint.get do |req|
      req.url ROUTE
    end
  end
end
`);
    expect(sigs(out)).toContain('GET /v2/management/core/list');
  });

  it('converts %{param} placeholders to path params', async () => {
    const out = await extractRubyEgress(`
class C
  R = "/v2/companies/%{company_uuid}/users"
  def go
    @c.get do |req|
      req.url R
    end
  end
end
`);
    expect(sigs(out)).toContain('GET /v2/companies/:company_uuid/users');
  });

  it('extracts a profile-declared request-wrapper call (verb + url keywords)', async () => {
    const src = `
class DemoCore
  CLIENT_URL = ENV["API_CORE"]
  GET_USERS = "#{CLIENT_URL}/v2/management/core/users"
  def fetch
    send_request(http_method: :post, url: GET_USERS, body: {})
  end
end
`;
    const out = await extractRubyEgress(src, {
      requestWrappers: [{ method: 'send_request', verbArg: 'http_method', urlArg: 'url' }],
    });
    expect(sigs(out)).toContain('POST /v2/management/core/users');
  });

  it('does NOT extract a request-wrapper call when the profile does not declare it', async () => {
    const out = await extractRubyEgress(`send_request(http_method: :post, url: "/v2/x")`);
    expect(out).toEqual([]);
  });

  it('skips a Faraday request block whose req.url arg is a dynamic variable', async () => {
    const out = await extractRubyEgress(`
def go(path)
  @c.get do |req|
    req.url path
  end
end
`);
    expect(out).toEqual([]);
  });

  it('resolves a constant defined as an array element (ROUTES = [ NAME = "..." ])', async () => {
    const src = `
class Client
  ROUTES = [
    LIST_PATH = "/v1/things",
    SHOW_PATH = "/v1/things/%{id}",
  ]
  def fetch
    send_request(http_method: :get, url: LIST_PATH)
  end
end
`;
    const out = await extractRubyEgress(src, {
      requestWrappers: [{ method: 'send_request', verbArg: 'http_method', urlArg: 'url' }],
    });
    expect(sigs(out)).toContain('GET /v1/things');
  });

  // Self-review #3: a same-named key inside a NESTED option hash must not shadow the
  // real top-level url/verb (descendantsOfType('pair') is recursive + document-ordered).
  it('does not let a nested option hash shadow the top-level url', async () => {
    const out = await extractRubyEgress(
      `class C
  R = "/real/path"
  def go
    send_request(http_method: :post, body: { url: "/nested/wrong" }, url: R)
  end
end`,
      { requestWrappers: [{ method: 'send_request', verbArg: 'http_method', urlArg: 'url' }] },
    );
    expect(sigs(out)).toContain('POST /real/path');
    expect(out.map((e) => e.url)).not.toContain('/nested/wrong');
  });

  // Self-review #1: a request-wrapper whose verb is not a real HTTP method must be skipped
  // rather than emitting an ExternalCallEdge with a bogus method.
  it('skips a request-wrapper call whose verb is not an HTTP method', async () => {
    const out = await extractRubyEgress(`send_request(http_method: :frobnicate, url: "/x")`, {
      requestWrappers: [{ method: 'send_request', verbArg: 'http_method', urlArg: 'url' }],
    });
    expect(out).toEqual([]);
  });
});
