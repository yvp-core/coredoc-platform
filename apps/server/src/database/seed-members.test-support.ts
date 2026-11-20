import type { Prisma, PrismaClient } from '../generated/prisma/client.js';

type MemberSeed = Prisma.WorkspaceMemberCreateManyInput & { role?: string };

/**
 * Inserts workspace members together with their workspace role, which is stored
 * as a binding on the workspace (see auth/iam.ts) rather than on the member row.
 */
export async function seedMembers(prisma: Pick<PrismaClient, 'workspaceMember' | 'accessBinding'>, rows: MemberSeed[]) {
  await prisma.workspaceMember.createMany({ data: rows.map(({ role: _role, ...member }) => member) });
  await prisma.accessBinding.createMany({
    data: rows.map((row) => ({
      workspaceId: row.workspaceId,
      userId: row.userId,
      role: row.role ?? 'member',
      resourceType: 'workspace',
      resourceId: row.workspaceId,
    })),
  });
}
