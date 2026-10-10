/**
 * Repo connect/update against real PostgreSQL: the atomicity of the durable
 * intent identity, and the pairing between `normalizeGitRemote` and
 * `workspace_repos_normalized_git_remote_check`.
 *
 * WHY REAL POSTGRES. The two properties under test are properties of the
 * DATABASE, not of the service: that a refused identity write takes the repo
 * row down with it (one transaction, one advisory lock), and that every remote
 * the normalizer accepts is a value the CHECK accepts. A fake store proves
 * neither — the previous build passed its unit tests while emitting remotes the
 * CHECK bounced with a 500 halfway through a connect.
 *
 * Nest is deliberately NOT booted: the identity rules live in the service and
 * the constraints live in the schema, and neither needs a guard stack to be
 * exercised. The HTTP surface is covered by the repos controller's own tests.
 */
import '../../config/load-env.js';
import { BadRequestException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ControlPlaneService } from '../../database/control-plane.service.js';
import { buildPrismaAdapter } from '../../database/create-prisma-client.js';
import type { PrismaService } from '../../database/prisma.service.js';
import { PrismaClient } from '../../generated/prisma/client.js';
import type { ConnectRepoInput } from './repos.contract.js';
import type { UpdateRepoInput } from './repos.contract.js';
import { graphRepoHashOf } from './repo-intent-identity.js';
import { ReposService } from './repos.service.js';

const TEST_DATABASE_URL = process.env.REPOS_IDENTITY_TEST_DATABASE_URL ?? '';
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;

describe.skipIf(!TEST_DATABASE_URL)('repo durable identity (PostgreSQL integration)', () => {
  let prisma: PrismaClient;
  let pool: ReturnType<typeof buildPrismaAdapter>;
  let previousDatabaseUrl: string | undefined;
  let service: ReposService;
  let workspaceId: string;

  beforeAll(async () => {
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    pool = buildPrismaAdapter();
    prisma = new PrismaClient({ adapter: pool?.adapter } as never);
    await prisma.$connect();

    const workspace = await prisma.workspace.create({
      data: { name: `repos-identity-${RUN}`, slug: `repos-identity-${RUN}` },
    });
    workspaceId = workspace.id;

    const controlPlane = new ControlPlaneService(prisma as unknown as PrismaService);
    // `getRepoState` is the only method that touches result storage, and no
    // case here calls it.
    service = new ReposService(controlPlane, {} as never);
  });

  afterAll(async () => {
    if (!TEST_DATABASE_URL) return;
    await prisma.workspaceRepo.deleteMany({ where: { workspaceId } });
    await prisma.workspace.delete({ where: { id: workspaceId } });
    await prisma.$disconnect();
    await pool?.pool?.end();
    process.env.DATABASE_URL = previousDatabaseUrl;
  });

  let seed = 0;
  function repoName(prefix: string): string {
    seed += 1;
    return `${prefix}-${RUN}-${seed}`;
  }

  const connect = (dto: Partial<ConnectRepoInput> & { repoName: string }) =>
    service.connectRepo(workspaceId, { repoKey: graphRepoHashOf(dto.repoName), ...dto } as ConnectRepoInput);

  const row = (name: string) =>
    prisma.workspaceRepo.findUnique({
      where: { workspaceId_repoKey: { workspaceId, repoKey: graphRepoHashOf(name) } },
    });

  it('persists, preserves and clears a repository delivery override independently', async () => {
    const name = repoName('delivery');
    const repo = await connect({ repoName: name });
    await service.updateRepo(workspaceId, repo.repoKey, {
      productionBranch: 'production',
      intentReleaseTrigger: 'deploy',
    });
    expect(await row(name)).toMatchObject({ productionBranch: 'production', intentReleaseTrigger: 'deploy' });
    await service.updateRepo(workspaceId, repo.repoKey, { productionBranch: 'release' });
    expect(await row(name)).toMatchObject({ productionBranch: 'release', intentReleaseTrigger: 'deploy' });
    await service.updateRepo(workspaceId, repo.repoKey, { intentReleaseTrigger: null });
    expect(await row(name)).toMatchObject({ intentReleaseTrigger: null });
  });

  it('binds the durable key the client sent, for a repo whose key is not its name', async () => {
    // The defect this closes: no client ever sent `intentRepoKey`, so a repo
    // with an explicit `repos[].key` could only ever bind through the
    // name==key fallback — and stayed unbound forever when it differed.
    const durableKey = `github.com/acme/${repoName('keyed')}`;
    const connected = await service.connectRepo(workspaceId, {
      repoKey: graphRepoHashOf(durableKey),
      repoName: 'orders-api-display-name',
      intentRepoKey: durableKey,
    } as ConnectRepoInput);

    expect(connected).toMatchObject({ intentRepoKey: durableKey });
  });

  it('refuses an unprovable durable key WITHOUT connecting the repo', async () => {
    const name = repoName('unprovable');
    await expect(connect({ repoName: name, intentRepoKey: 'not-the-key' })).rejects.toBeInstanceOf(BadRequestException);
    expect(await row(name)).toBeNull();
  });

  /**
   * The normalizer/CHECK pairing, end to end. Each of these inputs produced a
   * CHECK-violating value before the totality fix: `.git.git` survived one
   * strip, and the scp form let `#`/`?` through as a "host".
   */
  it.each([
    ['https://github.com/acme/orders.git.git', 'github.com/acme/orders'],
    ['git@github.com:acme/orders.git.git', 'github.com/acme/orders'],
    ['git@bad#host:acme/orders', null],
    ['git@host?x:acme/orders', null],
    ['file:///srv/git/orders', null],
    [`git@h:${'a'.repeat(2_042)}`, null],
  ])('stores a remote the CHECK accepts, or no remote at all: %s', async (gitUrl, expected) => {
    const name = repoName('remote');
    await connect({ repoName: name, gitUrl });
    const stored = await row(name);
    // Either way the connect SUCCEEDED: an origin the projection cannot
    // canonicalize is "no durable remote", not a refused repo.
    expect(stored).not.toBeNull();
    expect(stored?.normalizedGitRemote).toBe(expected);
    expect(stored?.intentRepoKey).toBe(name);
  });

  it('fills a legacy NULL intent key through PATCH, without a disconnect', async () => {
    // The state a pre-field client leaves behind: connected, unbound. The
    // remedy has to be a PATCH — reconnecting answers "already connected".
    const durableKey = `github.com/acme/${repoName('legacy')}`;
    const repoKey = graphRepoHashOf(durableKey);
    await prisma.workspaceRepo.create({ data: { workspaceId, repoKey, repoName: 'legacy-display-name' } });

    await service.updateRepo(workspaceId, repoKey, {
      intentRepoKey: durableKey,
      httpPrefix: '/v1/legacy',
    } as UpdateRepoInput);

    const stored = await prisma.workspaceRepo.findUnique({
      where: { workspaceId_repoKey: { workspaceId, repoKey } },
    });
    expect(stored).toMatchObject({ intentRepoKey: durableKey, httpPrefix: '/v1/legacy' });
  });

  it('refuses a rebind, and leaves the PATCH s other fields unapplied', async () => {
    const name = repoName('rebind');
    await connect({ repoName: name, httpPrefix: '/v1/original' });

    await expect(
      service.updateRepo(workspaceId, graphRepoHashOf(name), {
        intentRepoKey: `${name}-renamed`,
        httpPrefix: '/v1/changed',
      } as UpdateRepoInput),
    ).rejects.toBeInstanceOf(BadRequestException);

    // Identity is the stricter gate and it runs inside the same transaction:
    // a refused rebind cannot leave the mutable fields half-applied.
    expect(await row(name)).toMatchObject({ intentRepoKey: name, httpPrefix: '/v1/original' });
  });
});
