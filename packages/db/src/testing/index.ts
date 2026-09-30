/**
 * Test-only fixtures shipped from `@coredoc/db/testing`.
 *
 * Deliberately a SEPARATE entry point: nothing here is part of the runtime
 * contract, and importing it from `@coredoc/db` would put fixture builders in
 * every consumer's module graph.
 *
 * IT STAYS IN THE PUBLISHED OUTPUT, and that is a decision rather than an
 * oversight. Its consumers are the server's intent tests, which live in another
 * package and therefore need a real resolvable entry point; moving the fixtures
 * into a devDependency-only package would add a package to the workspace to
 * serve one consumer set, and nothing outside a test resolves this path anyway.
 * The cost being accepted is package size plus the invitation to import a
 * fixture from product code — and THAT half is enforced rather than trusted:
 * `biome.jsonc` restricts `@coredoc/db/testing` to `*.test.ts` and
 * `*.test-support.ts`, so a product-path import fails `pnpm lint`. A fixture
 * reached from a product path would put fabricated nodes into a real graph read.
 */
export {
  FIXTURE_REPO_A_COMMIT,
  FIXTURE_REPO_A_HASH,
  FIXTURE_REPO_A_NAME,
  FIXTURE_REPO_B_COMMIT,
  FIXTURE_REPO_B_HASH,
  FIXTURE_REPO_B_NAME,
  buildIntentGraphFixture,
  openIntentGraphFixture,
  type BuildIntentFixtureOptions,
  type FixtureRepoNodes,
  type FixtureScale,
  type IntentGraphFixture,
  type OpenedIntentGraphFixture,
} from './intent-graph-fixture.js';
