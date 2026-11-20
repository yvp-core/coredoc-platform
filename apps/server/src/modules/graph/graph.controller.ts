import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../../auth/auth.guard.js';
import { WorkspaceRoleGuard } from '../../auth/workspace-role.guard.js';
import { PermissionsGuard, TokenPermission } from '../../auth/permissions.guard.js';
import { WorkspaceRole } from '../../auth/decorators/workspace-role.decorator.js';
import { RequirePermission } from '../../auth/decorators/require-permission.decorator.js';
import { CurrentReader } from '../../auth/decorators/current-reader.decorator.js';
import type { RepoReader } from '../../database/control-plane.service.js';
import { type EdgesAmongBody, GraphService } from './graph.service.js';
import { GraphRateLimitGuard } from './graph-rate-limit.guard.js';

/**
 * REST parity layer for the parsed code graph — exposes the exact same
 * portable @coredoc/mcp handlers the MCP tools invoke, so the web UI sees
 * what agents see. Guard stack mirrors ReposController: AuthGuard +
 * WorkspaceRoleGuard gate workspace membership; PermissionsGuard +
 * @RequirePermission(GraphRead) additionally gate service tokens (a leaked
 * CI/CD token must opt in to `graph:read` explicitly). JWT/browser users
 * bypass PermissionsGuard entirely — see permissions.guard.ts — and reach
 * every route via the @WorkspaceRole('member') role check alone.
 *
 * `scopeRepo` is the one param name across every route here for "narrow to
 * this repo" — `entrypoints` used to call it `repo`; unified so a B2 frontend
 * has exactly one query-param concept to reason about, not two spellings of
 * the same thing.
 *
 * Tier B (explorer) node/neighbor routes take the node id as a `?id=` QUERY
 * param, not a path segment: node ids embed both `/` (file paths) and `:`, so a
 * `:nodeId` path param would break on the slash and — even url-encoded — trips
 * the `%2F`-in-path rejection of the ingress this deploys behind. A query param
 * sidesteps both. `GraphRateLimitGuard` runs LAST so it keys on the
 * authenticated principal; it is the DoS boundary for this browser-reachable
 * surface (§3.2).
 */
@Controller('workspaces/:workspaceId/graph')
@UseGuards(AuthGuard, WorkspaceRoleGuard, PermissionsGuard, GraphRateLimitGuard)
export class GraphController {
  constructor(private readonly graphService: GraphService) {}

  @Get('search')
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.GraphRead)
  async search(
    @Param('workspaceId') workspaceId: string,
    @CurrentReader() reader: RepoReader,
    @Query('q') q?: string,
    @Query('types') types?: string,
    @Query('scopeRepo') scopeRepo?: string,
    @Query('limit') limit?: string,
  ) {
    return this.graphService.searchSymbols(workspaceId, reader, { q, types, scopeRepo, limit });
  }

  @Get('overview')
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.GraphRead)
  async overview(
    @Param('workspaceId') workspaceId: string,
    @CurrentReader() reader: RepoReader,
    @Query('scopeRepo') scopeRepo?: string,
  ) {
    return this.graphService.overview(workspaceId, reader, { scopeRepo });
  }

  @Get('service-dependencies')
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.GraphRead)
  async serviceDependencies(
    @Param('workspaceId') workspaceId: string,
    @CurrentReader() reader: RepoReader,
    @Query('scopeRepo') scopeRepo?: string,
  ) {
    return this.graphService.serviceDependencies(workspaceId, reader, { scopeRepo });
  }

  @Get('entrypoints')
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.GraphRead)
  async entrypoints(
    @Param('workspaceId') workspaceId: string,
    @CurrentReader() reader: RepoReader,
    @Query('scopeRepo') scopeRepo?: string,
    @Query('protocol') protocol?: string,
    @Query('limit') limit?: string,
  ) {
    return this.graphService.entrypoints(workspaceId, reader, { scopeRepo, protocol, limit });
  }

  @Get('node')
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.GraphRead)
  async node(@Param('workspaceId') workspaceId: string, @CurrentReader() reader: RepoReader, @Query('id') id?: string) {
    return this.graphService.nodeDetail(workspaceId, reader, id ?? '');
  }

  @Get('neighbors')
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.GraphRead)
  async neighbors(
    @Param('workspaceId') workspaceId: string,
    @CurrentReader() reader: RepoReader,
    @Query('id') id?: string,
    @Query('direction') direction?: string,
    @Query('edgeTypes') edgeTypes?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.graphService.neighbors(workspaceId, reader, id ?? '', { direction, edgeTypes, limit, cursor });
  }

  /**
   * Bounded depth-N subgraph from a focus node (click-to-traverse). Like
   * `neighbors`, the node id rides as `?id=`; `depth` is capped server-side.
   */
  @Get('subgraph')
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.GraphRead)
  async subgraph(
    @Param('workspaceId') workspaceId: string,
    @CurrentReader() reader: RepoReader,
    @Query('id') id?: string,
    @Query('direction') direction?: string,
    @Query('edgeTypes') edgeTypes?: string,
    @Query('depth') depth?: string,
    @Query('limit') limit?: string,
  ) {
    return this.graphService.subgraph(workspaceId, reader, id ?? '', { direction, edgeTypes, depth, limit });
  }

  /**
   * Candidate dead code — unreferenced functions/classes (roots excluded). The
   * response carries `lowCoverageRepos` so the UI can flag "suspect" results.
   */
  @Get('dead-code')
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.GraphRead)
  async deadCode(
    @Param('workspaceId') workspaceId: string,
    @CurrentReader() reader: RepoReader,
    @Query('types') types?: string,
    @Query('scopeRepo') scopeRepo?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.graphService.deadCode(workspaceId, reader, { types, scopeRepo, limit, cursor });
  }

  /**
   * Cross-repo bridges (external-call → entrypoint links that cross a repo
   * boundary), as viz nodes+edges. Workspace-wide; `scopeRepo` filters to
   * bridges touching that repo rather than narrowing the DB scope.
   */
  @Get('cross-repo')
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.GraphRead)
  async crossRepo(
    @Param('workspaceId') workspaceId: string,
    @CurrentReader() reader: RepoReader,
    @Query('scopeRepo') scopeRepo?: string,
    @Query('limit') limit?: string,
  ) {
    return this.graphService.crossRepo(workspaceId, reader, { scopeRepo, limit });
  }

  @Get('repos')
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.GraphRead)
  async repos(@Param('workspaceId') workspaceId: string, @CurrentReader() reader: RepoReader) {
    return this.graphService.listRepos(workspaceId, reader);
  }

  @Get('nodes')
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.GraphRead)
  async nodes(
    @Param('workspaceId') workspaceId: string,
    @CurrentReader() reader: RepoReader,
    @Query('type') type?: string,
    @Query('scopeRepo') scopeRepo?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.graphService.nodesByType(workspaceId, reader, { type, scopeRepo, limit, cursor });
  }

  @Get('capabilities')
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.GraphRead)
  async capabilities(@Param('workspaceId') workspaceId: string, @CurrentReader() reader: RepoReader) {
    return this.graphService.capabilities(workspaceId, reader);
  }

  /**
   * The induced subgraph over the explorer canvas's node set. POST because the
   * ids ride in the body: they embed `/` and `:` and a full canvas sends
   * thousands of them, which no URL would carry. The service validates the id
   * set, caps its size, and clamps the edge limit.
   */
  @Post('edges-among')
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.GraphRead)
  async edgesAmong(
    @Param('workspaceId') workspaceId: string,
    @CurrentReader() reader: RepoReader,
    @Body() body: EdgesAmongBody | undefined,
  ) {
    return this.graphService.edgesAmong(workspaceId, reader, body ?? {});
  }

  /**
   * Read-only Cypher passthrough (offered per workspace: a per-workspace
   * Ladybug file always, a shared Neo4j deployment only with the operator
   * opt-in). POST because the query rides in the body; the service enforces
   * that same per-workspace capability gate,
   * read-only validation, cap, and timeout. `GraphRateLimitGuard` (controller
   * level) throttles this browser-reachable surface like every other route.
   */
  @Post('cypher')
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.GraphRead)
  async cypher(
    @Param('workspaceId') workspaceId: string,
    @CurrentReader() reader: RepoReader,
    @Body() body: { query?: unknown; limit?: unknown } | undefined,
  ) {
    return this.graphService.runCypher(workspaceId, reader, body ?? {});
  }
}
