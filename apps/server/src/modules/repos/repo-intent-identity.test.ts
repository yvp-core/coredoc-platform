/**
 * Durable repo identity binding (spec §6.5): the proof, the TOFU rule, and the
 * normalized-remote projection.
 *
 * The DB CHECK (`workspace_repos_intent_repo_key_graph_hash_check`) is asserted
 * against real PostgreSQL in
 * `src/modules/intent/intent-anchor.postgres.integration.test.ts`; this suite
 * owns the decisions the service makes BEFORE the write reaches it.
 */

import { BadRequestException, ConflictException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { PrismaService } from '../../database/prisma.service.js';
import {
  bindRepoIntentIdentity,
  graphRepoHashOf,
  repoIdentityConstraintError,
  resolveIntentRepoKey,
} from './repo-intent-identity.js';

const NAMED = { repoName: 'orders-api', repoKey: graphRepoHashOf('orders-api') };
const KEYED = { repoName: 'orders-api', repoKey: graphRepoHashOf('github.com/acme/orders-api') };

describe('resolveIntentRepoKey', () => {
  it('binds the repo name when it reproduces the graph key', () => {
    expect(resolveIntentRepoKey(NAMED, {})).toBe('orders-api');
  });

  it('leaves an explicitly-keyed repo unbound rather than guessing', () => {
    // `repoKey` here is the hash of an explicit key that cannot be reversed from
    // the hash — the same rule the migration's backfill used.
    expect(resolveIntentRepoKey(KEYED, {})).toBeNull();
  });

  it('accepts a client-supplied durable key that reproduces the graph key', () => {
    expect(resolveIntentRepoKey(KEYED, { intentRepoKey: 'github.com/acme/orders-api' })).toBe(
      'github.com/acme/orders-api',
    );
  });

  it('refuses a durable key that does not reproduce the graph key', () => {
    expect(() => resolveIntentRepoKey(KEYED, { intentRepoKey: 'github.com/acme/wrong' })).toThrow(BadRequestException);
  });

  it('proves the relation with the unchanged graph-id algorithm', () => {
    expect(graphRepoHashOf('orders-api')).toHaveLength(12);
    expect(graphRepoHashOf('orders-api')).not.toBe(graphRepoHashOf('orders-api2'));
  });
});

/* -------------------------------------------------------------- TOFU write --- */

interface Row {
  repoKey: string;
  intentRepoKey: string | null;
  normalizedGitRemote: string | null;
}

/** A prisma stand-in that models the `updateMany` WHERE the TOFU rule relies on. */
function fakePrisma(row: Row | null) {
  const state = { row };
  const prisma = {
    workspaceRepo: {
      async updateMany({
        where,
        data,
      }: {
        where: { repoKey: string; OR?: { intentRepoKey: string | null }[] };
        data: Partial<Row>;
      }) {
        const current = state.row;
        if (!current || current.repoKey !== where.repoKey) return { count: 0 };
        if (where.OR && !where.OR.some((clause) => clause.intentRepoKey === current.intentRepoKey)) {
          return { count: 0 };
        }
        Object.assign(current, data);
        return { count: 1 };
      },
      async findUnique() {
        return state.row;
      },
    },
  };
  return { prisma: prisma as unknown as PrismaService, state };
}

describe('bindRepoIntentIdentity', () => {
  const repo = { repoKey: NAMED.repoKey, repoName: NAMED.repoName };

  it('binds an unbound row on first use', async () => {
    const { prisma, state } = fakePrisma({ repoKey: NAMED.repoKey, intentRepoKey: null, normalizedGitRemote: null });
    await bindRepoIntentIdentity(prisma, 'ws-1', repo, {});
    expect(state.row?.intentRepoKey).toBe('orders-api');
  });

  it('is a no-op when the same identity is written again', async () => {
    const { prisma, state } = fakePrisma({
      repoKey: NAMED.repoKey,
      intentRepoKey: 'orders-api',
      normalizedGitRemote: null,
    });
    await expect(bindRepoIntentIdentity(prisma, 'ws-1', repo, {})).resolves.toBeUndefined();
    expect(state.row?.intentRepoKey).toBe('orders-api');
  });

  it('refuses a rebind: the hash proof fires before anything is written', async () => {
    const { prisma, state } = fakePrisma({
      repoKey: KEYED.repoKey,
      intentRepoKey: 'github.com/acme/orders-api',
      normalizedGitRemote: null,
    });
    // This IS the rebind refusal, and it is airtight rather than a policy check:
    // a second durable key would have to hash to the same graph key.
    await expect(
      bindRepoIntentIdentity(
        prisma,
        'ws-1',
        { repoKey: KEYED.repoKey, repoName: 'orders-api' },
        {
          intentRepoKey: 'github.com/acme/orders-api-renamed',
        },
      ),
    ).rejects.toThrow(BadRequestException);
    expect(state.row?.intentRepoKey).toBe('github.com/acme/orders-api');

    await expect(
      bindRepoIntentIdentity(
        prisma,
        'ws-1',
        { repoKey: KEYED.repoKey, repoName: 'orders-api' },
        { intentRepoKey: 'github.com/acme/orders-api' },
      ),
    ).resolves.toBeUndefined();
  });

  it('is a backstop for a row bound by something other than the proof', async () => {
    // `workspace_repos_intent_repo_key_graph_hash_check` makes this row
    // unreachable through any sanctioned write — a fake store can produce it,
    // and the guard exists so a future path that bypasses the proof (a
    // migration, a console) still cannot silently re-point existing anchors.
    const { prisma } = fakePrisma({
      repoKey: NAMED.repoKey,
      intentRepoKey: 'orders-api-old',
      normalizedGitRemote: null,
    });
    await expect(bindRepoIntentIdentity(prisma, 'ws-1', repo, {})).rejects.toThrow(ConflictException);
  });

  it('stores the canonical remote and clears it on an explicit null', async () => {
    const { prisma, state } = fakePrisma({ repoKey: NAMED.repoKey, intentRepoKey: null, normalizedGitRemote: null });
    await bindRepoIntentIdentity(prisma, 'ws-1', repo, { gitUrl: 'git@github.com:acme/orders-api.git' });
    expect(state.row?.normalizedGitRemote).toBe('github.com/acme/orders-api');

    await bindRepoIntentIdentity(prisma, 'ws-1', repo, { gitUrl: null });
    expect(state.row?.normalizedGitRemote).toBeNull();
  });

  it('leaves the remote alone when the update says nothing about it', async () => {
    const { prisma, state } = fakePrisma({
      repoKey: NAMED.repoKey,
      intentRepoKey: 'orders-api',
      normalizedGitRemote: 'github.com/acme/orders-api',
    });
    await bindRepoIntentIdentity(prisma, 'ws-1', repo, {});
    expect(state.row?.normalizedGitRemote).toBe('github.com/acme/orders-api');
  });

  it('records "no durable remote" for an origin it cannot canonicalize', async () => {
    const { prisma, state } = fakePrisma({ repoKey: NAMED.repoKey, intentRepoKey: null, normalizedGitRemote: null });
    await bindRepoIntentIdentity(prisma, 'ws-1', repo, { gitUrl: 'file:///srv/git/orders-api' });
    expect(state.row?.normalizedGitRemote).toBeNull();
    // The identity binding still happened: an unusable remote is not a reason to
    // leave the repo unaddressable by anchors.
    expect(state.row?.intentRepoKey).toBe('orders-api');
  });

  it('does nothing at all when there is neither a key to bind nor a remote to write', async () => {
    const { prisma, state } = fakePrisma({ repoKey: KEYED.repoKey, intentRepoKey: null, normalizedGitRemote: null });
    await bindRepoIntentIdentity(prisma, 'ws-1', { repoKey: KEYED.repoKey, repoName: 'orders-api' }, {});
    expect(state.row?.intentRepoKey).toBeNull();
  });

  it('renders a storage-constraint backstop as a 4xx naming the value, never a 500', async () => {
    const failing = {
      workspaceRepo: {
        async updateMany() {
          throw new Error('new row violates check constraint "workspace_repos_normalized_git_remote_check"');
        },
        async findUnique() {
          return null;
        },
      },
    } as unknown as PrismaService;
    const error = await bindRepoIntentIdentity(failing, 'ws-1', repo, {
      gitUrl: 'git@github.com:acme/orders-api.git',
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as Error).message).toContain('github.com/acme/orders-api');
  });
});

/* --------------------------------------------- constraint-error rendering --- */

describe('repoIdentityConstraintError', () => {
  const offending = { intentRepoKey: 'orders-api', remote: 'github.com/acme/orders-api' };

  it('names the offending remote for the remote CHECK', () => {
    const mapped = repoIdentityConstraintError(
      new Error('violates check constraint "workspace_repos_normalized_git_remote_check"'),
      offending,
    );
    expect(mapped).toBeInstanceOf(BadRequestException);
    expect((mapped as Error).message).toContain('github.com/acme/orders-api');
  });

  it('names the offending durable key for the graph-hash CHECK', () => {
    const mapped = repoIdentityConstraintError(
      new Error('violates check constraint "workspace_repos_intent_repo_key_graph_hash_check"'),
      offending,
    );
    expect(mapped).toBeInstanceOf(BadRequestException);
    expect((mapped as Error).message).toContain('orders-api');
  });

  it('maps the identity unique index to a conflict, reading Prisma P2002 metadata', () => {
    const prismaUnique = Object.assign(new Error('Unique constraint failed'), {
      code: 'P2002',
      meta: { target: 'workspace_repos_workspace_id_intent_repo_key_key' },
    });
    expect(repoIdentityConstraintError(prismaUnique, offending)).toBeInstanceOf(ConflictException);
  });

  it('rethrows anything it does not recognise rather than dressing it up as a client error', () => {
    const unrelated = new Error('connection terminated unexpectedly');
    expect(repoIdentityConstraintError(unrelated, offending)).toBe(unrelated);
  });
});
