import { serverUrl } from '../../auth/oauth/server-url.js';
import type { PrismaService } from '../../database/prisma.service.js';

/** The run page in the web app, which the server serves; pull request bodies and Jira comments link to it. */
export async function runPageUrl(
  prisma: Pick<PrismaService, 'workspace'>,
  workspaceId: string,
  runId: string,
): Promise<string> {
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { slug: true } });
  return `${serverUrl()}/w/${encodeURIComponent(workspace.slug)}/agent-runs/${runId}`;
}
