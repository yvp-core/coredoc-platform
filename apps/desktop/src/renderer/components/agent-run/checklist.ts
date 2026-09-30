import { AgentTodoStatus, type AgentTodoItem } from '../../../shared/agent-run-types';

/**
 * The five canonical authoring phases. These MUST match the phase strings the generate prompt
 * tells the agent to use for its TodoWrite items (command-runner.ts buildAuthorProfilePrompt).
 * The checklist is seeded from these so it shows the plan even before the first TodoWrite, and
 * degrades gracefully if the agent renames or skips a phase.
 */
export const AUTHORING_PHASES = [
  'Ground in repo shape',
  'Scout conventions',
  'Draft profile',
  'Score & iterate',
  'Finalize profile',
];

export interface ChecklistRow {
  text: string;
  status: AgentTodoStatus;
  kind: 'phase' | 'subtask';
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Fuzzy match: exact, or one string contains the other with the shorter being non-trivial. */
function matches(todoNorm: string, phaseNorm: string): boolean {
  if (!todoNorm) return false;
  if (todoNorm === phaseNorm) return true;
  const [short, long] = todoNorm.length <= phaseNorm.length ? [todoNorm, phaseNorm] : [phaseNorm, todoNorm];
  return short.length >= 5 && long.includes(short);
}

/**
 * Merge the agent's live todos onto the seeded five-phase checklist. Unmatched todos (the agent's
 * own sub-tasks) are inserted as indented rows under the current in-progress phase.
 */
export function buildChecklist(todos: AgentTodoItem[]): ChecklistRow[] {
  const normalized = todos.map((t) => ({ ...t, norm: normalize(t.text) }));
  const matched = new Set<number>();

  const phaseRows: ChecklistRow[] = AUTHORING_PHASES.map((phase) => {
    const phaseNorm = normalize(phase);
    const idx = normalized.findIndex((t, i) => !matched.has(i) && matches(t.norm, phaseNorm));
    if (idx >= 0) {
      matched.add(idx);
      return { text: phase, status: normalized[idx].status, kind: 'phase' };
    }
    return { text: phase, status: AgentTodoStatus.Pending, kind: 'phase' };
  });

  const subtasks: ChecklistRow[] = normalized
    .filter((_, i) => !matched.has(i))
    .map((t) => ({ text: t.text, status: t.status, kind: 'subtask' }));

  if (subtasks.length === 0) return phaseRows;

  const anchor = phaseRows.findIndex((r) => r.status === AgentTodoStatus.InProgress);
  const insertAt = anchor >= 0 ? anchor + 1 : phaseRows.length;
  return [...phaseRows.slice(0, insertAt), ...subtasks, ...phaseRows.slice(insertAt)];
}

/** Label for the spinner: the active phase, or a sensible start/finish fallback. */
export function currentActivityLabel(rows: ChecklistRow[]): string {
  const active = rows.find((r) => r.status === AgentTodoStatus.InProgress);
  if (active) return active.text;
  const anyStarted = rows.some((r) => r.status === AgentTodoStatus.Completed);
  return anyStarted ? 'Wrapping up…' : 'Starting authoring agent…';
}
