import { Check, TriangleAlert } from 'lucide-react';
import { useId } from 'react';

import type { ConsultantQuestionRecord } from '@/api/queries/consultant-runs';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHead } from '@/components/ui/card';
import type { AskedQuestion, QuestionAnswer } from '@/features/agent-runs/types';
import { IntentMarkdown } from '@/features/intent/intent-markdown';
import { formatRelativeTime } from '@/lib/time';

export function When({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()}>
      {formatRelativeTime(iso)}
    </time>
  );
}

const TITLE: Record<ConsultantQuestionRecord['state'], string> = {
  open: 'Waiting for an answer',
  answered: 'Answered',
  cancelled: 'Closed without an answer',
};

function QuestionBlock({ question, answer }: { question: AskedQuestion; answer: QuestionAnswer | undefined }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-[13.5px] text-ink-1">
        <Badge variant="neutral">{question.header}</Badge>
        <IntentMarkdown inline noRemote text={question.question} />
        {question.multiSelect && <span className="text-[12px] text-ink-4">Any number can be chosen</span>}
      </div>
      <ul aria-label={`Options: ${question.header}`} className="flex flex-col gap-2">
        {question.options.map((option) => {
          const chosen = answer?.labels.includes(option.label) ?? false;
          return (
            <li
              key={option.label}
              className={`grid grid-cols-[16px_minmax(0,1fr)] gap-2 rounded-lg border px-3 py-2 text-[13.5px] ${
                chosen ? 'border-brand bg-brand-wash' : 'border-border-soft'
              }`}
            >
              <span className="pt-0.5">
                {chosen && <Check className="size-4 text-brand-text" aria-hidden="true" />}
              </span>
              <span className="flex min-w-0 flex-col gap-1">
                <span className="flex flex-wrap items-center gap-2 text-ink-1">
                  {option.label}
                  {chosen && <Badge variant="ok">Chosen</Badge>}
                </span>
                <span className="text-ink-3">{option.description}</span>
                {option.preview && (
                  // Agent-written, so shown as text; whitespace-pre keeps aligned columns, scrolling sideways in the box.
                  <section
                    // biome-ignore lint/a11y/noNoninteractiveTabindex: the keyboard needs focus to scroll the preview.
                    tabIndex={0}
                    aria-label={`Example for ${option.label}`}
                    className="overflow-x-auto rounded-md bg-surface-2"
                  >
                    <pre className="whitespace-pre p-2 font-mono text-[12px] text-ink-2">{option.preview}</pre>
                  </section>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      {answer?.other && (
        <p className="pl-[42px] text-[13.5px]">
          <span className="text-ink-3">Own answer: </span>
          <span className="text-ink-1">{answer.other}</span>
        </p>
      )}
    </div>
  );
}

export function QuestionRecord({ record }: { record: ConsultantQuestionRecord }) {
  const titleId = useId();
  return (
    <Card>
      <article id={`q-${record.requestId}`} aria-labelledby={titleId}>
        <CardHead
          title={<span id={titleId}>{TITLE[record.state]}</span>}
          sub={
            record.state === 'answered' && record.answeredAt ? (
              <>
                Asked <When iso={record.askedAt} /> · answered <When iso={record.answeredAt} />
              </>
            ) : (
              <>
                Asked <When iso={record.askedAt} />
              </>
            )
          }
          right={
            record.state === 'open' ? (
              <Badge variant="warn">Open</Badge>
            ) : record.state === 'cancelled' ? (
              <Badge variant="err">
                <TriangleAlert className="size-3" aria-hidden="true" />
                Left undecided
              </Badge>
            ) : null
          }
        />
        <CardBody className="flex flex-col gap-4">
          {record.questions.map((question, index) => (
            <QuestionBlock key={question.question} question={question} answer={record.answers?.[index]} />
          ))}
        </CardBody>
      </article>
    </Card>
  );
}
