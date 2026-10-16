import { StableIdGenerator } from '@coredoc/core';
import type { GrpcEntrypointDetails, HttpEntrypointDetails, QueueEntrypointDetails } from '@coredoc/core';
import { describe, expect, it } from 'vitest';
import type { RustCrate } from './rust-crates.js';
import { type RustFile } from './rust-cst.js';
import { extractRustEntrypoints } from './rust-entrypoints.js';
import { parseSource } from '../../tree-sitter/tree-sitter-loader.js';

const ID = new StableIdGenerator('/demo', 'demo');

async function rf(relPath: string, source: string): Promise<RustFile> {
  return { relPath, source, root: await parseSource('rust', source) };
}

/** A crate declaring `deps` — the gate the contract lane checks. */
function crateWith(...deps: string[]): RustCrate {
  return {
    name: 'demo',
    path: '.',
    dependencies: new Set(deps),
    isWorkspaceRoot: false,
    isPackage: true,
  };
}

const ANCHOR_SRC = `
#[program]
pub mod my_program {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, amount: u64) -> Result<()> {
        instructions::initialize(ctx, amount)
    }

    pub fn swap(ctx: Context<Swap>) -> Result<()> { Ok(()) }

    /// A helper that shares the module but is NOT an instruction — no Context param.
    pub fn compute_fee(amount: u64) -> u64 { amount / 100 }
}

#[derive(Accounts)]
pub struct Initialize<'info> { pub payer: Signer<'info> }
`;

describe('contract entrypoints — Anchor', () => {
  it('emits one queue entrypoint per Context-taking pub fn, namespaced by the program mod', async () => {
    const eps = extractRustEntrypoints([await rf('src/lib.rs', ANCHOR_SRC)], ID, {
      crates: [crateWith('anchor-lang')],
    });
    const topics = eps.map((e) => (e.details as QueueEntrypointDetails).topic);
    expect(topics).toEqual(['my_program::initialize', 'my_program::swap']);
    expect(eps.every((e) => e.type === 'queue')).toBe(true);
    expect(eps.every((e) => (e.details as QueueEntrypointDetails).system === 'solana-anchor')).toBe(true);
  });

  it('excludes a helper fn whose first parameter is not a Context<_>', async () => {
    const eps = extractRustEntrypoints([await rf('src/lib.rs', ANCHOR_SRC)], ID, {
      crates: [crateWith('anchor-lang')],
    });
    expect(eps.map((e) => (e.details as QueueEntrypointDetails).topic)).not.toContain('my_program::compute_fee');
  });

  it('emits NOTHING when no contract crate is a declared dependency', async () => {
    // `#[program]` is a plausible attribute name in unrelated code; a fabricated smart contract
    // is the one claim a reader scrutinizes hardest.
    const eps = extractRustEntrypoints([await rf('src/lib.rs', ANCHOR_SRC)], ID, { crates: [crateWith('serde')] });
    expect(eps).toEqual([]);
  });

  it('never emits contract handlers as `event` — no scorecard row counts that type', async () => {
    const eps = extractRustEntrypoints([await rf('src/lib.rs', ANCHOR_SRC)], ID, {
      crates: [crateWith('anchor-lang')],
    });
    expect(eps.some((e) => e.type === 'event')).toBe(false);
  });
});

describe('contract entrypoints — ink! and CosmWasm', () => {
  it('emits ink! messages and constructors, namespaced by their impl type', async () => {
    const src = `
impl Flipper {
    #[ink(constructor)]
    pub fn new(init: bool) -> Self { Self { value: init } }
    #[ink(message)]
    pub fn flip(&mut self) { self.value = !self.value; }
    #[ink(message)]
    pub fn get(&self) -> bool { self.value }
    pub fn not_a_message(&self) {}
}
`;
    const eps = extractRustEntrypoints([await rf('src/lib.rs', src)], ID, { crates: [crateWith('ink')] });
    expect(eps.map((e) => (e.details as QueueEntrypointDetails).topic)).toEqual([
      'Flipper::new',
      'Flipper::flip',
      'Flipper::get',
    ]);
  });

  it('finds CosmWasm entry points behind the real cfg_attr shape, namespaced by crate', async () => {
    const src = `
#[cfg_attr(not(feature = "library"), entry_point)]
pub fn instantiate(deps: DepsMut) -> StdResult<Response> { Ok(Response::new()) }

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn execute(deps: DepsMut) -> StdResult<Response> { Ok(Response::new()) }
`;
    const eps = extractRustEntrypoints([await rf('src/contract.rs', src)], ID, {
      crates: [crateWith('cosmwasm-std')],
      crateNameOf: new Map([['src/contract.rs', 'my-vault']]),
    });
    // `instantiate`/`execute`/`query` are the same three names in EVERY CosmWasm contract, and
    // the cross-repo linker joins queue entrypoints on the topic string alone.
    expect(eps.map((e) => (e.details as QueueEntrypointDetails).topic)).toEqual([
      'my_vault::instantiate',
      'my_vault::execute',
    ]);
  });
});

describe('http entrypoints — route attributes', () => {
  it('reads the verb from the attribute name and the path from its string arg', async () => {
    const src = `
#[get("/users")]
async fn list_users() -> String { String::new() }

/// docs between the attributes must not break the walk
#[post("/users/<id>")]
async fn create_user(id: u32) -> String { String::new() }
`;
    const eps = extractRustEntrypoints([await rf('src/api.rs', src)], ID, { crates: [crateWith()] });
    const details = eps.map((e) => e.details as HttpEntrypointDetails);
    expect(details.map((d) => `${d.method} ${d.fullPath}`)).toEqual(['GET /users', 'POST /users/{id}']);
  });

  it('composes a rocket mount base onto the handler’s own attribute path', async () => {
    const src = `
#[get("/list")]
fn list() -> String { String::new() }

fn rocket() -> Rocket { rocket::build().mount("/api/v1", routes![list]) }
`;
    const eps = extractRustEntrypoints([await rf('src/main.rs', src)], ID, { crates: [crateWith()] });
    expect((eps[0].details as HttpEntrypointDetails).fullPath).toBe('/api/v1/list');
  });

  it('points the handlerId at the real fn node', async () => {
    const src = '#[get("/x")]\nasync fn handler() -> String { String::new() }';
    const eps = extractRustEntrypoints([await rf('src/api.rs', src)], ID, { crates: [crateWith()] });
    expect(eps[0].handlerId).toBe(ID.functionId('src/api.rs', 'handler'));
  });

  it('drops a mount prefix claimed by two different bases rather than picking one', async () => {
    // `index` is mounted under BOTH /users and /posts. Neither prefix is decidable from the name,
    // and inventing one puts the route under a base the server does not serve it from.
    const users = await rf('src/users.rs', '#[get("/")]\nasync fn index() {}\n');
    const posts = await rf('src/posts.rs', '#[get("/")]\nasync fn index() {}\n');
    const main = await rf(
      'src/main.rs',
      `
fn app() -> Rocket {
    rocket::build()
        .mount("/users", routes![index])
        .mount("/posts", routes![index])
}
`,
    );
    const eps = extractRustEntrypoints([users, posts, main], ID, { crates: [crateWith()] });
    const paths = eps.map((e) => (e.details as HttpEntrypointDetails).fullPath).sort();
    expect(paths).toEqual(['/', '/']);
  });
});

describe('http entrypoints — router call shapes', () => {
  it('emits one entrypoint per method combinator on an axum .route()', async () => {
    const src = `
fn app() -> Router {
    Router::new()
        .route("/stream", get(get_stream).put(accept_put))
        .route("/health", get(health))
}
async fn get_stream() {}
async fn accept_put() {}
async fn health() {}
`;
    const eps = extractRustEntrypoints([await rf('src/app.rs', src)], ID, { crates: [crateWith()] });
    const paths = eps.map(
      (e) => `${(e.details as HttpEntrypointDetails).method} ${(e.details as HttpEntrypointDetails).fullPath}`,
    );
    expect(paths.sort()).toEqual(['GET /health', 'GET /stream', 'PUT /stream']);
  });

  it('binds a same-named handler to the fn in ITS OWN file, not the first file seen', async () => {
    // `index` / `list` / `create` / `health` are the same names in every module of a modular
    // router. A global name→id map gives file B's route file A's handler — an edge that resolves
    // to a real FunctionNode (so the invariant test passes) but points at the wrong function.
    const users = await rf(
      'src/users.rs',
      'pub async fn index() {}\npub fn routes() -> Router { Router::new().route("/users", get(index)) }\n',
    );
    const posts = await rf(
      'src/posts.rs',
      'pub async fn index() {}\npub fn routes() -> Router { Router::new().route("/posts", get(index)) }\n',
    );
    const eps = extractRustEntrypoints([users, posts], ID, { crates: [crateWith()] });
    const byPath = new Map(eps.map((e) => [(e.details as HttpEntrypointDetails).fullPath, e.handlerId]));
    expect(byPath.get('/users')).toBe(ID.functionId('src/users.rs', 'index'));
    expect(byPath.get('/posts')).toBe(ID.functionId('src/posts.rs', 'index'));
  });

  it('still resolves a handler defined in ANOTHER file when the name is unique', async () => {
    const handlers = await rf('src/handlers.rs', 'pub async fn list_users() {}\n');
    const app = await rf('src/app.rs', 'fn app() -> Router { Router::new().route("/users", get(list_users)) }\n');
    const eps = extractRustEntrypoints([handlers, app], ID, { crates: [crateWith()] });
    expect(eps[0].handlerId).toBe(ID.functionId('src/handlers.rs', 'list_users'));
  });

  it('applies an ARGUMENT-composed .nest() prefix but not to a route CHAINED after it', async () => {
    // `Router::new().nest("/api", inner).route("/health", …)` — `/health` is NOT under `/api`.
    // Emitting it as `/api/health` would be wrong at both ends of the cross-repo route join.
    const src = `
fn app() -> Router {
    Router::new()
        .nest("/api", Router::new().route("/users", get(list)))
        .route("/health", get(health))
}
async fn list() {}
async fn health() {}
`;
    const eps = extractRustEntrypoints([await rf('src/app.rs', src)], ID, { crates: [crateWith()] });
    const paths = eps.map((e) => (e.details as HttpEntrypointDetails).fullPath).sort();
    expect(paths).toEqual(['/api/users', '/health']);
  });

  it('applies a CHAIN-composed actix scope prefix to routes chained onto it', async () => {
    const src = `
fn config(cfg: &mut ServiceConfig) {
    cfg.service(web::scope("/api").route("/users", web::get().to(list_users)));
}
async fn list_users() {}
`;
    const eps = extractRustEntrypoints([await rf('src/app.rs', src)], ID, { crates: [crateWith()] });
    const d = eps[0].details as HttpEntrypointDetails;
    expect(`${d.method} ${d.fullPath}`).toBe('GET /api/users');
  });

  it('never emits the mount itself as an endpoint', async () => {
    const src = 'fn app() -> Router { Router::new().nest("/api", other_router()) }';
    const eps = extractRustEntrypoints([await rf('src/app.rs', src)], ID, { crates: [crateWith()] });
    expect(eps).toEqual([]);
  });

  it('skips a route whose path is not a string literal rather than inventing one', async () => {
    const src = 'fn app() -> Router { Router::new().route(WALK_DIR_PATH, get(handler)) }\nasync fn handler() {}';
    expect(extractRustEntrypoints([await rf('src/app.rs', src)], ID, { crates: [crateWith()] })).toEqual([]);
  });
});

describe('grpc entrypoints — tonic', () => {
  it('reads the service name off the generated <Svc>Server trait and one RPC per method', async () => {
    const src = `
#[tonic::async_trait]
impl GreeterServer for MyGreeter {
    async fn say_hello(&self, request: Request<HelloRequest>) -> Result<Response<HelloReply>, Status> { todo!() }
    async fn watch(&self, request: Request<Streaming<Ping>>) -> Result<Response<PongStream>, Status> { todo!() }
}
`;
    const eps = extractRustEntrypoints([await rf('src/grpc.rs', src)], ID, { crates: [crateWith('tonic')] });
    const details = eps.map((e) => e.details as GrpcEntrypointDetails);
    expect(eps.every((e) => e.type === 'grpc')).toBe(true);
    expect(details.map((d) => `${d.serviceName}/${d.methodName}:${d.streaming}`)).toEqual([
      'Greeter/say_hello:unary',
      'Greeter/watch:bidirectional',
    ]);
  });

  it('ignores an ordinary trait impl', async () => {
    const src = 'impl Display for Thing { fn fmt(&self, f: &mut Formatter) -> Result { Ok(()) } }';
    expect(extractRustEntrypoints([await rf('src/x.rs', src)], ID, { crates: [crateWith()] })).toEqual([]);
  });
});

describe('http entrypoints — profile-declared registration call shapes', () => {
  const REG = { callee: 'insert', methodArg: 0, pathArg: 1, handlerArg: 2 };

  it('emits a verb-first registration with a format!-composed const-prefixed path', async () => {
    const routes = `
pub fn register(r: &mut S3Router<AdminOperation>) -> std::io::Result<()> {
    r.insert(
        Method::POST,
        format!("{}{}", ADMIN_PREFIX, "/v3/kms/create-key").as_str(),
        AdminOperation(&CreateKeyHandler {}),
    )?;
    Ok(())
}
`;
    const prefix = 'pub(crate) const ADMIN_PREFIX: &str = "/rustfs/admin";';
    const handlers = `
pub struct CreateKeyHandler {}
impl Operation for CreateKeyHandler {
    async fn call(&self, req: S3Request<Body>) -> S3Result<S3Response<Body>> { todo!() }
}
`;
    const eps = extractRustEntrypoints(
      [await rf('src/admin/kms.rs', routes), await rf('src/prefix.rs', prefix), await rf('src/handlers.rs', handlers)],
      ID,
      { crates: [crateWith()], registrationCalls: [REG] },
    );
    expect(eps).toHaveLength(1);
    const d = eps[0].details as HttpEntrypointDetails;
    expect(`${d.method} ${d.fullPath}`).toBe('POST /rustfs/admin/v3/kms/create-key');
    // The handler struct resolved to its impl's single method — a REAL fn id, not synthetic.
    expect(eps[0].handlerId).toContain('handlers');
  });

  it('resolves an inline {IDENT} format hole and a plain fn handler identifier', async () => {
    const src = `
const BASE: &str = "/api";
async fn health() {}
pub fn register(r: &mut MyRouter) {
    r.insert(Method::GET, format!("{BASE}/health").as_str(), health);
}
`;
    const eps = extractRustEntrypoints([await rf('src/app.rs', src)], ID, {
      crates: [crateWith()],
      registrationCalls: [REG],
    });
    expect(eps).toHaveLength(1);
    const d = eps[0].details as HttpEntrypointDetails;
    expect(`${d.method} ${d.fullPath}`).toBe('GET /api/health');
    expect(eps[0].handlerId).toBe(ID.functionId('src/app.rs', 'health'));
  });

  it('keeps an unresolvable format hole as a {param} segment instead of dropping the route', async () => {
    const src = 'fn reg(r: &mut R) { r.insert(Method::GET, format!("{}/status", dynamic_prefix()).as_str(), h); }';
    const eps = extractRustEntrypoints([await rf('src/app.rs', src)], ID, {
      crates: [crateWith()],
      registrationCalls: [REG],
    });
    expect(eps).toHaveLength(1);
    expect((eps[0].details as HttpEntrypointDetails).fullPath).toBe('/{dynamic_prefix}/status');
  });

  it('a const declared with two DIFFERENT values is ambiguous and stays a template segment', async () => {
    const files = [
      await rf('src/a.rs', 'const PREFIX: &str = "/a";'),
      await rf('src/b.rs', 'const PREFIX: &str = "/b";'),
      await rf('src/app.rs', 'fn reg(r: &mut R) { r.insert(Method::GET, format!("{PREFIX}/x").as_str(), h); }'),
    ];
    const eps = extractRustEntrypoints(files, ID, { crates: [crateWith()], registrationCalls: [REG] });
    expect((eps[0].details as HttpEntrypointDetails).fullPath).toBe('/{PREFIX}/x');
  });

  it('without the profile entry the shape stays invisible (no default registration callees)', async () => {
    const src = 'fn reg(r: &mut R) { r.insert(Method::GET, "/x", h); }';
    expect(extractRustEntrypoints([await rf('src/app.rs', src)], ID, { crates: [crateWith()] })).toEqual([]);
  });

  it('a map-like .insert(key, value) with no resolvable path string is not a route', async () => {
    const src = 'fn f(h: &mut HeaderMap) { h.insert(name, header_value); }';
    const eps = extractRustEntrypoints([await rf('src/app.rs', src)], ID, {
      crates: [crateWith()],
      registrationCalls: [REG],
    });
    expect(eps).toEqual([]);
  });
});

describe('registration shapes — verb-position strictness', () => {
  it('skips a map-like insert whose declared method position is not a verb', async () => {
    const src = 'fn f(m: &mut Map) { m.insert(Kind::Primary, "/looks/like/a/path", value); }';
    const eps = extractRustEntrypoints([await rf('src/app.rs', src)], ID, {
      crates: [crateWith()],
      registrationCalls: [{ callee: 'insert', methodArg: 0, pathArg: 1, handlerArg: 2 }],
    });
    expect(eps).toEqual([]);
  });
});

describe('registration shapes — const resolution scoping', () => {
  it('an associated const inside an impl does not poison the module-level const', async () => {
    const files = [
      await rf('src/prefix.rs', 'pub(crate) const ADMIN_PREFIX: &str = "/rustfs/admin";'),
      await rf('src/policy.rs', 'impl Action { const ADMIN_PREFIX: &\'static str = "admin:"; fn f(&self) {} }'),
      await rf(
        'src/app.rs',
        'fn reg(r: &mut R) { r.insert(Method::GET, format!("{ADMIN_PREFIX}/info").as_str(), h); }',
      ),
    ];
    const eps = extractRustEntrypoints(files, ID, {
      crates: [crateWith()],
      registrationCalls: [{ callee: 'insert', methodArg: 0, pathArg: 1, handlerArg: 2 }],
    });
    expect((eps[0].details as HttpEntrypointDetails).fullPath).toBe('/rustfs/admin/info');
  });
});
