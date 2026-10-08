/**
 * AskUserQuestion bridged to Coredoc questions. The server decides by the
 * run's policy: under pause the call is deferred, so the session ends with the
 * question parked and the resume turn re-runs the call with a person's
 * answers; under assume the server's answer goes back at once. Only the main
 * session asks. Nothing here ever lets a question through without answers.
 */
import type { CanUseTool, HookJSONOutput, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { ReportQuestionRequestSchema, type TurnAssignment } from '@coredoc/core/agent-runner';
import type { TurnIO } from '../runner.js';

export const ASK_USER_QUESTION = 'AskUserQuestion';

/** Tools that ask a person; a subagent never reaches one. */
const PERSON_TOOLS: ReadonlySet<string> = new Set([ASK_USER_QUESTION, 'ExitPlanMode']);

export const RETURN_TO_MAIN_SESSION =
  'Subagents do not ask people: return this question to the main session, which asks it through AskUserQuestion.';

const NOT_DELIVERED =
  'This question was not delivered to anyone, so it has no answer. Ask it again through AskUserQuestion from the main session.';

const QUESTION_SHAPE =
  'AskUserQuestion takes one to four questions, each with a question, a short header and two to four options with a label and a description.';

/** What the turn's questions achieved; the end-of-turn classification reads it. */
export interface QuestionState {
  /** The request id of the question this turn parked for a person (pause policy). */
  parkedQuestion: string | null;
}

type Decision = Exclude<HookJSONOutput, { async: true }>;

const decide = (
  permissionDecision: 'allow' | 'deny' | 'defer',
  extra: { reason?: string; updatedInput?: Record<string, unknown> } = {},
): Decision => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision,
    ...(extra.reason ? { permissionDecisionReason: extra.reason } : {}),
    ...(extra.updatedInput ? { updatedInput: extra.updatedInput } : {}),
  },
});

function hasAnswers(input: Record<string, unknown>): boolean {
  const answers = input.answers;
  return typeof answers === 'object' && answers !== null && Object.keys(answers).length > 0;
}

function askedTexts(input: Record<string, unknown>): string[] {
  return Array.isArray(input.questions)
    ? input.questions.map((question) => (question as { question?: unknown }).question).map(String)
    : [];
}

export class QuestionBridge {
  readonly state: QuestionState = { parkedQuestion: null };
  private answerDelivered = false;

  constructor(
    private readonly turn: TurnAssignment,
    private readonly io: Pick<TurnIO, 'reportQuestion'>,
  ) {}

  /** The pre-tool hook's part: null when the call is not this bridge's to decide. */
  async preToolUse(input: PreToolUseHookInput): Promise<Decision | null> {
    if (input.agent_id && PERSON_TOOLS.has(input.tool_name)) {
      return decide('deny', { reason: RETURN_TO_MAIN_SESSION });
    }
    if (input.tool_name !== ASK_USER_QUESTION) return null;
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;

    const answer = this.turn.answer;
    if (answer && !this.answerDelivered && this.isAnsweredCall(input.tool_use_id, toolInput)) {
      this.answerDelivered = true;
      return decide('allow', { updatedInput: { ...toolInput, answers: answer.answers } });
    }

    const questions = ReportQuestionRequestSchema.shape.questions.safeParse(toolInput.questions);
    if (!questions.success) return decide('deny', { reason: QUESTION_SHAPE });
    let reported: Awaited<ReturnType<TurnIO['reportQuestion']>>;
    try {
      reported = await this.io.reportQuestion({ toolUseId: input.tool_use_id, questions: questions.data });
    } catch {
      return decide('deny', { reason: NOT_DELIVERED });
    }
    switch (reported.state) {
      case 'open':
        this.state.parkedQuestion = reported.requestId;
        return decide('defer');
      case 'auto_answered':
        return decide('allow', { updatedInput: { ...toolInput, answers: reported.answers } });
      case 'refused':
        return decide('deny', { reason: reported.reason });
    }
  }

  /**
   * The permission callback's part. AskUserQuestion is offered only when one
   * is set; it reaches the callback only when no hook decided (a hook that
   * timed out or failed), so it is refused unless it already carries answers.
   */
  readonly canUseTool: CanUseTool = async (toolName, input, options) => {
    if (options.agentID && PERSON_TOOLS.has(toolName)) return { behavior: 'deny', message: RETURN_TO_MAIN_SESSION };
    if (toolName === ASK_USER_QUESTION && !hasAnswers(input)) return { behavior: 'deny', message: NOT_DELIVERED };
    return { behavior: 'allow', updatedInput: input };
  };

  /** The resumed session re-runs the deferred call; matched by its id, or by the same questions. */
  private isAnsweredCall(toolUseId: string, input: Record<string, unknown>): boolean {
    const answer = this.turn.answer!;
    if (toolUseId === answer.toolUseId) return true;
    const asked = askedTexts(input);
    const answered = Object.keys(answer.answers);
    return asked.length > 0 && asked.length === answered.length && asked.every((text) => answered.includes(text));
  }
}
