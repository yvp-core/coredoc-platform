import { Card, CardBody, CardHead } from '@/components/ui/card';
import { IntentMarkdown } from '@/features/intent/intent-markdown';

import type { AgentRunDetail } from './types';

/**
 * The run's repositories once implementation started: what was pushed to the
 * run branch, what could not be built or tested in the runner, and which
 * edits were withheld from the push (by path only).
 */
export function RunRepositories({ run }: { run: AgentRunDetail }) {
  const implemented = run.phase !== 'scope' && run.repositories.length > 0;
  if (!implemented && !run.result) return null;
  const ordered = [...run.repositories].sort((a, b) => a.mergeOrder - b.mergeOrder);
  return (
    <Card role="region" aria-label="Repositories">
      <CardHead title="Repositories" sub={`Work is pushed to ${run.branch}`} />
      <CardBody className="flex flex-col gap-3">
        {run.result && <IntentMarkdown noRemote text={run.result.summary} className="text-[13.5px] text-ink-2" />}
        <div className="overflow-x-auto">
          <table className="min-w-full border-collapse text-[13px]">
            <thead>
              <tr className="text-left text-ink-4">
                <th className="py-1 pr-3 font-medium">Repository</th>
                <th className="py-1 pr-3 font-medium">Pushed head</th>
                <th className="py-1 pr-3 font-medium">Build and tests</th>
                <th className="py-1 font-medium">Withheld from the push</th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((repository) => (
                <tr key={repository.key} className="border-t border-border-soft align-top">
                  <td className="py-1.5 pr-3 font-mono text-[12.5px]">{repository.key}</td>
                  <td className="py-1.5 pr-3 font-mono text-[12.5px]">
                    {repository.touched && repository.lastPushedHead ? (
                      <span title={repository.lastPushedHead}>{repository.lastPushedHead.slice(0, 7)}</span>
                    ) : (
                      <span className="font-sans text-ink-4">Not pushed</span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3">
                    {repository.notBuiltOrTested ? (
                      <span className="text-warn-text">
                        Not built or tested in the runner:{' '}
                        <IntentMarkdown inline noRemote text={repository.notBuiltOrTested} />
                      </span>
                    ) : repository.touched ? (
                      'Built and tested in the runner'
                    ) : (
                      <span className="text-ink-4">-</span>
                    )}
                  </td>
                  <td className="py-1.5 font-mono text-[12.5px]">
                    {repository.withheldPaths?.length ? (
                      repository.withheldPaths.join(', ')
                    ) : (
                      <span className="font-sans text-ink-4">-</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardBody>
    </Card>
  );
}
