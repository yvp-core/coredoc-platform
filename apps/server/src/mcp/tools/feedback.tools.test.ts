import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionFeedbackTools } from './feedback.tools.js';
import type { FeedbackService } from '../../modules/feedback/feedback.service.js';

function mockService() {
  return { submitFeedback: vi.fn().mockResolvedValue({ id: 'fb-1' }) };
}
function req(over: Record<string, unknown> = {}) {
  return { workspaceId: 'ws-1', user: { id: 'u1', email: 'u1@acme.com' }, ...over } as any;
}

describe('SessionFeedbackTools.submitSessionFeedback', () => {
  let svc: ReturnType<typeof mockService>;
  let tools: SessionFeedbackTools;
  beforeEach(() => {
    svc = mockService();
    tools = new SessionFeedbackTools(svc as unknown as FeedbackService);
  });

  it('validates + forwards a well-formed payload with workspace/user from the request', async () => {
    const args = {
      overallRating: 4,
      perToolIssues: [{ tool: 'search_symbols', issueType: 'noise', severity: 3, description: 'too many hits' }],
      missingCapabilities: [{ need: 'find_tests_for_symbol' }],
      misleadingMetadata: [],
      sessionId: 'sess-9',
      repoKey: 'acme/api',
    };
    const res = await tools.submitSessionFeedback(args, {} as any, req());
    expect(res.content[0].text).toMatch(/thank|recorded|fb-1/i);
    const input = svc.submitFeedback.mock.calls[0][0];
    expect(input.workspaceId).toBe('ws-1');
    expect(input.userId).toBe('u1');
    expect(input.sessionId).toBe('sess-9');
    expect(input.perToolIssues[0].tool).toBe('search_symbols');
  });

  it('throws when workspace context is missing (no silent drop)', async () => {
    await expect(
      tools.submitSessionFeedback({ perToolIssues: [] }, {} as any, req({ workspaceId: undefined })),
    ).rejects.toThrow(/workspace/i);
  });

  it('forwards a workflow runId and defaults it to null when absent', async () => {
    await tools.submitSessionFeedback({ perToolIssues: [], runId: 'cdr-20260731-a1b2c3' }, {} as any, req());
    expect(svc.submitFeedback.mock.calls[0][0].runId).toBe('cdr-20260731-a1b2c3');

    await tools.submitSessionFeedback({ perToolIssues: [] }, {} as any, req());
    expect(svc.submitFeedback.mock.calls[1][0].runId).toBeNull();
  });

  // A dropped runId is indistinguishable from feedback that never had a run,
  // which is exactly the correlation the field exists to carry.
  it('rejects a malformed runId instead of recording feedback without the join', async () => {
    for (const runId of ['cdr-2026-07-31-a1b2c3', 'run-1', 'cdr-20260731-A1B2C3', 42]) {
      await expect(tools.submitSessionFeedback({ perToolIssues: [], runId }, {} as any, req())).rejects.toThrow(
        /runId/i,
      );
    }
    expect(svc.submitFeedback).not.toHaveBeenCalled();
  });

  it('rejects an invalid issueType', async () => {
    const args = { perToolIssues: [{ tool: 'x', issueType: 'bogus', severity: 3, description: 'd' }] };
    await expect(tools.submitSessionFeedback(args, {} as any, req())).rejects.toThrow(/issueType/i);
  });

  it('forwards session issues, summary, and the user review, clamping and truncating', async () => {
    const args = {
      overallRating: 5,
      sessionIssues: [
        {
          area: 'skill-instructions',
          issueType: 'confusing',
          severity: 9,
          description: 'x'.repeat(3000),
          skill: 'coredoc-implement',
          stageId: 'implement',
        },
      ],
      summary: 'went fine except the gate',
      userRating: 2.6,
      userNotes: 'You never ran the migration check.',
      reviewStatus: 'amended',
    };
    const res = await tools.submitSessionFeedback(args, {} as any, req());
    expect(res.content[0].text).toMatch(/amended/);
    expect(res.content[0].text).toMatch(/1 session issue/);
    const input = svc.submitFeedback.mock.calls[0][0];
    expect(input.sessionIssues).toEqual([
      {
        area: 'skill-instructions',
        issueType: 'confusing',
        severity: 5,
        description: 'x'.repeat(2000),
        skill: 'coredoc-implement',
        stageId: 'implement',
        exampleRedacted: undefined,
      },
    ]);
    expect(input.summary).toBe('went fine except the gate');
    expect(input.overallRating).toBe(5);
    expect(input.userRating).toBe(3);
    expect(input.userNotes).toBe('You never ran the migration check.');
    expect(input.reviewStatus).toBe('amended');
  });

  it('defaults to unreviewed with empty session issues and no user fields', async () => {
    await tools.submitSessionFeedback({ perToolIssues: [] }, {} as any, req());
    const input = svc.submitFeedback.mock.calls[0][0];
    expect(input.sessionIssues).toEqual([]);
    expect(input.summary).toBeNull();
    expect(input.userRating).toBeNull();
    expect(input.userNotes).toBeNull();
    expect(input.reviewStatus).toBe('unreviewed');
  });

  it('rejects a session issue outside the closed area or type vocabulary', async () => {
    const bad = { area: 'vibes', issueType: 'confusing', severity: 3, description: 'd' };
    await expect(tools.submitSessionFeedback({ sessionIssues: [bad] }, {} as any, req())).rejects.toThrow(/area/i);
    const badType = { area: 'other', issueType: 'noise', severity: 3, description: 'd' };
    await expect(tools.submitSessionFeedback({ sessionIssues: [badType] }, {} as any, req())).rejects.toThrow(
      /issueType/i,
    );
    expect(svc.submitFeedback).not.toHaveBeenCalled();
  });

  // The self-assessment gap is only meaningful when the status says who rated
  // what; a contradictory record is refused rather than guessed at.
  it('refuses a review status that contradicts the user fields', async () => {
    await expect(tools.submitSessionFeedback({ userRating: 4 }, {} as any, req())).rejects.toThrow(/reviewStatus/);
    await expect(
      tools.submitSessionFeedback({ userNotes: 'missed a skill', reviewStatus: 'unreviewed' }, {} as any, req()),
    ).rejects.toThrow(/reviewStatus/);
    await expect(tools.submitSessionFeedback({ reviewStatus: 'amended' }, {} as any, req())).rejects.toThrow(
      /amended requires/,
    );
    await expect(tools.submitSessionFeedback({ reviewStatus: 'later' }, {} as any, req())).rejects.toThrow(
      /reviewStatus must be one of/,
    );
    expect(svc.submitFeedback).not.toHaveBeenCalled();

    await tools.submitSessionFeedback({ reviewStatus: 'confirmed' }, {} as any, req());
    expect(svc.submitFeedback.mock.calls[0][0].reviewStatus).toBe('confirmed');
  });

  // `confirmed` means "accepted as-is": a rating or notes alongside it is an
  // amendment mislabelled, and it would be scored as a zero self-assessment gap.
  it('refuses confirmed carrying user input (that is an amendment)', async () => {
    await expect(
      tools.submitSessionFeedback({ userRating: 2, reviewStatus: 'confirmed' }, {} as any, req()),
    ).rejects.toThrow(/confirmed/);
    await expect(
      tools.submitSessionFeedback({ userNotes: 'you missed a step', reviewStatus: 'confirmed' }, {} as any, req()),
    ).rejects.toThrow(/confirmed/);
    expect(svc.submitFeedback).not.toHaveBeenCalled();
  });

  // The zod schema caps these arrays at 50; a caller reaching the handler
  // another way must hit the same wall instead of writing an unbounded blob.
  it('rejects more than 50 issues or session issues', async () => {
    const issue = { tool: 'x', issueType: 'noise', severity: 3, description: 'd' };
    await expect(
      tools.submitSessionFeedback({ perToolIssues: Array(51).fill(issue) }, {} as any, req()),
    ).rejects.toThrow(/perToolIssues.*50/);
    const sessionIssue = { area: 'other', issueType: 'confusing', severity: 3, description: 'd' };
    await expect(
      tools.submitSessionFeedback({ sessionIssues: Array(51).fill(sessionIssue) }, {} as any, req()),
    ).rejects.toThrow(/sessionIssues.*50/);
    expect(svc.submitFeedback).not.toHaveBeenCalled();

    await tools.submitSessionFeedback({ perToolIssues: Array(50).fill(issue) }, {} as any, req());
    expect(svc.submitFeedback.mock.calls[0][0].perToolIssues).toHaveLength(50);
  });

  it('stores summary and notes trimmed, not just non-blank', async () => {
    await tools.submitSessionFeedback(
      { summary: '  went fine  ', userNotes: '\n missed the migration \n', reviewStatus: 'amended' },
      {} as any,
      req(),
    );
    const input = svc.submitFeedback.mock.calls[0][0];
    expect(input.summary).toBe('went fine');
    expect(input.userNotes).toBe('missed the migration');
  });
});
