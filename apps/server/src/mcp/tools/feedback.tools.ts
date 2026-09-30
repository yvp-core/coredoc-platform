import { Injectable } from '@nestjs/common';
import { toolAnnotations } from '@coredoc/mcp';
import { Tool } from '@rekog/mcp-nest';
import type { Context } from '@rekog/mcp-nest';
import type { Request } from 'express';
import { z } from 'zod';
import { FeedbackService } from '../../modules/feedback/feedback.service.js';
import {
  type FeedbackToolIssue,
  type IssueType,
  type MissingCapability,
  type MisleadingMetadata,
  REVIEW_STATUSES,
  type ReviewStatus,
  SESSION_ISSUE_AREAS,
  SESSION_ISSUE_TYPES,
  type SessionIssue,
  type SessionIssueArea,
  type SessionIssueType,
} from '../../modules/feedback/feedback.types.js';

const ISSUE_TYPES: IssueType[] = ['noise', 'incomplete', 'wrong', 'misleading_description', 'slow'];
const SESSION_AREAS: readonly string[] = SESSION_ISSUE_AREAS;
const SESSION_TYPES: readonly string[] = SESSION_ISSUE_TYPES;
const REVIEWS: readonly string[] = REVIEW_STATUSES;

// The workflow run identifier minted by the coredoc-workflows plugin. Kept in
// sync with RUN_ID_RE in the OSS coredoc-workflows repo (scripts/workflow-events.mjs).
const RUN_ID_RE = /^cdr-\d{8}-[0-9a-f]{6}$/;

const SUBMIT_FEEDBACK_SCHEMA = z.object({
  overallRating: z
    .number()
    .int()
    .min(1)
    .max(5)
    .optional()
    .describe('Your own (agent) rating of the session, 1 (poor) to 5 (excellent), optional'),
  sessionId: z.string().optional().describe('Claude Code session id, if known (enables correlation)'),
  runId: z
    .string()
    .regex(RUN_ID_RE)
    .optional()
    .describe('coredoc workflow run id (cdr-YYYYMMDD-xxxxxx), if a workflow run produced this feedback'),
  repoKey: z.string().optional().describe('repo the work was in, if applicable'),
  perToolIssues: z
    .array(
      z.object({
        tool: z.string(),
        issueType: z.enum(ISSUE_TYPES as [IssueType, ...IssueType[]]),
        severity: z.number().describe('1 (minor) to 5 (blocking)'),
        description: z.string(),
        exampleQuery: z.string().optional().describe('short, redacted example — no secrets/paths'),
      }),
    )
    .max(50)
    .optional(),
  missingCapabilities: z
    .array(z.object({ need: z.string(), useCase: z.string().optional() }))
    .max(50)
    .optional(),
  misleadingMetadata: z
    .array(z.object({ toolOrAttr: z.string(), why: z.string() }))
    .max(50)
    .optional(),
  sessionIssues: z
    .array(
      z.object({
        area: z
          .enum(SESSION_ISSUE_AREAS)
          .describe(
            'workflow-routing (wrong/confusing route or stage gate), skill-instructions (a plugin skill was unclear, contradictory, or missing a step), task-context (the task lacked details you needed), mcp-transport (auth, timeouts, tool missing), agent-behavior (you hallucinated, over/under-scoped, or missed something), host-environment (permissions, sandbox, missing binary), capture (telemetry/relay), other',
          ),
        issueType: z.enum(SESSION_ISSUE_TYPES),
        severity: z.number().describe('1 (minor) to 5 (blocking)'),
        description: z
          .string()
          .describe('What was expected vs what happened, redacted — no source, diffs, prompts, commands, or paths'),
        skill: z.string().optional().describe('plugin skill involved, e.g. coredoc-implement'),
        stageId: z.string().optional().describe('workflow stage id, when the issue belongs to one stage'),
        exampleRedacted: z.string().optional().describe('short redacted example — no secrets/paths'),
      }),
    )
    .max(50)
    .optional()
    .describe('Problems with the session that are not about one MCP tool result'),
  summary: z.string().max(2000).optional().describe('One short redacted narrative of how the session went'),
  userRating: z
    .number()
    .int()
    .min(1)
    .max(5)
    .optional()
    .describe("The user's rating, only when the user gave one while reviewing your draft"),
  userNotes: z
    .string()
    .max(2000)
    .optional()
    .describe("The user's own words from reviewing your draft, verbatim — what you missed or what was lacking"),
  reviewStatus: z
    .enum(REVIEW_STATUSES)
    .optional()
    .describe(
      'unreviewed (default: nobody saw the draft), confirmed (user accepted it as-is), amended (user added a rating and/or notes)',
    ),
});

/** Mirrors the `.max(50)` on every list in SUBMIT_FEEDBACK_SCHEMA. */
const MAX_LIST_ITEMS = 50;

// Throw rather than truncate: the zod schema already refuses an over-long list,
// and a silently trimmed one would record a partial report as if it were whole.
function asArray(v: unknown, field?: string): unknown[] {
  if (!Array.isArray(v)) return [];
  if (field && v.length > MAX_LIST_ITEMS) {
    throw new Error(`${field} must have at most ${MAX_LIST_ITEMS} items`);
  }
  return v;
}

// Fail closed rather than dropping a malformed id: a silently discarded runId
// looks identical to feedback from a session that never ran a workflow, and the
// whole point of the field is joining this record to that run's metrics.
function parseRunId(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string' || !RUN_ID_RE.test(raw)) {
    throw new Error('runId must be a coredoc workflow run id of the form cdr-YYYYMMDD-xxxxxx');
  }
  return raw;
}

function parseIssues(raw: unknown): FeedbackToolIssue[] {
  return asArray(raw, 'perToolIssues').map((r, idx) => {
    const o = r as Record<string, unknown>;
    const issueType = String(o.issueType) as IssueType;
    if (!ISSUE_TYPES.includes(issueType)) {
      throw new Error(`perToolIssues[${idx}].issueType must be one of ${ISSUE_TYPES.join(', ')}`);
    }
    if (typeof o.tool !== 'string' || typeof o.description !== 'string') {
      throw new Error(`perToolIssues[${idx}] requires string 'tool' and 'description'`);
    }
    const severity = Number(o.severity);
    return {
      tool: o.tool.slice(0, 128),
      issueType,
      severity: Number.isFinite(severity) ? Math.min(5, Math.max(1, severity)) : 3,
      description: o.description.slice(0, 2000),
      exampleQuery: typeof o.exampleQuery === 'string' ? o.exampleQuery.slice(0, 500) : undefined,
    };
  });
}

function parseSessionIssues(raw: unknown): SessionIssue[] {
  return asArray(raw, 'sessionIssues').map((r, idx) => {
    const o = r as Record<string, unknown>;
    const area = String(o.area);
    if (!SESSION_AREAS.includes(area)) {
      throw new Error(`sessionIssues[${idx}].area must be one of ${SESSION_AREAS.join(', ')}`);
    }
    const issueType = String(o.issueType);
    if (!SESSION_TYPES.includes(issueType)) {
      throw new Error(`sessionIssues[${idx}].issueType must be one of ${SESSION_TYPES.join(', ')}`);
    }
    if (typeof o.description !== 'string') {
      throw new Error(`sessionIssues[${idx}] requires a string 'description'`);
    }
    const severity = Number(o.severity);
    return {
      area: area as SessionIssueArea,
      issueType: issueType as SessionIssueType,
      severity: Number.isFinite(severity) ? Math.min(5, Math.max(1, severity)) : 3,
      description: o.description.slice(0, 2000),
      skill: typeof o.skill === 'string' ? o.skill.slice(0, 128) : undefined,
      stageId: typeof o.stageId === 'string' ? o.stageId.slice(0, 128) : undefined,
      exampleRedacted: typeof o.exampleRedacted === 'string' ? o.exampleRedacted.slice(0, 500) : undefined,
    };
  });
}

function parseRating(raw: unknown): number | null {
  // Round + clamp: the column is Int — a fractional rating must not become a Prisma runtime error.
  return typeof raw === 'number' ? Math.round(Math.min(5, Math.max(1, raw))) : null;
}

function parseText(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed.slice(0, max) : null;
}

// The review status is the one field that says whether a human stood behind
// the record, so it must agree with the user fields rather than be inferred
// from them: a rating with `unreviewed` or an `amended` with nothing amended
// is a caller bug, and recording either would corrupt the self-assessment gap.
function parseReview(raw: unknown, userRating: number | null, userNotes: string | null): ReviewStatus {
  const status = raw === undefined || raw === null ? 'unreviewed' : String(raw);
  if (!REVIEWS.includes(status)) {
    throw new Error(`reviewStatus must be one of ${REVIEWS.join(', ')}`);
  }
  const hasUserInput = userRating !== null || userNotes !== null;
  if (status === 'unreviewed' && hasUserInput) {
    throw new Error('reviewStatus must be confirmed or amended when userRating or userNotes is present');
  }
  if (status === 'amended' && !hasUserInput) {
    throw new Error('reviewStatus amended requires userRating or userNotes');
  }
  if (status === 'confirmed' && hasUserInput) {
    throw new Error(
      'reviewStatus confirmed means accepted as-is — use amended when userRating or userNotes is present',
    );
  }
  return status as ReviewStatus;
}

@Injectable()
export class SessionFeedbackTools {
  constructor(private readonly feedback: FeedbackService) {}

  @Tool({
    name: 'submit_session_feedback',
    annotations: toolAnnotations('submit_session_feedback'),
    description:
      'Submit structured feedback about this session: how the coredoc MCP tools behaved (noisy / incomplete / wrong / misleading descriptions / slow, plus tools you needed), and everything else that went wrong or was missing — workflow routing, plugin skill instructions, missing task details, transport/auth, host environment, and your own mistakes such as hallucinated or missed facts (sessionIssues). Draft it first, show the draft to the user, and ask whether to submit as-is, add corrections, or skip; record their answer in reviewStatus, userRating, and userNotes. Call once at the end of a task, or when asked via /coredoc:feedback. Collect observations while working and draft once at final delivery, not after individual tool calls; a non-interactive session submits as unreviewed. When a coredoc workflow run just finished and reported feedbackOwed, pass its runId so this record joins that run.',
    parameters: SUBMIT_FEEDBACK_SCHEMA,
  })
  async submitSessionFeedback(args: Record<string, unknown>, _context: Context, request: Request) {
    const workspaceId = (request as unknown as Record<string, unknown>).workspaceId as string | undefined;
    const user = (request as unknown as Record<string, unknown>).user as { id?: string; email?: string } | undefined;
    if (!workspaceId) throw new Error('Missing workspace context — cannot record feedback');

    const perToolIssues = parseIssues(args.perToolIssues);
    const missingCapabilities: MissingCapability[] = asArray(args.missingCapabilities)
      .map((r) => r as Record<string, unknown>)
      .filter((o) => typeof o.need === 'string')
      .map((o) => ({
        need: String(o.need).slice(0, 256),
        useCase: typeof o.useCase === 'string' ? String(o.useCase).slice(0, 500) : undefined,
      }));
    const misleadingMetadata: MisleadingMetadata[] = asArray(args.misleadingMetadata)
      .map((r) => r as Record<string, unknown>)
      .filter((o) => typeof o.toolOrAttr === 'string' && typeof o.why === 'string')
      .map((o) => ({ toolOrAttr: String(o.toolOrAttr).slice(0, 128), why: String(o.why).slice(0, 1000) }));

    const sessionIssues = parseSessionIssues(args.sessionIssues);
    const overallRating = parseRating(args.overallRating);
    const userRating = parseRating(args.userRating);
    const userNotes = parseText(args.userNotes, 2000);
    const reviewStatus = parseReview(args.reviewStatus, userRating, userNotes);

    const { id } = await this.feedback.submitFeedback({
      workspaceId,
      userId: user?.id ?? null,
      userEmail: user?.email ?? null,
      sessionId: typeof args.sessionId === 'string' ? args.sessionId.slice(0, 128) : null,
      runId: parseRunId(args.runId),
      repoKey: typeof args.repoKey === 'string' ? args.repoKey.slice(0, 256) : null,
      overallRating,
      perToolIssues,
      missingCapabilities,
      misleadingMetadata,
      sessionIssues,
      summary: parseText(args.summary, 2000),
      userRating,
      userNotes,
      reviewStatus,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: `Thanks — coredoc feedback recorded (${id}, ${reviewStatus}): ${perToolIssues.length} tool issue(s), ${sessionIssues.length} session issue(s), ${missingCapabilities.length} missing-capability request(s).`,
        },
      ],
    };
  }
}
