import { BadRequestException, Controller, ForbiddenException, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../../auth/auth.guard.js';
import { WorkspaceRoleGuard } from '../../auth/workspace-role.guard.js';
import { PermissionsGuard } from '../../auth/permissions.guard.js';
import { WorkspaceRole } from '../../auth/decorators/workspace-role.decorator.js';
import { RequirePermission } from '../../auth/decorators/require-permission.decorator.js';
import { TokenPermission } from '../../auth/token-permissions.js';
import { CurrentUser, type AuthUser } from '../../auth/decorators/current-user.decorator.js';
import { WorkspaceRoleValue } from '../../auth/decorators/workspace-role-value.decorator.js';
import { isWorkspaceManagerRole, type WorkspaceMemberRole } from '../members/dto/workspace-role.enum.js';
import { selfScopeFor } from '../../auth/self-scope.js';
import { parseCustomWindow } from '../../libs/analytics-window.js';
import { FeedbackService } from './feedback.service.js';
import {
  FeedbackSort,
  SortOrder,
  REVIEW_STATUSES,
  SESSION_ISSUE_AREAS,
  type FeedbackRecordsQuery,
  type ReviewStatus,
  type SessionIssueArea,
} from './feedback.types.js';

function parseDays(v?: string): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= 365 ? Math.floor(n) : 30;
}

const MAX_LIMIT = 100;
const MAX_TOOL_LENGTH = 128;

/**
 * Every query param below is typed `unknown`, not `string | undefined`: Express/qs parses
 * `?sort=a&sort=b` into an array and `?sort[x]=a` into an object, so the declared string type
 * is a lie at the trust boundary. Malformed input 400s instead of being coerced or clamped
 * (the one exception is `limit`, capped at 100).
 */
function optionalString(raw: unknown, name: string): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') throw new BadRequestException(`${name} must be a single string`);
  return raw;
}

function parseEnum<T extends string>(raw: unknown, name: string, allowed: readonly T[]): T | null {
  const value = optionalString(raw, name);
  if (value === undefined) return null;
  if (!allowed.includes(value as T)) throw new BadRequestException(`${name} must be one of ${allowed.join(', ')}`);
  return value as T;
}

function parseInt1(raw: unknown, name: string, fallback: number, min: number, max: number): number {
  const value = optionalString(raw, name);
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new BadRequestException(`${name} must be an integer between ${min} and ${max}`);
  }
  return n;
}

/**
 * Copy of `resolveDeliveryUserId` in ../delivery/canonical-delivery.controller.ts — same rule,
 * second occurrence, not yet worth extracting. `mine=true` is sugar for the caller's own id and
 * is the only form a plain `member` can use for anyone else; another member's id is a 403, not a
 * silently narrowed read.
 */
function resolveFeedbackUserId(
  user: AuthUser,
  role: WorkspaceMemberRole | undefined,
  mine: unknown,
  userId: unknown,
): string | null {
  if (userId !== undefined && typeof userId !== 'string') {
    throw new BadRequestException('userId must be a single string');
  }
  if (mine !== undefined && mine !== 'true' && mine !== 'false') {
    throw new BadRequestException('mine must be true or false');
  }
  const requested = typeof userId === 'string' && userId.length > 0 ? userId : undefined;
  if (requested !== undefined && mine !== undefined) {
    throw new BadRequestException('mine and userId cannot be combined');
  }
  if (mine === 'true') return user.id;
  if (requested === undefined) return null;
  if (role !== undefined && !isWorkspaceManagerRole(role) && requested !== user.id) {
    throw new ForbiddenException('Members may only filter feedback reads by their own id');
  }
  return requested;
}

@Controller('workspaces/:workspaceId/mcp-feedback')
@UseGuards(AuthGuard, WorkspaceRoleGuard, PermissionsGuard)
export class FeedbackController {
  constructor(private readonly feedback: FeedbackService) {}

  @Get('roadmap')
  @WorkspaceRole('member')
  // Service tokens need an explicit read grant — keeps the telemetry:write
  // ingest token write-only; JWT members pass through the permissions guard.
  @RequirePermission(TokenPermission.ResultRead)
  async roadmap(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: AuthUser,
    @WorkspaceRoleValue() role: WorkspaceMemberRole | undefined,
    @Query('days') days?: string,
  ) {
    return this.feedback.getRoadmap(workspaceId, parseDays(days), selfScopeFor(user, role));
  }

  @Get('records')
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.ResultRead)
  async records(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: AuthUser,
    @WorkspaceRoleValue() role: WorkspaceMemberRole | undefined,
    @Query() q: Record<string, unknown>,
  ) {
    // `since`/`until` win over `days` when present; malformed ranges 400 instead of clamping.
    const custom = parseCustomWindow(q.since, q.until);
    const days = custom ? custom.days : parseDays(optionalString(q.days, 'days'));
    const tool = optionalString(q.tool, 'tool') ?? null;
    if (tool !== null && tool.length > MAX_TOOL_LENGTH) {
      throw new BadRequestException(`tool must be at most ${MAX_TOOL_LENGTH} characters`);
    }
    const now = new Date();
    const query: FeedbackRecordsQuery = {
      days,
      since: custom ? custom.since : new Date(now.getTime() - days * 86_400_000),
      untilExclusive: custom ? custom.untilExclusive : now,
      page: parseInt1(q.page, 'page', 1, 1, Number.MAX_SAFE_INTEGER),
      limit: Math.min(parseInt1(q.limit, 'limit', 25, 1, Number.MAX_SAFE_INTEGER), MAX_LIMIT),
      sort: parseEnum(q.sort, 'sort', Object.values(FeedbackSort)) ?? FeedbackSort.CreatedAt,
      order: parseEnum(q.order, 'order', Object.values(SortOrder)) ?? SortOrder.Desc,
      reviewStatus: parseEnum<ReviewStatus>(q.reviewStatus, 'reviewStatus', REVIEW_STATUSES),
      // `area` matches the session issues' area; `mcp-transport` additionally matches any
      // record reporting tool issues, so pre-session-feedback records stay reachable there.
      area: parseEnum<SessionIssueArea>(q.area, 'area', SESSION_ISSUE_AREAS),
      tool,
      maxRating: q.maxRating === undefined ? null : parseInt1(q.maxRating, 'maxRating', 5, 1, 5),
      userId: resolveFeedbackUserId(user, role, q.mine, q.userId),
    };
    return this.feedback.listRecords(workspaceId, query, selfScopeFor(user, role));
  }

  @Get('correlation')
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.ResultRead)
  async correlation(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: AuthUser,
    @WorkspaceRoleValue() role: WorkspaceMemberRole | undefined,
    @Query('days') days?: string,
  ) {
    return this.feedback.getSessionCorrelation(workspaceId, parseDays(days), selfScopeFor(user, role));
  }
}
