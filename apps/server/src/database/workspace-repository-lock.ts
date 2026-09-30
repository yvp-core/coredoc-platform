import type { Prisma } from '../generated/prisma/client.js';

/**
 * Serialize workspace repository identity mutations with capture resolution.
 *
 * This deliberately reuses the workspace advisory-lock namespace already used
 * by graph publication, so repository identity and graph control-plane writes
 * cannot acquire the same rows in an inverted order.
 */
export async function lockWorkspaceRepositoryIdentity(
  transaction: Prisma.TransactionClient,
  workspaceId: string,
): Promise<void> {
  await transaction.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(${workspaceId}, 0))
  `;
}

export const WORKSPACE_REPOSITORY_TRANSACTION_OPTIONS = {
  maxWait: 5_000,
  timeout: 10_000,
} as const;
