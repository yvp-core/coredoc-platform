# Adding a Framework to coredoc

> **Status: shipped.** Every registered language's profiles resolve through one path
> (`providers/resolve.ts` → the registry), so this contract is what the code does today,
> not a migration target. Registered languages: **TS/JS, Ruby, Swift, Python, Rust, Go**.

You need this guide when the **language is already registered** (see above) and
you're onboarding a new framework or convention: NestJS, Express, Fastify, Prisma,
TypeORM, Grape, Rails, Karafka, and so on. If your *language* isn't supported yet, start
with [ADDING-A-LANGUAGE.md](./ADDING-A-LANGUAGE.md).

## A framework is a profile object — no code

Adding a framework is **pure data**: you author one profile module describing the
framework's conventions, and register it. You do not touch the engine, the substrate, or
any provider. The engine interprets your profile against the language's substrate facts.

```ts
export const myFrameworkProfile: ExtractionProfile = {
  parserId: 'acme-nest',
  substrate: { language: 'ts', include: ['src/**/*.ts'], exclude: ['**/*.spec.ts'] },
  // …detector rules below
};
```

## The detector / ArgRef / handler-table vocabulary

A profile expresses conventions through a fixed vocabulary the engine already understands:

- **`Detector`** — how a construct is recognized. Kinds include `class-decorator`,
  `method-decorator`, `property-decorator`, and `call-shape` (a call matching a
  receiver/method pattern). Example: a NestJS controller is a `class-decorator` on
  `@Controller`; a route is a `method-decorator` on `@Get`/`@Post`.
- **`ArgRef`** — how to read a value out of a matched construct's arguments: `as:
  'string-literal'`, `'const-string'` (resolve a referenced constant), `'arrow-target'`,
  etc. Example: the route path is the first `string-literal` arg of `@Get('…')`.
- **`HandlerTable`** — maps a registration call to the function it wires up, so the engine
  can connect an entrypoint to its handler.

Existing profiles are the best reference — copy the closest one and adapt (e.g. a
NestJS + MikroORM backend, a Koa + Sequelize service, or a React admin frontend).

## The honest boundary

This works **only** when the framework's conventions map onto the existing vocabulary.
That covers the overwhelming majority of decorator/registration/ORM frameworks. When a
construct genuinely doesn't fit:

1. **`customRules`** — the read-only escape hatch. A typed function
   `(facts: CustomRuleFacts) => CustomRuleEmit` that emits entrypoints/entities/etc. from
   substrate facts the declarative rules can't express. The bound is the narrow
   facts→emit API, not arbitrary code reaching into the engine.
2. **Graduate a primitive** — if the same custom shape recurs across frameworks, it should
   become a first-class `Detector`/`ArgRef` kind that benefits every language. File an
   issue rather than copy-pasting `customRules`.

Do **not** reach for a new language path or fork the engine to fit a framework — that
re-creates the exact two-path duplication Phase 4 removed.

## Register and score

1. Add your profile to the single `profile-registry.ts` (name → profile). This makes it
   resolvable by `--profile <name>` everywhere (parse, score, evals).
2. Run the `score` CLI against a repo using the framework — it reports a coverage verdict
   per category (http, queue, entities, dbOperations, externalCalls) against
   source-signal denominators, so you can iterate the profile until coverage is green.

## Anti-patterns

- **Don't** gate behavior on a detected framework *identity* — a strict framework is not a
  guarantee of conventions. Decide on observed data shape (the detector matched), not on
  "this is NestJS". (See the repo's `feedback_no_framework_identity_heuristics` rule.)
- **Don't** hardcode client/company/SDK names in a profile that's meant to be shared
  infrastructure — keep profiles convention-driven.
- **Don't** fork the profile *type* or bypass the engine for a framework. A framework is
  data; only a new *language* implements code (and even then, only a substrate).
