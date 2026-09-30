import type { ExternalCallEdge } from '@coredoc/core';
import { StableIdGenerator } from '@coredoc/core';
import { describe, expect, it } from 'vitest';
import { type GoFile, parseGo } from './go-cst.js';
import { extractGoEgress } from './go-egress.js';

const ID = new StableIdGenerator('/demo', 'demo');

async function gf(relPath: string, source: string): Promise<GoFile> {
  return { relPath, source, root: await parseGo(source) };
}

/** Every HTTP edge described as `METHOD path` (SDK edges have no path descriptor). */
function asHttp(edges: ExternalCallEdge[]): string[] {
  return edges.filter((e) => e.serviceName === '').map((e) => `${e.method} ${e.targetDescriptor?.http?.pathTemplate}`);
}

/** Extract from one file and describe the HTTP edges. */
async function egressOf(source: string, relPath = 'svc/client.go'): Promise<string[]> {
  return asHttp(extractGoEgress([await gf(relPath, source)], ID, {}));
}

describe('net/http call shapes', () => {
  it('reads the URL from the table position of each package function', async () => {
    // `Post` has TWO string arguments and only the first is a URL — a scan for "something
    // string-shaped" would emit `POST application/json`.
    const src = `package svc

import "net/http"

func calls() {
	http.Get("/v1/health")
	http.Head("/v1/ping")
	http.Post("/v1/events", "application/json", nil)
	http.PostForm("/v1/forms", nil)
}
`;
    expect(await egressOf(src)).toEqual(['GET /v1/health', 'HEAD /v1/ping', 'POST /v1/events', 'POST /v1/forms']);
  });

  it('takes the verb from a NewRequest argument — literal or stdlib constant', async () => {
    const src = `package svc

import (
	"context"
	"net/http"
)

func calls(ctx context.Context) {
	http.NewRequest("PATCH", "/v1/users/1", nil)
	http.NewRequestWithContext(ctx, http.MethodDelete, "/v1/users/2", nil)
}
`;
    expect(await egressOf(src)).toEqual(['PATCH /v1/users/1', 'DELETE /v1/users/2']);
  });

  it('SKIPS a NewRequest whose verb is dynamic rather than defaulting to GET', async () => {
    // The verb is half the join key; a guessed one draws an edge to the wrong producer route.
    const src = `package svc

import "net/http"

func calls(method string) {
	http.NewRequest(method, "/v1/users", nil)
}
`;
    expect(await egressOf(src)).toEqual([]);
  });

  it('emits nothing for client.Do — the NewRequest that built the request already did', async () => {
    const src = `package svc

import "net/http"

func calls(c *http.Client) {
	req, _ := http.NewRequest("POST", "/v1/jobs", nil)
	c.Do(req)
}
`;
    expect(await egressOf(src)).toEqual(['POST /v1/jobs']);
  });
});

describe('the receiver gate', () => {
  it('(a) accepts the package qualifier and a package-level client value', async () => {
    const src = `package svc

import "net/http"

func calls() {
	http.Get("/v1/a")
	http.DefaultClient.Get("/v1/b")
}
`;
    expect(await egressOf(src)).toEqual(['GET /v1/a', 'GET /v1/b']);
  });

  it('(b) accepts a local bound to a constructor and a parameter with a declared client type', async () => {
    const src = `package svc

import (
	"net/http"

	"github.com/go-resty/resty/v2"
)

func fromLocal() {
	c := &http.Client{Timeout: 5}
	c.Get("/v1/users")
	r := resty.New()
	r.R().SetBody(nil).Post("/v1/events")
}

func fromParam(client *http.Client) {
	client.Post("/v1/orders", "application/json", nil)
}

func fromVar() {
	var shared = http.DefaultClient
	shared.Head("/v1/ping")
}

func fromBuilderChain() {
	b := resty.New().SetBaseURL("https://svc.internal").SetRetryCount(3)
	b.R().Delete("/v1/items/1")
}
`;
    expect(await egressOf(src)).toEqual([
      'GET /v1/users',
      'POST /v1/events',
      'POST /v1/orders',
      'HEAD /v1/ping',
      'DELETE /v1/items/1',
    ]);
  });

  it('(c) accepts a struct FIELD whose declared type is a client, declared in a SIBLING file', async () => {
    // A Go package is a directory: `type Svc struct` in types.go and its methods in service.go is
    // the norm, so a per-file field index would miss the receiver type of most real call sites.
    const types = `package svc

import (
	"net/http"

	"github.com/go-resty/resty/v2"
)

type Svc struct {
	http *http.Client
	rest *resty.Client
	name string
}
`;
    const service = `package svc

func (s *Svc) Fetch() {
	s.http.Get("/v1/profile")
	s.rest.R().Post("/v1/events")
	s.name.Get("not a client")
}
`;
    const edges = extractGoEgress([await gf('svc/types.go', types), await gf('svc/service.go', service)], ID, {});
    expect(asHttp(edges)).toEqual(['GET /v1/profile', 'POST /v1/events']);
  });

  it('SKIPS a field access chain that is not a client — `resp.Header.Get` is the commonest .Get in Go', async () => {
    const src = `package svc

import (
	"net/http"
	"net/url"
)

func ordinary(r *http.Request, values url.Values) {
	resp, _ := http.Get("/v1/a")
	resp.Header.Get("Content-Type")
	r.URL.Query().Get("/id")
	values.Get("/name")
	session := makeClient()
	session.Get("/v1/x")
}
`;
    expect(await egressOf(src)).toEqual(['GET /v1/a']);
  });

  it('SKIPS a LONGER chain whose root is not a client — descent must not widen the gate', async () => {
    // `cfg` is a plain struct field, so no number of hops off it reaches a client, and neither does
    // a hop off a handler's `*http.Request`. The chain walk exists to pass THROUGH a root some tier
    // already resolved, never to invent one.
    const types = `package svc

type Svc struct {
	cfg *Config
}

type Config struct {
	Client *Remote
}
`;
    const service = `package svc

import "net/http"

func (s *Svc) Fetch(r *http.Request) {
	s.cfg.Client.Get("/v1/nope")
	r.Header.Values.Get("/v1/never")
}
`;
    const edges = extractGoEgress([await gf('svc/types.go', types), await gf('svc/service.go', service)], ID, {});
    expect(asHttp(edges)).toEqual([]);
  });

  it('SKIPS a verb method on a package that is not configured as a client', async () => {
    const src = `package svc

import "github.com/go-redis/redis"

func f() {
	c := redis.NewClient(nil)
	c.Get("/v1/x")
}
`;
    expect(await egressOf(src)).toEqual([]);
  });

  it('honors a configured clientPackages list', async () => {
    const src = `package svc

import (
	"net/http"

	"github.com/imroc/req/v3"
)

func f() {
	http.Get("/v1/a")
	c := req.C()
	c.Get("/v1/b")
}
`;
    const files = [await gf('svc/client.go', src)];
    expect(asHttp(extractGoEgress(files, ID, { clientPackages: ['github.com/imroc/req'] }))).toEqual([]);
    // `req.C()` is not a `New…` constructor, so only the profile-added package's DIRECT call
    // resolves — the version suffix in the import is matched by the prefix gate.
    expect(asHttp(extractGoEgress(files, ID, { clientPackages: ['github.com/imroc/req', 'net/http'] }))).toEqual([
      'GET /v1/a',
    ]);
  });
});

describe('path templates', () => {
  it('keeps a literal path and strips the scheme+host from a full URL', async () => {
    const src = `package svc

import "net/http"

func f() {
	http.Get("/v1/a")
	http.Get("https://svc.internal/v1/b")
}
`;
    expect(await egressOf(src)).toEqual(['GET /v1/a', 'GET /v1/b']);
  });

  it('drops a LEADING concat operand as the host and renders a later one as `{_}`', async () => {
    const src = `package svc

import "net/http"

func f(baseURL string, id string) {
	http.Get(baseURL + "/v1/users")
	http.Get(baseURL + "/v1/users/" + id)
}
`;
    expect(await egressOf(src)).toEqual(['GET /v1/users', 'GET /v1/users/{_}']);
  });

  it('renders fmt.Sprintf verbs, dropping a leading one as the host and keeping `%%`', async () => {
    const src = `package svc

import (
	"fmt"
	"net/http"
)

func f(base string, id int) {
	http.Get(fmt.Sprintf("%s/v1/users/%d", base, id))
	http.Get(fmt.Sprintf("/v1/a%%b/%s", id))
}
`;
    expect(await egressOf(src)).toEqual(['GET /v1/users/{_}', 'GET /v1/a%b/{_}']);
  });

  it('emits NOTHING for a host-only URL — a bare "/" pollutes the route join', async () => {
    const src = `package svc

import "net/http"

func f() {
	http.Get("https://svc.internal")
}
`;
    expect(await egressOf(src)).toEqual([]);
  });

  it('reads the URL from a local the function assigns exactly once', async () => {
    // The dominant Go request idiom: the URL is built on the line ABOVE the call. Reading only
    // the argument would drop every one of these.
    const src = `package svc

import (
	"context"
	"fmt"
	"net/http"
	"strings"
)

func fromSprintf(ctx context.Context, base string, id int64) {
	endpoint := fmt.Sprintf("%s/app/installations/%d/access_tokens", strings.TrimRight(base, "/"), id)
	http.NewRequestWithContext(ctx, http.MethodPost, endpoint, nil)
}

func fromConcat(ctx context.Context, instanceURL string) {
	var endpoint = normalize(instanceURL) + "/api/v4/user"
	http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
}

func throughTwoHops(ctx context.Context, base string) {
	suffix := base + "/v1/things"
	endpoint := suffix
	http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
}
`;
    expect(await egressOf(src)).toEqual([
      'POST /app/installations/{_}/access_tokens',
      'GET /api/v4/user',
      'GET /v1/things',
    ]);
  });

  it('SKIPS a name the function assigns twice, or that arrives as a parameter', async () => {
    // Two assignments = no single value; rendering whichever one was indexed would draw an edge
    // to a route the code never calls. A parameter's literal lives at the CALLER, one hop away.
    const src = `package svc

import (
	"context"
	"net/http"
)

func rewritten(ctx context.Context, base string, relative bool) {
	downloadURL := "/v1/download"
	if relative {
		downloadURL = base + "/v1/other"
	}
	http.NewRequestWithContext(ctx, http.MethodGet, downloadURL, nil)
}

func fromParam(ctx context.Context, apiURL string) {
	http.NewRequestWithContext(ctx, http.MethodGet, apiURL, nil)
}

func shadowsAParam(ctx context.Context, apiURL string) {
	apiURL = "/v1/shadowed"
	http.NewRequestWithContext(ctx, http.MethodGet, apiURL, nil)
}

func perIteration(ctx context.Context, urls []string) {
	for _, u := range urls {
		http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	}
}
`;
    expect(await egressOf(src)).toEqual([]);
  });

  it('does NOT reach a local of a DIFFERENT function, or a package-level const', async () => {
    // Scope is the enclosing declaration. A package-level const stays the engine's job.
    const src = `package svc

import (
	"context"
	"net/http"
)

const apiPath = "/v1/const-path"

func builds(base string) string {
	endpoint := base + "/v1/elsewhere"
	return endpoint
}

func sends(ctx context.Context, base string) {
	http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	http.NewRequestWithContext(ctx, http.MethodGet, base+apiPath, nil)
}
`;
    expect(await egressOf(src)).toEqual([]);
  });

  it('skips a fully dynamic URL rather than inventing a path', async () => {
    const src = `package svc

import "net/http"

func f(u string) {
	http.Get(u)
	http.Get(joinURL(base, "v1"))
}
`;
    expect(await egressOf(src)).toEqual([]);
  });
});

describe('edge shape', () => {
  it('uses serviceName "" — the literal "http" collides with the linker’s unresolvableServices', async () => {
    const src = `package svc

import "net/http"

func f() { http.Get("/v1/a") }
`;
    const edges = extractGoEgress([await gf('svc/client.go', src)], ID, {});
    expect(edges[0].serviceName).toBe('');
    expect(edges[0].targetDescriptor?.protocol).toBe('http');
    expect(edges[0].targetDescriptor?.http?.originalPath).toBe('/v1/a');
    expect(edges[0].location).toEqual({ filePath: 'svc/client.go', startLine: 5, endLine: 5 });
    expect(edges[0].id).toBe(ID.externalCallId(edges[0].callerId, '', 'GET', 'svc/client.go:5:/v1/a'));
  });

  it('attributes an edge to the enclosing func, method and closure', async () => {
    const src = `package svc

import "net/http"

func fetchProfile() { http.Get("/v1/a") }

func (s *Svc) Reload() { http.Get("/v1/b") }

func register() {
	handler := func() { http.Get("/v1/c") }
	_ = handler
}
`;
    const edges = extractGoEgress([await gf('svc/client.go', src)], ID, {});
    expect(edges.map((e) => e.callerId)).toEqual([
      ID.functionId('svc/client.go', 'fetchProfile'),
      ID.methodId('svc/client.go', 'Svc', 'Reload'),
      ID.methodId('svc/client.go', 'register', 'handler'),
    ]);
  });

  it('attributes a package-scope call to a synthetic egress@<line> caller', async () => {
    // Go really runs a package-level initializer, with no owning function to attribute it to.
    const src = `package svc

import "net/http"

var probe, _ = http.Get("/v1/health")
`;
    const edges = extractGoEgress([await gf('svc/client.go', src)], ID, {});
    expect(edges[0].callerId).toBe(ID.functionId('svc/client.go', 'egress@5'));
  });
});

describe('the SDK registry tier', () => {
  it('names the SERVICE for a Go SDK module, at the constructor and at each API call', async () => {
    const src = `package svc

import (
	"context"

	openai "github.com/sashabaranov/go-openai"
)

func ask(ctx context.Context, req openai.ChatCompletionRequest) {
	client := openai.NewClient("key")
	client.CreateChatCompletion(ctx, req)
}
`;
    const edges = extractGoEgress([await gf('svc/ai.go', src)], ID, {});
    expect(edges.map((e) => `${e.serviceName}.${e.method}`)).toEqual([
      'OpenAI.NewClient',
      'OpenAI.CreateChatCompletion',
    ]);
    expect(edges[1].sdkName).toBe('github.com/sashabaranov/go-openai');
    expect(edges[1].targetDescriptor).toEqual({ protocol: 'http', targetService: 'OpenAI' });
    expect(edges[1].callerId).toBe(ID.functionId('svc/ai.go', 'ask'));
  });

  it('translates the vendor-namespaced AWS and Google Go SDK layouts onto the registry keys', async () => {
    const src = `package svc

import (
	"context"

	"cloud.google.com/go/storage"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

func upload(ctx context.Context) {
	client := s3.NewFromConfig(cfg)
	client.PutObject(ctx, nil)
	gcs, _ := storage.NewClient(ctx)
	gcs.Close()
}
`;
    const edges = extractGoEgress([await gf('svc/blob.go', src)], ID, {});
    expect(edges.map((e) => `${e.serviceName}.${e.method}`)).toEqual([
      'AWS S3.NewFromConfig',
      'AWS S3.PutObject',
      'Google Cloud Storage.NewClient',
      'Google Cloud Storage.Close',
    ]);
  });

  it('strips Go’s language marker to reach the registry key', async () => {
    const src = `package svc

import (
	stripe "github.com/stripe/stripe-go/v76"
	"github.com/twilio/twilio-go"
)

func pay() {
	stripe.NewClient("sk")
	twilio.NewRestClient()
}
`;
    const edges = extractGoEgress([await gf('svc/pay.go', src)], ID, {});
    expect(edges.map((e) => e.serviceName)).toEqual(['Stripe', 'Twilio']);
  });

  it('reaches an SDK method through the client’s NAMESPACE fields', async () => {
    // The shape every modern generated SDK uses (`openai-go`, `stripe-go` v76+): the client is a
    // struct field, and the API call hangs off two more namespace fields. Resolving only `c.sdk`
    // would leave the constructor as the sole edge and drop every actual request.
    const src = `package svc

import (
	"context"

	"github.com/openai/openai-go/v3"
)

type Client struct {
	sdk openai.Client
}

func (c *Client) Chat(ctx context.Context, p openai.ChatCompletionNewParams) {
	c.sdk.Chat.Completions.New(ctx, p)
	c.sdk.Chat.Completions.NewStreaming(ctx, p)
}
`;
    const edges = extractGoEgress([await gf('svc/llm.go', src)], ID, {});
    expect(edges.map((e) => `${e.serviceName}.${e.method}`)).toEqual(['OpenAI.New', 'OpenAI.NewStreaming']);
  });

  it('names the SERVICE for a Go module the registry keys directly, including its subpackages', async () => {
    // `slack-go/slack` carries the language marker on the VENDOR segment, so no derivation reaches
    // the npm key — the shared registry holds the module path itself, and its longest-prefix walk
    // covers the subpackage import.
    const src = `package svc

import (
	"context"

	"github.com/slack-go/slack"
	"github.com/slack-go/slack/slackevents"
)

func post(ctx context.Context) {
	api := slack.New("token")
	api.PostMessageContext(ctx, "C1", nil)
	slackevents.ParseEvent(nil, nil)
}
`;
    const edges = extractGoEgress([await gf('svc/slack.go', src)], ID, {});
    expect(edges.map((e) => `${e.serviceName}.${e.method}`)).toEqual([
      'Slack.New',
      'Slack.PostMessageContext',
      'Slack.ParseEvent',
    ]);
    // The npm and Go keys are the SAME service identity, which is what lets a TS repo calling
    // `@slack/web-api` and this one collapse onto one node in the cross-repo graph.
    expect(edges[0].targetDescriptor).toEqual({ protocol: 'http', targetService: 'Slack' });
  });

  it('does NOT mistake an in-repo package for an SDK of the same name', async () => {
    // Without the language-marker requirement, `internal/openai` would read as the OpenAI SDK.
    const src = `package svc

import "github.com/acme/api/internal/openai"

func ask() {
	client := openai.NewClient("key")
	client.Complete(nil)
}
`;
    expect(extractGoEgress([await gf('svc/ai.go', src)], ID, {})).toEqual([]);
  });
});
