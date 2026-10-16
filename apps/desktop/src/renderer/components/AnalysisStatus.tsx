import { Tooltip as TooltipPrimitive } from 'radix-ui';
import { DangerTriangle, InfoCircle } from '@solar-icons/react';
import type { ParseStats } from '../../shared/ipc-types';
import { Button } from './ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

export function AnalysisStatus({ analysis }: { analysis: ParseStats['analysis'] }) {
  if (!analysis?.length) return null;
  const records = analysis.map((record) => ({
    label: `${record.language === 'csharp' ? 'C#' : record.language}${record.target ? ` (${record.target})` : ''} · ${record.mode}${record.fallback ? ' (fallback)' : ''}`,
    detail: record.fallback
      ? 'Enhanced analysis was unavailable. The graph uses basic analysis.'
      : record.language === 'csharp' && record.mode === 'enhanced' && !record.compilerReceiverTypes
        ? 'Compiler calls are available. This indexer does not provide compiler receiver types for all data operations.'
        : undefined,
  }));
  const fallback = analysis.some((record) => record.fallback);
  const Icon = fallback ? DangerTriangle : InfoCircle;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className={`cursor-help ${fallback ? 'text-content-tag-warning' : 'text-content-tertiary'}`}
          aria-label={`Analysis: ${records.map((record) => record.label).join('; ')}`}
        >
          <Icon className="size-4" aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipPrimitive.Portal>
        <TooltipContent side="top" className="max-w-xs border-0 bg-bg-inverted-secondary text-content-inverted text-xs">
          <div className="space-y-2">
            {records.map((record) => (
              <div key={record.label}>
                <p className="font-semibold">{record.label}</p>
                {record.detail && <p>{record.detail}</p>}
              </div>
            ))}
          </div>
        </TooltipContent>
      </TooltipPrimitive.Portal>
    </Tooltip>
  );
}
