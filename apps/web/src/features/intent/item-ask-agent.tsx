/**
 * "Needs a fix" as a hand-off: the reviewer says what is wrong and gets a
 * prompt to give an agent connected to the workspace MCP. The agent proposes
 * a corrected successor; a person then approves it here like any candidate.
 * Nothing is stored — no agent reads stored review notes yet.
 */

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { MessageCircleQuestion, PencilLine } from 'lucide-react';
import { useState } from 'react';
import { agentPrompt, isOpenQuestion } from './intent-agent-prompt.js';
import type { IntentContextMatch } from './types.js';

export function IntentItemAskAgent({ match }: { match: IntentContextMatch }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [copied, setCopied] = useState(false);
  const question = isOpenQuestion(match);

  if (!open)
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mx-[18px] mt-3 flex w-[calc(100%-36px)] items-center gap-3 rounded-lg border border-rework/40 bg-rework-wash px-3 py-2.5 text-left transition-colors hover:border-rework"
      >
        {question ? (
          <MessageCircleQuestion aria-hidden="true" className="size-4 shrink-0 text-rework-text" />
        ) : (
          <PencilLine aria-hidden="true" className="size-4 shrink-0 text-rework-text" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] font-medium text-ink-1">
            {question ? 'Answer with an agent' : 'Needs a fix'}
          </span>
          <span className="block text-[12.5px] text-ink-3">
            {question
              ? 'Write the answer; get a prompt that records it as a decision.'
              : 'Say what is wrong; get a prompt for an agent to propose the fix.'}
          </span>
        </span>
        <span aria-hidden="true" className="text-ink-4">
          ›
        </span>
      </button>
    );

  const prompt = note.trim() === '' ? '' : agentPrompt(match, note);
  return (
    <div className="mx-[18px] mt-3 flex flex-col gap-2 rounded-lg bg-rework-wash px-3 py-2.5">
      <span className="text-[13px] font-medium text-ink-1">
        {question ? 'Answer this question' : 'What should change?'}
      </span>
      <Textarea
        aria-label={question ? 'Answer' : 'What should change'}
        placeholder={
          question ? 'The answer, or what the agent should find out' : 'What is wrong and what it should say'
        }
        maxLength={2000}
        value={note}
        onChange={(event) => {
          setNote(event.target.value);
          setCopied(false);
        }}
        className="min-h-[60px] bg-surface text-[13.5px]"
      />
      {prompt && (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-surface px-2 py-1.5 font-mono text-[12px] text-ink-2">
          {prompt}
        </pre>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          variant="default"
          size="sm"
          disabled={prompt === ''}
          onClick={() =>
            void navigator.clipboard.writeText(prompt).then(
              () => setCopied(true),
              () => setCopied(false),
            )
          }
        >
          {copied ? 'Copied' : 'Copy prompt for the agent'}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      <p className="text-[12.5px] text-ink-3">
        Paste it into Claude Code (or any agent with the workspace MCP). Its proposal appears here as a change to
        approve.
      </p>
    </div>
  );
}
